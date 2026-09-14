import datetime,hashlib,json,os,re,shutil,subprocess,sys,tempfile,time
from pathlib import Path
ROOT=Path('/Users/cristian/projects/fun/openfon-worktrees/provider-presets')
M=json.loads((ROOT/'.agent/artifacts/profile-create-77c.json').read_text()); SNAP=Path(M['snapshot'])
PTR=Path('/tmp/openfon-presets-create-validation-path')
if not PTR.exists():
    OUT=ROOT/'test-results/profile-create-77c'/('validation-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    OUT.mkdir(parents=True); PTR.write_text(str(OUT)+'\n')
OUT=Path(PTR.read_text().strip()); phase=sys.argv[1]
def write(name,data): (OUT/name).write_text(json.dumps(data,indent=2)+'\n')
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def table():
    rows=[]
    for line in subprocess.check_output(['ps','-axo','pid=,ppid=,comm=,args='],text=True).splitlines():
        a=line.strip().split(None,3)
        if len(a)==4: rows.append({'pid':int(a[0]),'ppid':int(a[1]),'comm':a[2],'args':a[3]})
    return rows
PORTS=[8811,8812,8813,8814,8821,9251,9252,9253,9254]
def scan():
    rows=table(); found=[]
    for r in rows:
        # Executable plus runtime arguments, excluding our inspection/orchestration shell.
        if r['pid']==os.getpid() or Path(r['comm']).name in ['zsh','bash','ps','python3','Python']: continue
        args=r['args']; exe=Path(r['comm']).name.lower()
        relevant=(exe.startswith(('node','workerd','npm','npx','esbuild')) and re.search(r'playwright|wrangler|workerd|vite|vitest|tsc|e2e-server|qa_launch|pr.agent',args)) or ('chrome' in exe and ('playwright_chromiumdev_profile' in args or '--test-type' in args))
        if relevant: found.append({k:r[k] for k in ['pid','ppid','comm']})
    listeners={}
    for port in PORTS:
        p=subprocess.run(['lsof','-nP',f'-iTCP:{port}','-sTCP:LISTEN','-Fpctn'],capture_output=True,text=True)
        if p.stdout.strip(): listeners[str(port)]=p.stdout.strip()
    return {'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'application_processes':found,'reserved_listeners':listeners}
def verify():
    for name,expected in M['sha256'].items(): assert sha(ROOT/name)==expected,(name,'artifact changed')
    assert sha(SNAP/'e2e/profile-create-pending.spec.ts')==M['active_snapshot_sha256']['e2e/profile-create-pending.spec.ts']
    for name,expected in M['planned_validation']['companion_sha256'].items(): assert sha(SNAP/name)==expected,name
before=scan(); write(phase+'-before-scan.json',before)
assert not before['application_processes'] and not before['reserved_listeners'],before
verify()
if not (SNAP/'node_modules').exists(): (SNAP/'node_modules').symlink_to((ROOT/'node_modules').resolve(),target_is_directory=True)
assert Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome').is_file()
state_before={str(x) for x in Path(tempfile.gettempdir()).glob('openfon-e2e-*')}
if phase=='original':
    assert sha(SNAP/'web/src/pages/Settings.tsx')==M['active_snapshot_sha256']['web/src/pages/Settings.tsx']
    shutil.copy2(ROOT/'.agent/artifacts/profile-create-77c/original-Settings.tsx.txt',SNAP/'web/src/pages/Settings.tsx')
    cmd=['npx','--no-install','playwright','test','e2e/profile-create-pending.spec.ts']
elif phase=='fixed':
    assert sha(SNAP/'web/src/pages/Settings.tsx')==M['active_snapshot_sha256']['web/src/pages/Settings.tsx']
    titles=[x['title'] for x in M['case_plan']]+[title for names in M['planned_validation']['bounded_existing_companions'].values() for title in names]
    cmd=['npx','--no-install','playwright','test','e2e/profile-create-pending.spec.ts',*M['planned_validation']['bounded_existing_companions'].keys(),'--grep','(?:'+'|'.join(re.escape(t) for t in titles)+')$']
elif phase=='types': cmd=['npm','run','typecheck']
else: raise ValueError(phase)
if phase!='types': cmd+=['--workers=1','--retries=0','--output='+str(OUT/(phase+'-browser-results')),'--reporter=line,json']
env=os.environ.copy(); env.update(OPENFON_E2E_PORT='8812',OPENFON_E2E_INSPECTOR_PORT='9252',PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',PLAYWRIGHT_JSON_OUTPUT_FILE=str(OUT/(phase+'-report.json')),PW_TEST_HTML_REPORT_OPEN='never')
write(phase+'-launch.json',{'command':cmd,'cwd':str(SNAP),'environment':{k:env[k] for k in ['OPENFON_E2E_PORT','OPENFON_E2E_INSPECTOR_PORT','PLAYWRIGHT_CHROMIUM_EXECUTABLE']},'source_sha256':sha(SNAP/'web/src/pages/Settings.tsx'),'fixture_sha256':sha(SNAP/'e2e/profile-create-pending.spec.ts'),'temp_before':sorted(state_before),'dependency_snapshot':str((SNAP/'node_modules').resolve())})
observed={}; started=time.monotonic(); rc=None
try:
    with (OUT/(phase+'.log')).open('w') as log:
        proc=subprocess.Popen(cmd,cwd=SNAP,env=env,stdout=log,stderr=subprocess.STDOUT)
        print(json.dumps({'phase':phase,'pid':proc.pid,'output':str(OUT)}),flush=True)
        while True:
            rows=table(); owned={proc.pid,*observed.keys()}
            changed=True
            while changed:
                changed=False
                for row in rows:
                    if row['ppid'] in owned and row['pid'] not in owned: owned.add(row['pid']); changed=True
            for row in rows:
                if row['pid'] in owned: observed[row['pid']]={k:row[k] for k in ['pid','ppid','comm']}
            rc=proc.poll()
            if rc is not None: break
            time.sleep(.75)
finally:
    after=scan(); write(phase+'-after-scan.json',after)
    remaining=[r for r in table() if r['pid'] in observed]
    receipt={'exit':rc,'duration_seconds':round(time.monotonic()-started,3),'observed_processes':list(observed.values()),'observed_remaining':[{k:r[k] for k in ['pid','ppid','comm']} for r in remaining],'temp_new_remaining':sorted({str(x) for x in Path(tempfile.gettempdir()).glob('openfon-e2e-*')}-state_before),'scan':after}
    write(phase+'-exit.json',receipt)
    if not after['application_processes'] and not after['reserved_listeners'] and rc is not None:
        if phase=='original': shutil.copy2(ROOT/'.agent/artifacts/profile-create-77c/fixed-Settings.tsx.txt',SNAP/'web/src/pages/Settings.tsx')
        receipt['fixed_restored_sha256']=sha(SNAP/'web/src/pages/Settings.tsx'); write(phase+'-exit.json',receipt)
    else: raise RuntimeError('Fresh exit/vacancy required before fixed restoration or next phase')
verify()
assert sha(SNAP/'web/src/pages/Settings.tsx')==M['active_snapshot_sha256']['web/src/pages/Settings.tsx']
print(json.dumps({'phase':phase,'exit':rc,'seconds':receipt['duration_seconds'],'remaining':receipt['observed_remaining'],'temp_new_remaining':receipt['temp_new_remaining']}),flush=True)
