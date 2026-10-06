import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReadableStream} from 'node:stream/web';
import {AudioFrame} from '@livekit/rtc-node';
import {DebugRecording,observeAudio,observeSpeechBoundaries} from '../src/debug-recording.js';
const frame=()=>new AudioFrame(Int16Array.from([1,-2,3,-4]),24000,1,4);
test('records distinct caller and generated audio with bounded ordered uploads and final seal',async()=>{
  const sent:any[]=[];const recorder=new DebugRecording(async body=>{sent.push(body);});
  recorder.audio('caller',frame());recorder.audio('agent',frame());recorder.event('interrupted');await recorder.finish();
  assert.equal(sent.length,2);assert.equal(sent[0].sequence,0);assert.equal(sent[1].sequence,1);assert.equal(sent[1].complete,true);
  assert.deepEqual(sent[0].records.slice(0,2).map((r:any)=>r.track),['caller','agent']);
  assert.equal(sent[0].records[0].data,Buffer.from(frame().data.buffer).toString('base64'));
  assert.ok(sent.every(b=>Buffer.byteLength(JSON.stringify(b))<48000));
});
test('held upload cannot block audio ingestion; overflow is bounded and marked partial',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);const sent:any[]=[];
  const recorder=new DebugRecording(async body=>{sent.push(body);await gate;});
  const chunk=new AudioFrame(new Int16Array(3000),24000,1,3000);
  for(let i=0;i<500;i++)recorder.audio('caller',chunk);
  assert.ok((recorder as any).bytes<=1024*1024);assert.equal((recorder as any).partial,true);
  await Promise.resolve();assert.equal(sent.length,1);release();await recorder.finish();
  assert.equal(sent.at(-1).complete,true);assert.equal(sent.at(-1).partial,true);
  assert.ok(sent.every((b,i)=>b.sequence===i&&Buffer.byteLength(JSON.stringify(b))<48000));
});
test('failed upload disables recording without throwing into speech or sending false completion',async()=>{
  let sends=0;const recorder=new DebugRecording(async()=>{sends++;throw Error('offline');});
  recorder.audio('agent',frame());await recorder.finish();assert.equal(sends,1);
  assert.doesNotThrow(()=>recorder.audio('caller',frame()));
});
test('unsupported stereo audio is not mislabeled mono',async()=>{
  const sent:any[]=[];const recorder=new DebugRecording(async b=>{sent.push(b);});
  recorder.audio('caller',new AudioFrame(new Int16Array(8),24000,2,4));await recorder.finish();
  assert.equal(sent.at(-1).partial,true);assert.ok(sent.flatMap(b=>b.records).every(r=>r.kind!=='audio'));
});
test('observer preserves frame identity, backpressure, cancellation and ignores observer throws',async()=>{
  let pulls=0,cancelled=false;const source=new ReadableStream<AudioFrame>({pull(c){pulls++;c.enqueue(frame());},cancel(){cancelled=true;}},{highWaterMark:0});
  let observed:AudioFrame|undefined;const wrapped=observeAudio(source,f=>{observed=f;throw Error('recorder');});
  await Promise.resolve();assert.equal(pulls,0);
  const reader=wrapped.getReader(),result=await reader.read();assert.equal(result.value,observed);assert.equal(pulls,1);
  await reader.cancel();assert.equal(cancelled,true);assert.equal(source.locked,false);
});

test('GPT-Live SDK boundary events are captured without their transcript fields',async()=>{
 const sent:any[]=[];const recorder=new DebugRecording(async body=>{sent.push(body);});
 const sdk=new EventEmitter();observeSpeechBoundaries(sdk,recorder);
 sdk.emit('input_speech_started',{transcript:'private sentinel'});sdk.emit('input_speech_stopped',{transcript:'private sentinel'});
 await recorder.finish();assert.deepEqual(sent[0].records.map((r:any)=>r.name),['speech_start','speech_end','stopped']);
 assert.ok(!JSON.stringify(sent).includes('sentinel'));
});
