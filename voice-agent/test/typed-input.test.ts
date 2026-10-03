import {test} from 'node:test';
import assert from 'node:assert/strict';
import {llm, voice, initializeLogger} from '@livekit/agents';
import {AudioFrame} from '@livekit/rtc-node';
import {ReadableStream, type ReadableStreamDefaultController} from 'node:stream/web';
import {PendingTypedInput,submitTypedInput} from '../src/typed-input.js';
import {TranscriptBridge, type ProviderTranscript} from '../src/transcript-bridge.js';
import {FarewellPair} from '../src/farewell.js';
import {ToolClosure} from '../src/tool-closure.js';

class QueuedModel extends llm.DuplexModel {
  active!:QueuedSession;
  constructor(){super({userTranscription:true,autoToolReplyGeneration:true});}
  session(){return this.active=new QueuedSession(this);}
  audioGate(){return new llm.FixedGate(0.001,{minSilenceDuration:100});}
  async close(){}
}
class QueuedSession extends llm.DuplexSession {
  controller!:ReadableStreamDefaultController<llm.DuplexAudioFrame>;
  audioStream=new ReadableStream<llm.DuplexAudioFrame>({start:controller=>{this.controller=controller;}});
  tools=llm.ToolContext.empty();
  history=llm.ChatContext.empty();
  asks:Array<{id:string;text:string}>=[];
  async _updateInstructions(){}
  async _appendItems(items:llm.ChatItem[]){this.history.insert(items);}
  async _updateTools(tools:llm.ToolContext){this.tools=tools;}
  _updateOptions(){}
  pushAudio(){}
  _generateReply(){
    const item=this.history.items.at(-1);
    this.asks.push({id:item?.id??'',text:item?.type==='message'?item.textContent:''});
  }
  finishReply(text='Synthetic reply.'){
    this.emit('transcript_delta',{text});
    for(const level of [1000,1000,0,0,0])this.controller.enqueue({frame:new AudioFrame(new Int16Array(2400).fill(level),24000,1,2400)});
  }
  protected async closeConnection(){this.controller.close();}
}
async function waitFor(check:()=>boolean,label:string){
  const deadline=Date.now()+3000;
  while(!check()){if(Date.now()>deadline)throw Error('Timed out '+label);await new Promise(resolve=>setTimeout(resolve,10));}
}

test('real AgentSession queues typed inputs with one SDK transcript each and preserves repeated text',async()=>{
  initializeLogger({pretty:false,level:'error'});
  const model=new QueuedModel();
  const session=new voice.AgentSession({llm:model,vad:null,aecWarmupDuration:null});
  const agent=new voice.Agent({instructions:'Synthetic test'});
  const persisted:ProviderTranscript[]=[];
  const bridge=new TranscriptBridge(async item=>{persisted.push(item);},async()=>{});
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded,event=>{
    if(event.item.type==='message'&&event.item.role==='user')void bridge.record({id:event.item.id,text:event.item.textContent,role:'caller',final:true});
  });
  await session.start({agent});
  try{
    const first=submitTypedInput(session,{id:'command_1',text:'First request'});
    await waitFor(()=>model.active.asks.length===1,'first scheduled ask');
    const second=submitTypedInput(session,{id:'command_2',text:'Repeated request'});
    const third=submitTypedInput(session,{id:'command_3',text:'Repeated request'});
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(model.active.asks.length,1,'later requests wait behind active speech');
    model.active.finishReply();
    await first.waitForPlayout();
    await waitFor(()=>model.active.asks.length===2,'second scheduled ask');
    model.active.finishReply();
    await second.waitForPlayout();
    await waitFor(()=>model.active.asks.length===3,'third scheduled ask');
    model.active.finishReply();
    await third.waitForPlayout();
    await bridge.flush();
    assert.deepEqual(model.active.asks.map(item=>item.text),['First request','Repeated request','Repeated request']);
    assert.equal(new Set(model.active.asks.map(item=>item.id)).size,3);
    assert.deepEqual(persisted.map(item=>item.sourceItemId),model.active.asks.map(item=>item.id));
    assert.equal(persisted.length,3);
  }finally{await session.close();await model.close();}
});

