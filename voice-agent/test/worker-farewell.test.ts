import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {AudioFrame} from '@livekit/rtc-node';
import {voice,initializeLogger} from '@livekit/agents';
import worker from '../src/worker.js';
import {MiniModel, MiniSession, miniSessionConfig} from '../src/mini-model.js';
import {ControlClient} from '../src/control.js';
import {UsageOutbox} from '../src/usage-outbox.js';

initializeLogger({pretty:false,level:'silent'});
const context={callId:'synthetic',room:'room',caller:'caller',callback:'synthetic',instructions:'Dental practice',greeting:'Hello',language:'en',voice:'marin',voiceModel:'gpt-realtime-2.1-mini'};
const wait=async(check:()=>boolean)=>{for(let n=0;n<300;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('Synthetic SDK wait exceeded');};
class Socket extends EventEmitter {
  readyState=1;bufferedAmount=0;sent:any[]=[];
  send(value:string){this.sent.push(JSON.parse(value));}
  terminate(){}
  message(value:unknown){this.emit('message',Buffer.from(JSON.stringify(value)));}
}

class Sink extends voice.AudioOutput {
  duration=0;
  async captureFrame(frame:AudioFrame){await super.captureFrame(frame);this.duration+=frame.samplesPerChannel/frame.sampleRate;}
  flush(){super.flush();if(this.pendingPlayoutSegments)this.onPlaybackFinished({playbackPosition:this.duration,interrupted:false});this.duration=0;}
  clearBuffer(){super.flush();if(this.pendingPlayoutSegments)this.onPlaybackFinished({playbackPosition:this.duration,interrupted:true});this.duration=0;}
}

for(const outcome of ['completed','interrupted','unavailable','denied','provider-error'] as const)test(`actual worker and SDK own one Mini farewell: ${outcome}`,{timeout:10000},async()=>{
  const saved={...process.env};
  Object.assign(process.env,{OPENFON_API_URL:'https://control.invalid',OPENFON_AGENT_SERVICE_TOKEN:'synthetic',OPENFON_USAGE_DIR:'/synthetic/unused',AZURE_OPENAI_ENDPOINT:'https://synthetic.openai.azure.com',AZURE_OPENAI_API_KEY:'synthetic',AZURE_OPENAI_LIVE_DEPLOYMENT:'gpt-realtime-2.1-mini'});
  const socket=new Socket();let current!:MiniSession;let shutdown!:()=>Promise<void>;let entry:Promise<void>|undefined;
  const events:any[]=[];const replies:any[]=[];const sink=new Sink(24000);
  const failureRecords:any[]=[];
  mock.method(console,'info',(value:string)=>{const record=JSON.parse(value);if(record.event==='openfon_voice_failure')failureRecords.push(record);});
  const originalStart=voice.AgentSession.prototype.start;
  const originalGenerate=voice.AgentSession.prototype.generateReply;
  mock.method(UsageOutbox.prototype,'assertAvailable',async()=>{});
  mock.method(UsageOutbox.prototype,'send',async()=>{});
  mock.method(UsageOutbox.prototype,'flushPersistence',async()=>{});
  mock.method(ControlClient.prototype,'post',async(operation:string,body:unknown)=>{if(operation==='context')return context;events.push(body);return {};});
  mock.method(MiniModel.prototype,'session',function(this:MiniModel){
    current=new MiniSession(new MiniModel({baseURL:'https://synthetic.openai.azure.com/openai/v1',apiKey:'synthetic',context,socketFactory:()=>{queueMicrotask(()=>{socket.emit('open');socket.message({type:'session.updated',session:{...miniSessionConfig(context),id:'sdk-fixture'}});});return socket as never;}}));
    return current;
  });
  mock.method(voice.AgentSession.prototype,'start',function(this:voice.AgentSession,options:Parameters<typeof originalStart>[0]){this.output.audio=sink;return originalStart.call(this,{agent:options.agent});});
  mock.method(voice.AgentSession.prototype,'generateReply',function(this:voice.AgentSession,options:Parameters<typeof originalGenerate>[0]){replies.push(options);return originalGenerate.call(this,options);});
  const room=Object.assign(new EventEmitter(),{name:'room',isConnected:true,remoteParticipants:new Map(),disconnect:async()=>{}});
  const ctx={job:{id:'job',metadata:'{"callId":"synthetic"}',room:{name:'room'}},room,connect:async()=>{},waitForParticipant:async()=>{},addShutdownCallback:(fn:()=>Promise<void>)=>{shutdown=fn;},shutdown:()=>{}};
  const requests=()=>socket.sent.filter(e=>e.type==='response.create');
  const admit=(id:string)=>socket.message({type:'response.created',response:{id,metadata:requests().at(-1).response.metadata}});
  const finish=(id:string,text:string)=>{
    socket.message({type:'response.output_audio_transcript.delta',response_id:id,item_id:id+'-speech',delta:text});
    socket.message({type:'response.output_audio.delta',response_id:id,item_id:id+'-speech',delta:Buffer.alloc(4800,1).toString('base64')});
    socket.message({type:'response.done',response:{id,status:'completed',output:[]}});
  };
  try{
    entry=worker.entry(ctx as never);
    await wait(()=>requests().length===1);admit('greeting');finish('greeting','Hello');await entry;
    if(outcome==='provider-error'){
      socket.message({type:'error',error:{code:'invalid_value',param:'audio_end_ms',message:'private key and transcript'}});
      await wait(()=>events.some(e=>e.type==='finished'));
      assert.equal(events.find(e=>e.type==='finished').failed,true,'same terminal handling');
      assert.equal(failureRecords.length,1,'SDK re-emission must not duplicate the initiating diagnostic');
      assert.equal(failureRecords[0].stage,'mini_terminal');assert.equal(failureRecords[0].code,'invalid_value');assert.equal(failureRecords[0].parameter,'audio_end_ms');
      assert.ok(!JSON.stringify(failureRecords).includes('private'));
      return;
    }
    if(outcome==='denied')mock.method(current,'prepareClosure',()=>undefined);
    // A native response asks to close; the real SDK executes the actual worker tool.
    socket.message({type:'response.created',response:{id:'closure'}});
    socket.message({type:'response.done',response:{id:'closure',status:'completed',output:[{type:'function_call',name:'end_call',call_id:'end-call',arguments:'{}'}]}});
    await wait(()=>socket.sent.some(e=>e.item?.call_id==='end-call'&&e.item.type==='function_call_output'));
    const output=socket.sent.find(e=>e.item?.call_id==='end-call').item.output;
    if(outcome==='denied'){
      assert.match(output,/Finish the pending caller request/);
      await wait(()=>requests().length===2);admit('refusal');finish('refusal','Please finish your request.');
      assert.equal(replies.length,1,'refusal retains the SDK response, with no app goodbye');
      assert.equal(events.some(e=>e.type==='finished'),false);
      return;
    }
    await wait(()=>requests().length>=2);
    assert.match(requests()[1].response.instructions,/one brief polite goodbye/,'first post-tool response is the app farewell');
    assert.equal(output,'','successful tool commits an empty output, not a second SDK reply');
    assert.equal(requests()[1].response.tool_choice,'none');
    assert.equal(current.hasPendingWork,false,'empty SDK tool output reconciles the claimed reservation');
    admit('farewell');
    if(outcome==='completed'){
      finish('farewell','Goodbye.');
      await wait(()=>events.some(e=>e.type==='finished'));
      assert.equal(events.find(e=>e.type==='finished').failed,false);
    }else if(outcome==='interrupted'){
      socket.message({type:'input_audio_buffer.speech_started'});
      socket.message({type:'response.done',response:{id:'farewell',status:'cancelled',output:[]}});
    }else{
      socket.message({type:'response.done',response:{id:'farewell',status:'incomplete',status_details:{reason:'content_filter'},output:[]}});
    }
    await new Promise(r=>setTimeout(r,30));
    assert.equal(requests().length,2,'greeting plus exactly one farewell generation');
    assert.equal(replies.length,2);
    if(outcome!=='completed'){
      assert.equal(events.some(e=>e.type==='finished'),false,'unplayed farewell must not close the call');
      assert.equal(current.hasPendingWork,false,'interruption/failure does not strand a tool reservation');
    }
  }finally{
    await shutdown?.();await entry?.catch(()=>{});mock.restoreAll();process.env=saved;
  }
});
