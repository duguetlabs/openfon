import datetime,hashlib,json,os,re,shutil,subprocess,sys,tempfile,time
from pathlib import Path
ROOT=Path('/Users/cristian/projects/fun/openfon-worktrees/provider-presets'); M=json.loads((ROOT/'.agent/artifacts/activation-settings-1d4.json').read_text()); SNAP=Path(M['snapshot']); OUT=Path(Path('/tmp/openfon-presets-state-load-validation-path').read_text().strip()); phase=sys.argv[1]
def write(name,data): (OUT/name).write_text(json.dumps(data,indent=2)+'\n')
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def table():
 rows=[]
 for line in subprocess.check_output(['ps','-axo','pid=,ppid=,args='],text=True).splitlines():
  a=line.strip().split(None,2)
  if len(a)==3: rows.append({'pid':int(a[0]),'ppid':int(a[1]),'comm':a[2].split(' ',1)[0],'args':a[2]})
 return rows
PORTS=[*range(8810,8820),8821,*range(9250,9257)]
def scan():
 found=[]; unrelated=[]
 for r in table():
  if r['pid']==os.getpid() or Path(r['comm']).name in ['zsh','bash','ps','python3','Python']: continue
  args=r['args']; exe=Path(r['comm']).name.lower()
  if '/linkedin-mcp/.venv/' in args or r['pid']==54328:
   unrelated.append({k:r[k] for k in ['pid','ppid','comm']});continue
  relevant=(exe.startswith(('node','workerd','npm','npx','esbuild')) and re.search(r'playwright|wrangler|workerd|vite|vitest|tsc|e2e-server|qa_launch|pr.agent',args)) or (args.startswith('/Applications/Google Chrome.app/') and ('playwright_chromiumdev_profile' in args or '--test-type' in args))
  if relevant:found.append({k:r[k] for k in ['pid','ppid','comm']})
 listeners={}
 for port in PORTS:
  p=subprocess.run(['lsof','-nP',f'-iTCP:{port}','-sTCP:LISTEN','-Fpctn'],capture_output=True,text=True)
  if p.stdout.strip():listeners[str(port)]=p.stdout.strip()
 return {'utc':now(),'application_processes':found,'reserved_listeners':listeners,'known_unrelated_preserved':unrelated}
def vacant(label):
 s=scan();write(label+'-scan.json',s);assert not s['application_processes'] and not s['reserved_listeners'],s;return s
def verify(mode):
 for p,h in M['artifact_sha256'].items():assert sha(ROOT/p)==h,p
 assert sha(ROOT/M['patch']['path'])==M['patch']['sha256']
 for group in ['protected_source_sha256','companion_sha256']:
  for p,h in M[group].items():assert sha(SNAP/p)==h,p
 for p,v in M['new_fixtures'].items():assert sha(SNAP/p)==v['sha256'],p
 for p,h in M[mode+'_source_sha256'].items():assert sha(SNAP/p)==h,p
 return {p:sha(SNAP/p) for p in [*M['fixed_source_sha256'],*M['new_fixtures']]}
