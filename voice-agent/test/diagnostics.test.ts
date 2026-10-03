import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VoiceDiagnostics} from '../src/diagnostics.js';
import {smokeTarget,safeControlEvent} from '../scripts/smoke-evidence.mjs';

test('diagnostics emit only bounded fixed names and counts, never payloads',()=>{
  const records:Array<Record<string,unknown>>=[];let now=0;
  const diagnostic=new VoiceDiagnostics('call_123',record=>records.push(record),()=>now);
  diagnostic.phase('startup');diagnostic.phase('startup');
  diagnostic.count({type:'session.output_audio.delta',audio:'private-audio',token:'private-key'});
  diagnostic.count('private-key');
  diagnostic.phase('private-transcript' as 'startup');
  for(let i=0;i<1000005;i++)diagnostic.count('session.output_audio.delta');
  diagnostic.count('session.commentary.append');diagnostic.count('session.commentary.appended');
  now=4000000;for(let i=0;i<20;i++)diagnostic.snapshot();
  diagnostic.snapshot(true);diagnostic.snapshot(true);diagnostic.phase('readiness_ack');
  assert.equal(records.length,14,'one phase, twelve periodic snapshots, one final snapshot');
  const last=records.at(-1)!;
  assert.equal(last.elapsedMs,3600000);
  assert.deepEqual(last.phases,{startup:2});
  assert.deepEqual(last.counts,{'session.output_audio.delta':1000000,'session.commentary.append':1,'session.commentary.appended':1});
  assert.equal(JSON.stringify(records).includes('private-'),false);
  assert.throws(()=>new VoiceDiagnostics('not/an/id',()=>{}),/Invalid diagnostic call/);
});

test('smoke environment flags choose only fixed hosts and require paid permission',()=>{
  assert.deepEqual(smokeTarget(['--stage-ready','--allow-paid']),{environment:'staging',origin:'https://openfon-staging.duguetlabs.workers.dev',signaling:'wss://voice-staging.openfon.ai'});
  assert.deepEqual(smokeTarget(['--production-ready','--allow-paid']),{environment:'production',origin:'https://openfon.ai',signaling:'wss://voice.openfon.ai'});
  for(const args of [[],['--stage-ready'],['--production-ready'],['--allow-paid'],['--stage-ready','--production-ready','--allow-paid']])assert.throws(()=>smokeTarget(args));
  assert.deepEqual(safeControlEvent({type:'ready',participantToken:'private-token',text:'private-text'},18.4),{type:'ready',elapsedMs:18});
  assert.equal(safeControlEvent({type:'private-token'},5),undefined);
});