test('pending typed admission cancels goodbye without counting a second final caller turn',()=>{
  let closes=0;let stillCurrent=()=>false;const pair=new FarewellPair(current=>{closes++;stillCurrent=current;});
  pair.record('assistant','greeting','Hello',true);
  pair.record('caller','command','Goodbye',false);
  pair.record('assistant','early','Goodbye',true);
  assert.equal(closes,0);
  pair.record('caller','sdk-item','Goodbye',true);
  pair.record('assistant','final','Goodbye',true);
  assert.equal(closes,1);
  assert.equal(stillCurrent(),true);
  pair.record('caller','next-command','Please wait',false);
  assert.equal(stillCurrent(),false);
});

for(const mode of ['paired','tool'] as const)test(`queued SDK goodbye cannot close over newer admitted input (${mode})`,async()=>{
  initializeLogger({pretty:false,level:'error'});
  const model=new QueuedModel();
  const session=new voice.AgentSession({llm:model,vad:null,aecWarmupDuration:null});
  const pending=new PendingTypedInput();const tools=new ToolClosure();
  let stopped=false,closed=0,requests=0;
  const closures:Promise<void>[]=[];
  const close=()=>{stopped=true;closed++;pending.close();};
  const pair=new FarewellPair(current=>{
    if(mode!=='paired')return;
    requests++;
    closures.push((async()=>{if(await pending.waitUntilIdle()&&!stopped&&current())close();})());
  });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded,event=>{
    const item=event.item;
    if(item.type!=='message'||!['user','assistant'].includes(item.role))return;
    if(item.role==='user')tools.observe(item.id,item.textContent,true);
    pair.record(item.role==='user'?'caller':'assistant',item.id,item.textContent,true);
    if(mode==='tool'&&item.role==='user'&&item.textContent==='Goodbye'){
      // Model/tool-side close request occurs only after SDK authorizes this item.
      // As in execute(), return immediately; never await the owning handle here.
      const ticket=tools.begin()!;requests++;
      closures.push(new Promise<void>(resolve=>setTimeout(()=>{
        void(async()=>{try{if(await pending.waitUntilIdle()&&!stopped&&tools.current(ticket))close();}
          finally{tools.release(ticket);resolve();}})();
      },0)));
    }
  });
  const submit=(id:string,text:string)=>{
    pending.admit(id);tools.observe(id,text,true);pair.record('caller',id,text,false);
    const handle=submitTypedInput(session,{id,text});
    pending.track(id,handle,()=>assert.fail('unexpected handle rejection'));
    return handle;
  };
  await session.start({agent:new voice.Agent({instructions:'Synthetic queue test'})});
  try{
    const opening=submit('opening','Opening request');
    await waitFor(()=>model.active.asks.length===1,'opening request');
    const oldGoodbye=submit('old-goodbye','Goodbye');
    const followup=submit('followup','Actually, please call tomorrow');
    model.active.finishReply('Hello');await opening.waitForPlayout();
    await waitFor(()=>model.active.asks.length===2,'old goodbye authorization');
    model.active.finishReply('Goodbye');await oldGoodbye.waitForPlayout();
    await waitFor(()=>model.active.asks.length===3,'followup authorization');
    assert.equal(closed,0,'newer queued request blocks an older goodbye');
    model.active.finishReply('I will pass that message on.');await followup.waitForPlayout();
    await Promise.all(closures);
    assert.equal(closed,0,'old close stays invalid after newer turn finishes');
    assert.ok(requests>=1,'the old close was actually requested');
    const final=submit('final-goodbye','Goodbye');
    await waitFor(()=>model.active.asks.length===4,'final goodbye authorization');
    assert.equal(closed,0,'final goodbye waits for its own handle');
    model.active.finishReply('Goodbye');await final.waitForPlayout();
    await Promise.all(closures);
    assert.equal(closed,1,'a legitimate last goodbye is not suppressed or deadlocked');
  }finally{pending.close();await session.close();await model.close();}
});

test('shutdown releases pending typed-close waits without closing a conversation',async()=>{
  const pending=new PendingTypedInput();pending.admit('waiting');
  const waiting=pending.waitUntilIdle();pending.close();
  assert.equal(await waiting,false);assert.equal(pending.idle,false);
});