def temps():return {str(x) for x in Path(tempfile.gettempdir()).glob('openfon-e2e-*')}
ENV=os.environ.copy(); ENV.update(OPENFON_E2E_PORT='8812',OPENFON_E2E_INSPECTOR_PORT='9252',PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',PW_TEST_HTML_REPORT_OPEN='never')
def run(label,cmd,mode,browser=False):
 assert not (OUT/(label+'-launch.json')).exists(),('do not replay',label)
 vacant(label+'-before'); source=verify(mode); state_before=temps(); env=ENV.copy()
 if browser:env['PLAYWRIGHT_JSON_OUTPUT_FILE']=str(OUT/(label+'-report.json'))
 write(label+'-launch.json',{'utc':now(),'command':cmd,'cwd':str(SNAP),'source_sha256':source,'temp_before':sorted(state_before),'dependency_snapshot':str((SNAP/'node_modules').resolve()),'environment':{k:env[k] for k in ['OPENFON_E2E_PORT','OPENFON_E2E_INSPECTOR_PORT','PLAYWRIGHT_CHROMIUM_EXECUTABLE']}})
 observed={};start=time.monotonic()
 with (OUT/(label+'.log')).open('w') as log:
  proc=subprocess.Popen(cmd,cwd=SNAP,env=env,stdout=log,stderr=subprocess.STDOUT); print(json.dumps({'launched':label,'pid':proc.pid}),flush=True)
  while True:
   rows=table(); owned={proc.pid,*observed.keys()};changed=True
   while changed:
    changed=False
    for r in rows:
     if r['ppid'] in owned and r['pid'] not in owned:owned.add(r['pid']);changed=True
   for r in rows:
    if r['pid'] in owned:observed[r['pid']]={k:r[k] for k in ['pid','ppid','comm']}
   rc=proc.poll()
   if rc is not None:break
   time.sleep(.75)
 after=scan(); remaining=[{k:r[k] for k in ['pid','ppid','comm']} for r in table() if r['pid'] in observed]
 receipt={'utc':now(),'exit':rc,'duration_seconds':round(time.monotonic()-start,3),'observed_processes':list(observed.values()),'observed_remaining':remaining,'temp_new_remaining':sorted(temps()-state_before),'scan':after,'source_after':verify(mode)};write(label+'-exit.json',receipt)
 print(json.dumps({'completed':label,'exit':rc,'seconds':receipt['duration_seconds'],'remaining':remaining,'temps':receipt['temp_new_remaining']}),flush=True)
 assert not after['application_processes'] and not after['reserved_listeners'] and not remaining,'Runner not vacant'
 return receipt
def browser_cmd(label,companion=False):
 cmd=['npx','--no-install','playwright','test','e2e/settings-load-error.spec.ts']
 if companion:
  cmd+=['e2e/settings-save-recovery.spec.ts','--grep','(?:'+ '|'.join(re.escape(x['title']) for x in M['prepared_cases']['browser'])+'|a failed second settings read retains refresh-only recovery)$']
 return cmd+['--workers=1','--retries=0','--output='+str(OUT/(label+'-results')),'--reporter=line,json']
if phase=='original':
 vacant('prelaunch');verify('fixed');assert Path(ENV['PLAYWRIGHT_CHROMIUM_EXECUTABLE']).is_file()
 linked=not (SNAP/'node_modules').exists()
 if linked:(SNAP/'node_modules').symlink_to((ROOT/'node_modules').resolve(),target_is_directory=True)
 write('initial-provenance.json',{'utc':now(),'source':verify('fixed'),'temp_before':sorted(temps()),'added_dependency_symlink':linked,'base':M['base'],'qa':'073511b','grant':'integration ACTIVE sole1d4 presets bounded validation grant'})
 for path,name in [('src/studio-api.ts','studio-api'),('web/src/pages/Settings.tsx','Settings')]:shutil.copy2(ROOT/f'.agent/artifacts/activation-settings-1d4/original-{name}.txt',SNAP/path)
 try:
  run('original-api',['npx','--no-install','vitest','run','test/activation-state.test.ts','--reporter=verbose'], 'original')
  run('original-browser',browser_cmd('original-browser'),'original',True)
 finally:
  s=vacant('original-phase-final');verify('original')
  for path,name in [('src/studio-api.ts','studio-api'),('web/src/pages/Settings.tsx','Settings')]:shutil.copy2(ROOT/f'.agent/artifacts/activation-settings-1d4/fixed-{name}.txt',SNAP/path)
  write('fixed-restoration.json',{'utc':now(),'vacancy':s,'source':verify('fixed')})
elif phase=='fixed':
 assert (OUT/'fixed-restoration.json').exists()
 run('fixed-api',['npx','--no-install','vitest','run','test/activation-state.test.ts','--reporter=verbose'],'fixed')
 run('fixed-activation-controls',['npx','--no-install','vitest','run','test/provider-activation-instance.test.ts','-t',M['proposed_validation_not_granted']['existing_API_title_pattern'],'--reporter=verbose'],'fixed')
 run('worker-types',['npx','--no-install','tsc','--noEmit','-p','tsconfig.worker.json'],'fixed')
 run('web-types',['npx','--no-install','tsc','--noEmit','-p','web/tsconfig.json'],'fixed')
 run('fixed-browser',browser_cmd('fixed-browser',True),'fixed',True)
else:raise ValueError(phase)
print(json.dumps({'phase_complete':phase,'utc':now()}),flush=True)
