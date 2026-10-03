import {test} from 'node:test';
import assert from 'node:assert/strict';
import {llm, initializeLogger} from '@livekit/agents';
import {realtime} from '@livekit/agents-plugin-openai';
import {appendTypedInput} from '../src/typed-input.js';
import {TranscriptBridge, type ProviderTranscript} from '../src/transcript-bridge.js';

test('installed GPT-Live adapter retains command IDs and repeats with separate IDs without a second user insertion',async()=>{
  initializeLogger({pretty:false,level:'error'});
  const appended:llm.ChatItem[]=[];
  const commentary:string[]=[];
  class CaptureSession extends realtime.GPTLiveSession {
    override async _appendItems(items:llm.ChatItem[]):Promise<void>{appended.push(...items);await super._appendItems(items);}
    override appendCommentary(text:string):void{commentary.push(text);}
  }
  class CaptureModel extends realtime.GPTLiveModel {
    override session(){return new CaptureSession(this);}
  }
  // Configuration never starts: closing releases the SDK only after it is stopped.
  const model=new CaptureModel({apiKey:'synthetic',baseURL:'http://127.0.0.1:1/v1'});
  const adapted=new llm.DuplexRealtimeAdapter(model).session();
  const target={updateChatCtx:(context:llm.ChatContext)=>adapted.updateChatCtx(context)};
  const persisted:ProviderTranscript[]=[];
  const bridge=new TranscriptBridge(async item=>{persisted.push(item);},async()=>{});
  try{
    for(const id of ['typed_first','typed_repeat']){
      const live=adapted.chatCtx.copy();
      live.insert(new llm.ChatMessage({id:'speech_'+id,role:'assistant',content:['A live reply']}));
      live.insert(new llm.FunctionCall({id:'tool_'+id,callId:'call_'+id,name:'synthetic',args:'{}'}));
      await adapted.updateChatCtx(live);
      const command={id,text:'Please call tomorrow.'};
      await bridge.record({...command,role:'caller',final:true});
      await appendTypedInput(target,adapted.chatCtx,command);
      // Worker uses bare generateReply; the provider reads the just-appended item.
      adapted.duplexSession._generateReply();
      const item=adapted.chatCtx.getById(id)!;
      assert.equal(item.type,'message');
      if(item.type==='message')await bridge.record({id:item.id,text:item.textContent,role:'caller',final:true});
    }
    await bridge.flush();
    assert.deepEqual(appended.map(item=>item.id),['speech_typed_first','tool_typed_first','typed_first','speech_typed_repeat','tool_typed_repeat','typed_repeat']);
    assert.deepEqual(adapted.chatCtx.items.map(item=>item.id),appended.map(item=>item.id));
    assert.deepEqual(persisted.map(item=>item.sourceItemId),['typed_first','typed_repeat']);
    assert.equal(commentary.length,2);
    for(const text of commentary)assert.ok(text.endsWith('Please call tomorrow.'));
    await appendTypedInput(target,adapted.chatCtx,{id:'typed_first',text:'Please call tomorrow.'});
    assert.equal(appended.length,6);
    await assert.rejects(appendTypedInput(target,adapted.chatCtx,{id:'typed_first',text:'Changed'}),/identity changed/);
  }finally{await adapted.close();await model.close();}
});

test('typed context failures propagate before reply generation',async()=>{
  await assert.rejects(appendTypedInput({updateChatCtx:async()=>{throw Error('append failed');}},llm.ChatContext.empty(),
    {id:'typed_failed',text:'Please call.'}),/append failed/);
});
