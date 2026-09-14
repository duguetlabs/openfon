from pathlib import Path
import sys
# Reuse only orchestration definitions, never its phase runner branch.
sys.argv=['finalize','cleanup']
exec(Path('/tmp/openfon-state-load-validation.py').read_text().split("if phase=='original':")[0])
receipts={}
for label in ['original-api','original-browser','fixed-api','fixed-activation-controls','worker-types','web-types','fixed-browser']:
 receipts[label]=json.loads((OUT/(label+'-exit.json')).read_text());assert receipts[label]['exit'] is not None
before=vacant('cleanup-before'); observed={r['pid']:r for v in receipts.values() for r in v['observed_processes']};remaining=[{k:r[k] for k in ['pid','ppid','comm']} for r in table() if r['pid'] in observed];assert not remaining,remaining
initial=json.loads((OUT/'initial-provenance.json').read_text());owned_temps=sorted({x for r in receipts.values() for x in r['temp_new_remaining']});assert not set(owned_temps)&set(initial['temp_before'])
write('cleanup-before-temp-removal.json',{'utc':now(),'observed_process_count':len(observed),'observed_remaining':remaining,'owned_temp_paths':owned_temps,'existing_owned_temps':[p for p in owned_temps if Path(p).exists()],'scan':before})
for path in owned_temps:
 p=Path(path);assert p.parent==Path(tempfile.gettempdir()) and p.name.startswith('openfon-e2e-');shutil.rmtree(p,ignore_errors=False) if p.exists() else None
source=verify('fixed')
link=SNAP/'node_modules';removed_link=False
if initial['added_dependency_symlink']:
 assert link.is_symlink() and link.resolve()==(ROOT/'node_modules').resolve();link.unlink();removed_link=True
final=vacant('cleanup-final');release={'utc':now(),'slot':'Explicit sole8812/9252 RELEASE; all seven authorized commands exited, no active owned runner','observed_process_count':len(observed),'observed_remaining':remaining,'scan':final,'removed_owned_temps':owned_temps,'owned_temps_remaining':[p for p in owned_temps if Path(p).exists()],'removed_added_dependency_symlink':removed_link,'preserved_dependency':str((ROOT/'node_modules').resolve()),'retained_exact_source_snapshot':str(SNAP),'source_sha256':source,'limits':'750ms process-tree sampling is not exhaustive for short-lived descendants; global application/official/test Chrome and reserved-port scan complements sampled absence'};write('cleanup-release.json',release)
print(json.dumps(release,indent=2))
