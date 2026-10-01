import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReadableStream} from 'node:stream/web';
import {llm,voice} from '@livekit/agents';
import {TranscriptBridge,type ProviderTranscript} from '../src/transcript-bridge.js';
import {observeGeneration} from '../src/stream-transcripts.js';
import {modelOptions,acceptedEcho} from '../src/config.js';
import {createCallerAudioSubscription} from '../src/caller-audio.js';
import {within} from '../src/deadline.js';
const stream=<T>(...items:T[])=>new ReadableStream<T>({start(controller){items.forEach(item=>controller.enqueue(item));controller.close();}});
test('caller partial revisions and SDK final reconcile to one identity; duplicate final ignored',async()=>{
 const saved:ProviderTranscript[]=[];const anchors:string[]=[];
 const bridge=new TranscriptBridge(async item=>{saved.push(item);},async id=>{anchors.push(id);});
 await bridge.record({id:'speech_a',role:'caller',text:'Please',final:false});
 await bridge.record({id:'speech_a',role:'caller',text:'Please call me',final:false});
 await bridge.record({id:'speech_a',role:'caller',text:'Please call me',final:true});
 await bridge.record({id:'speech_a',role:'caller',text:'Please call me',final:true});
 await bridge.flush();assert.deepEqual(saved.map(x=>[x.sourceItemId,x.revision,x.final]),[['speech_a',0,false],['speech_a',1,false],['speech_a',2,true]]);assert.deepEqual(anchors,['speech_a']);
});
test('assistant partials observe genuine SDK ID without consuming audio or inventing finality',async()=>{
 const audio=stream();const timed=voice.createTimedString({text:' world',startTime:0.1});
 const message:llm.MessageGeneration={messageId:'sdk_item_7',textStream:stream<string|voice.TimedString>('Hello',timed),audioStream:audio};
 const event:llm.GenerationCreatedEvent={messageStream:stream(message),functionStream:stream(),userInitiated:false};
 const seen:unknown[]=[];observeGeneration(event,(id,text)=>seen.push([id,text]));
 const observed=await event.messageStream.getReader().read();assert.equal(observed.value!.audioStream,audio);
 const chunks=[];for await(const chunk of observed.value!.textStream)chunks.push(chunk);
 assert.deepEqual(chunks,['Hello',timed]);assert.deepEqual(seen,[['sdk_item_7','Hello'],['sdk_item_7','Hello world']]);
});
test('persistence failure remains visible at flush and cannot produce final evidence',async()=>{
 const bridge=new TranscriptBridge(async()=>{throw new Error('unavailable');},async()=>{assert.fail('must not authorize final');});
 await assert.rejects(bridge.record({id:'x',role:'caller',text:'callback',final:true}));await assert.rejects(bridge.flush());
});
test('caller subscription excludes other participants and non-microphone tracks; stops late subscriptions',()=>{
 const changes:boolean[]=[];const mic={source:2,setSubscribed:(v:boolean)=>changes.push(v)};
 const helper=createCallerAudioSubscription('trusted',2,()=>{});
 helper.subscribe(mic,{identity:'other'});helper.subscribe({...mic,source:1},{identity:'trusted'});assert.equal(changes.length,0);
 helper.subscribe(mic,{identity:'trusted'});helper.subscribe(mic,{identity:'trusted'});helper.stop();helper.subscribe({...mic},{identity:'trusted'});assert.deepEqual(changes,[true,false]);
});
test('managed routing uses exact duplex/delegation and rejects unsupported voice',()=>{
 const context={voice:'marin',instructions:'Business facts'} as Parameters<typeof modelOptions>[0];
 const options=modelOptions(context,'synthetic');assert.equal(options.model,'gpt-live-1');assert.equal(options.responsesOptions.model,'gpt-5.4-mini');assert.equal(options.responsesOptions.maxOutputTokens,512);
 assert.throws(()=>modelOptions({...context,voice:'azure-voice'},'synthetic'));
 const echo={model:'gpt-live-1',audio:{format:{type:'audio/pcm',rate:24000},output:{voice:'marin'}},delegation:{responses:{model:'gpt-5.4-mini'}}};assert.equal(acceptedEcho(echo,'marin'),true);assert.equal(acceptedEcho(echo,'cedar'),false);assert.equal(acceptedEcho({...echo,model:'gpt-realtime-2'},'marin'),false);
});
test('shutdown waits are bounded without claiming underlying promise cancellation',async()=>{
 await assert.rejects(within(new Promise(()=>{}),10),/deadline/);assert.equal(await within(Promise.resolve(7),10),7);
});
test('application token verifies with the installed LiveKit SDK and matches microphone grant encoding',async()=>{
 const {TokenVerifier,AccessToken}=await import('livekit-server-sdk');
 const {TrackSource}=await import('@livekit/protocol');
 const {createLivekitRoom}=await import('../../src/livekit.js');
 const environment={LIVEKIT_URL:'ws://127.0.0.1:7880',LIVEKIT_API_KEY:'fixture-key',LIVEKIT_API_SECRET:'fixture-secret',LIVEKIT_AGENT_SERVICE_TOKEN:'fixture-service'} as any;
 const grant={roomJoin:true,room:'room',canPublish:true,canPublishSources:[TrackSource.MICROPHONE],canPublishData:false,canSubscribe:true,canUpdateOwnMetadata:false};
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');
 let token:string;
 try{token=(await createLivekitRoom(environment,{room:'room',caller:'caller',callId:'call'} as any)).participantToken;}finally{globalThis.fetch=originalFetch;}
 const verified=await new TokenVerifier('fixture-key','fixture-secret').verify(token);
 const reference=new AccessToken('fixture-key','fixture-secret',{identity:'caller'});reference.addGrant(grant);
 const referenceClaims=await new TokenVerifier('fixture-key','fixture-secret').verify(await reference.toJwt());
 assert.deepEqual(verified.video,referenceClaims.video);assert.equal(verified.sub,'caller');
});
