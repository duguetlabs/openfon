import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IdleInputClock} from '../src/input-clock.js';
import {ToolClosure} from '../src/tool-closure.js';

test('microphone-denied session gets paced silent input; active microphone frames are forwarded once',()=>{
  let now=0;const sent:Array<{samplesPerChannel:number;kind:string}>=[];
  const clock=new IdleInputClock(frame=>sent.push(frame),()=>({samplesPerChannel:2400,kind:'silence'}),()=>assert.fail('unexpected error'),()=>now);
  clock.start();assert.equal(sent.length,1);
  now=99;clock.tick();assert.equal(sent.length,1);
  now=100;clock.tick();assert.equal(sent.length,2);
  const mic={samplesPerChannel:480,kind:'real'};
  for(let i=0;i<25;i++){now+=20;clock.push(mic);clock.tick();}
  assert.equal(sent.filter(frame=>frame.kind==='silence').length,2);
  assert.equal(sent.filter(frame=>frame===mic).length,25);
  now+=199;clock.tick();assert.equal(sent.length,27);
  now+=1;clock.tick();assert.equal(sent.at(-1)?.kind,'silence');
  clock.stop();now+=1000;clock.tick();clock.push(mic);clock.start();assert.equal(sent.length,28);
});

test('idle clock cannot burst after scheduling delay or continue after delivery failure',()=>{
  let now=0,count=0,errors=0;
  const clock=new IdleInputClock(()=>{if(++count===3)throw Error('closed');},()=>({samplesPerChannel:2400}),()=>errors++,()=>now);
  clock.start();now=5000;clock.tick();clock.tick();assert.equal(count,2);
  now=5100;clock.tick();assert.equal(errors,1);now=5200;clock.tick();assert.equal(count,3);
  clock.stop();
});

test('new speech while tool goodbye plays invalidates closure and permits a later request',async()=>{
  const closure=new ToolClosure();closure.observe('first','Goodbye',true);
  const first=closure.begin()!;assert.equal(closure.begin(),undefined);
  let complete!:()=>void;let disconnected=false;
  const playout=new Promise<void>(resolve=>{complete=resolve;});
  const closing=(async()=>{await playout;if(closure.current(first))disconnected=true;closure.release(first);})();
  closure.observe('second','Actually',false);
  assert.equal(closure.current(first),false);
  const replacement=closure.begin()!;assert.ok(replacement);
  complete();await closing;assert.equal(disconnected,false);assert.equal(closure.current(replacement),true);
  closure.release(replacement);
});

test('typed input cancels tool closure while identical final reconciliation does not',()=>{
  const closure=new ToolClosure();closure.observe('speech','Goodbye',false);
  const first=closure.begin()!;closure.observe('speech','Goodbye',true);assert.equal(closure.current(first),true);
  closure.observe('speech','Goodbye',true);assert.equal(closure.current(first),true);
  closure.observe('typed_1','Please also call tomorrow',true);assert.equal(closure.current(first),false);
  const next=closure.begin()!;assert.ok(next);closure.release(first);assert.equal(closure.current(next),true);
});

test('installed GPT-Live SDK receives real zero PCM without mic and each real PCM frame once',async()=>{
  const {realtime}=await import('@livekit/agents-plugin-openai');
  const {initializeLogger}=await import('@livekit/agents');
  const {AudioFrame}=await import('@livekit/rtc-node');
  const {ClockedGPTLiveSession}=await import('../src/clocked-session.js');
  initializeLogger({pretty:false,level:'error'});
  const events:Array<Record<string,unknown>>=[];
  class CaptureSession extends ClockedGPTLiveSession {
    override sendEvent(event:Parameters<InstanceType<typeof realtime.GPTLiveSession>['sendEvent']>[0]):void{events.push(event);}
  }
  // Never release SDK configuration: close releases it only after setting the closing flag.
  const model=new realtime.GPTLiveModel({apiKey:'synthetic',baseURL:'http://127.0.0.1:1/v1'});
  const session=new CaptureSession(model,()=>assert.fail('unexpected SDK error'));
  try{
    session.startInputClock();
    assert.equal(events.length,1);assert.equal(events[0]!.type,'session.input_audio.append');
    const zero=Buffer.from(events[0]!.audio as string,'base64');assert.equal(zero.length,4800);assert.equal(zero.some(value=>value!==0),false);
    session.pushAudio(new AudioFrame(new Int16Array(2400).fill(17),24000,1,2400));
    assert.equal(events.length,2);const real=Buffer.from(events[1]!.audio as string,'base64');assert.equal(real.length,4800);assert.equal(real.readInt16LE(0),17);
  }finally{await session.close();await model.close();}
  await new Promise(resolve=>setTimeout(resolve,120));assert.equal(events.length,2);
});


test('readiness acknowledgement uses authenticated call scope and rejects admission loss',async()=>{
 const {ControlClient,AdmissionError}=await import('../src/control.js');
 const fetchBefore=globalThis.fetch;const requests:Array<{url:string;body:Record<string,unknown>}> = [];
 globalThis.fetch=async(url,init)=>{requests.push({url:String(url),body:JSON.parse(String(init?.body))});return new Response('{}',{status:requests.length===1?200:410});};
 try{
  const control=new ControlClient('http://127.0.0.1:1','fixture-service','call','room','job');
  await control.post('events',{callback:'fixture-capability',type:'ready'});
  assert.deepEqual(requests[0],{url:'http://127.0.0.1:1/api/internal/livekit/calls/call/events',body:{callback:'fixture-capability',type:'ready',room:'room',jobId:'job'}});
  await assert.rejects(control.post('events',{callback:'fixture-capability',type:'ready'}),error=>error instanceof AdmissionError&&error.status===410);
 }finally{globalThis.fetch=fetchBefore;}
});
