import {test} from 'node:test';
import assert from 'node:assert/strict';
import {voice,initializeLogger} from '@livekit/agents';
initializeLogger({pretty:false,level:'silent'});
import {watchClosureInterruption} from '../src/tool-closure.js';
for(const mode of ['abort','interrupted-done','already-aborted','normal'] as const)test(`SDK closure ownership reconciles ${mode} exactly once`,async()=>{
 const controller=new AbortController();const speech=voice.SpeechHandle.create({allowInterruptions:true});let releases=0;
 if(mode==='already-aborted')controller.abort();
 watchClosureInterruption(controller.signal,speech,()=>releases++);
 if(mode==='abort')controller.abort();
 if(mode==='interrupted-done')speech.interrupt();
 speech._markDone();await Promise.resolve();await Promise.resolve();
 assert.equal(releases,mode==='normal'?0:1);
 controller.abort();speech._markDone();await Promise.resolve();assert.equal(releases,mode==='normal'?0:1);
});
