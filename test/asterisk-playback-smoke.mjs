#!/usr/bin/env node
/** Actual workerd timers/WebSocket events; isolated adapter, synthetic PCM/PBX.
 * No production test endpoints, schema, AI provider or PSTN traffic.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const root=fileURLToPath(new URL('../',import.meta.url));
const bundle=await build({stdin:{resolveDir:root,loader:'ts',contents:`
import { AsteriskMediaAdapter } from './src/asterisk-media';
export default {fetch(){
  const pair=new WebSocketPair(), socket=pair[1];socket.accept();let frames=0;
  const adapter=new AsteriskMediaAdapter({carrierSend:data=>{if(data instanceof ArrayBuffer)frames++;socket.send(data);},sessionSend:data=>{socket.send(JSON.stringify({probe:'session',message:JSON.parse(data)}));},onEnd:reason=>{socket.send(JSON.stringify({probe:'ended',reason}));socket.close(1000,'finished');}});
  adapter.carrierMessage(JSON.stringify({event:'MEDIA_START',connection_id:'fixture',channel:'fixture',format:'ulaw',optimal_frame_size:160,ptime:20}));
  adapter.sessionMessage(JSON.stringify({type:'ready',mode:'realtime',greeting:''}));
  socket.addEventListener('message',event=>{
    const msg=JSON.parse(event.data);
    if(msg.probe==='maxEnding'){adapter.carrierMessage(JSON.stringify({event:'MEDIA_XOFF'}));adapter.sessionMessage(new ArrayBuffer(480000));adapter.sessionMessage(JSON.stringify({type:'ending'}));socket.send(JSON.stringify({probe:'maxQueued',frames}));}
    else if(msg.probe==='load'){adapter.sessionMessage(new ArrayBuffer(480000));socket.send(JSON.stringify({probe:'loaded',frames}));}
    else if(msg.event==='MEDIA_XOFF'){adapter.carrierMessage(event.data);socket.send(JSON.stringify({probe:'paused',frames}));}
    else if(msg.probe==='flush'){adapter.sessionMessage(JSON.stringify({type:'flush'}));socket.send(JSON.stringify({probe:'flushed',frames}));}
    else if(msg.probe==='finish'){adapter.sessionMessage(new ArrayBuffer(960));adapter.sessionMessage(JSON.stringify({type:'ending',id:'00000000-0000-4000-8000-000000000001'}));socket.send(JSON.stringify({probe:'finishQueued',frames}));}
    else adapter.carrierMessage(event.data);
  });
  socket.addEventListener('close',()=>adapter.close());
  return new Response(null,{status:101,webSocket:pair[0]});
}};
`},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});
let mf,socket;
const wait=async(fn,label)=>{const until=Date.now()+10000;while(Date.now()<until){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('timeout: '+label);};
try{
  mf=new Miniflare(convertV4MiniflareOptions({cf:false,port:Number(process.env.OPENFON_TEST_PORT||8811),inspectorPort:Number(process.env.OPENFON_INSPECTOR_PORT||9251),workers:[{name:'playback',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-01',outboundService:()=>{throw Error('External requests forbidden');}}]}));
  await mf.ready;
  const response=await mf.dispatchFetch('http://local.test/media',{headers:{Upgrade:'websocket'}});assert.equal(response.status,101);
  socket=response.webSocket;socket.accept();socket.binaryType='arraybuffer';
  let frames=0,ack=false;const messages=[];
  const send=value=>socket.send(JSON.stringify(value));
  socket.addEventListener('message',event=>{
    if(typeof event.data!=='string'){frames++;if(frames===1)send({event:'MEDIA_XOFF'});return;}
    const msg=JSON.parse(event.data);messages.push(msg);
    if(ack && msg.command==='MARK_MEDIA')send({event:'MEDIA_MARK_PROCESSED',correlation_id:msg.correlation_id});
  });
  send({probe:'load'});
  const loaded=await wait(()=>messages.find(x=>x.probe==='loaded'),'provider frame queued');assert.equal(loaded.frames,0,'no synchronous media writes for 480000-byte frame');
  const paused=await wait(()=>messages.find(x=>x.probe==='paused'),'XOFF delivered through WebSocket');
  assert.ok(paused.frames>0 && paused.frames<500,'XOFF intercepted incremental playback');
  await new Promise(r=>setTimeout(r,150));assert.equal(frames,paused.frames,'no media while XOFF');
  send({probe:'flush'});const flushed=await wait(()=>messages.find(x=>x.probe==='flushed'),'flush');
  await new Promise(r=>setTimeout(r,150));assert.equal(frames,flushed.frames,'flush cancels old scheduled output');
  ack=true;send({probe:'finish'});
  await wait(()=>messages.find(x=>x.probe==='finishQueued'),'new PCM and ending queued after flush');
  await new Promise(r=>setTimeout(r,300));assert.equal(frames,flushed.frames,'flush and new PCM must not override XOFF');
  send({event:'MEDIA_XON'});
  const ended=await wait(()=>messages.find(x=>x.probe==='ended'),'final marks/drain');assert.equal(ended.reason,'playback_complete');
  assert.ok(messages.some(x=>x.command==='HANGUP'));
  assert.deepEqual(messages.filter(x=>x.probe==='session' && x.message.type.startsWith('playback_')).map(x=>x.message),[{type:'playback_complete',id:'00000000-0000-4000-8000-000000000001'}]);
  const tailResponse=await mf.dispatchFetch('http://local.test/media',{headers:{Upgrade:'websocket'}});
  assert.equal(tailResponse.status,101);socket=tailResponse.webSocket;socket.accept();socket.binaryType='arraybuffer';
  const tailMessages=[];let tailFrames=0;
  socket.addEventListener('message',event=>{if(typeof event.data!=='string')tailFrames++;else tailMessages.push(JSON.parse(event.data));});
  send({probe:'maxEnding'});await wait(()=>tailMessages.find(x=>x.probe==='maxQueued'),'maximum frame and ending queued under XOFF');
  await new Promise(r=>setTimeout(r,300));assert.equal(tailFrames,0);assert.ok(!tailMessages.some(x=>x.probe==='ended'),'full queue tail must wait rather than overflow');
  send({event:'MEDIA_XON'});await wait(()=>tailFrames===500,'maximum payload pumped without acknowledgements');
  await new Promise(r=>setTimeout(r,100));assert.equal(tailFrames,500);assert.ok(!tailMessages.some(x=>x.probe==='ended'));
  const tailMarks=tailMessages.filter(x=>x.command==='MARK_MEDIA');assert.equal(tailMarks.length,500);
  for(const mark of tailMarks.slice(0,2))send({event:'MEDIA_MARK_PROCESSED',correlation_id:mark.correlation_id});
  await wait(()=>tailFrames===501,'FIR tail emitted after capacity freed');
  for(const mark of tailMarks.slice(2))send({event:'MEDIA_MARK_PROCESSED',correlation_id:mark.correlation_id});
  await new Promise(r=>setTimeout(r,100));assert.ok(!tailMessages.some(x=>x.probe==='ended'),'final tail mark still gates completion');
  send({event:'MEDIA_MARK_PROCESSED',correlation_id:tailMessages.filter(x=>x.command==='MARK_MEDIA').at(-1).correlation_id});
  assert.equal((await wait(()=>tailMessages.find(x=>x.probe==='ended'),'maximum frame tail drained')).reason,'playback_complete');
  console.log(`PASS workerd incremental playback: maximum frame writes 0 synchronously; XOFF paused at ${paused.frames}/500 frames; flush/new PCM/ending remain blocked until XON; final marks drain and cleanup; full500-frame XOFF queue defers FIR tail until marks free capacity and completes501 total frames. Synthetic PCM/PBX only.`);
}finally{try{socket?.close();}catch{}await mf?.dispose();}
