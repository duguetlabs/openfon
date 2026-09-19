#!/usr/bin/env node
/** Synthetic PBX + real local workerd/D1/DO; all provider requests intercepted. */
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { runAsteriskRuntime } from './asterisk-runtime.mjs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { unstable_splitSqlQuery } from 'wrangler';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(resolve(tmpdir(),'openfon-asterisk-smoke-'));
let mf,carrier;
let allowReady=true, releaseReady;
const telemetry=[];
const wait=async(predicate,label,timeout=15000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await predicate())return;await new Promise(r=>setTimeout(r,25));}throw Error(`Timed out: ${label}`);};
const mockScript = `
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.hostname === 'realtime.smoke.invalid' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    await env.RECORD.fetch('https://telemetry.smoke.invalid/ready-gate');
    const pair = new WebSocketPair(); const socket = pair[1]; socket.accept();
    let responded = false;
    const tone=new Uint8Array(4800); const view=new DataView(tone.buffer);
    for(let i=0;i<2400;i++) view.setInt16(i*2,Math.round(8000*Math.sin(2*Math.PI*440*i/24000)),true);
    const audio=btoa(String.fromCharCode(...tone));
    const send = value => socket.send(JSON.stringify(value));
    socket.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'session.update') send({type:'session.updated',session:msg.session});
      if (msg.type === 'response.create') setTimeout(() => {
        send({type:'response.output_audio.delta',delta:audio});
        send({type:'response.output_audio_transcript.done',transcript:'Synthetic greeting.'});
        send({type:'response.done'});
      }, 30);
      if (msg.type === 'input_audio_buffer.append' && !responded) {
        const nonSilent=[...atob(msg.audio)].some(x=>x.charCodeAt(0)!==0);
        if (${process.argv.includes('--asterisk')} && !nonSilent) return;
        responded = true;
        const bytes = atob(msg.audio).length;
        env.RECORD.fetch('https://telemetry.smoke.invalid/input', {method:'POST',body:JSON.stringify({bytes,nonSilent})});
        // After greeting guard expires, emit barge-in then a short goodbye.
        setTimeout(() => {
          send({type:'input_audio_buffer.speech_started'});
          send({type:'conversation.item.input_audio_transcription.completed',transcript:'Goodbye'});
          send({type:'response.output_audio.delta',delta:audio});
          send({type:'response.output_audio_transcript.done',transcript:'Goodbye.'});
          send({type:'response.function_call_arguments.done',name:'end_call',arguments:'{}'});
          send({type:'response.done'});
        }, 800);
      }
    });
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  if (url.hostname === 'llm.smoke.invalid' && url.pathname === '/v1/chat/completions') {
    return Response.json({choices:[{message:{content:JSON.stringify({summary:'Synthetic call completed.',intent:'other'})}}]});
  }
  await env.RECORD.fetch('https://telemetry.smoke.invalid/unexpected',{method:'POST',body:JSON.stringify({host:url.hostname,path:url.pathname})});
  return new Response('Unexpected outbound request blocked',{status:502});
}};
`;
try {
  const bundle=await build({stdin:{resolveDir:root,loader:'ts',contents:`
import worker from './src/index';
import { observeAsteriskRateWrites } from './scripts/asterisk-smoke-db.mjs';
export * from './src/index';
export default {...worker,async fetch(request,env,ctx){
  // Test-only per-request instrumentation: no D1 audit table or public changes.
  const observer=observeAsteriskRateWrites(env.DB);
  const response=await worker.fetch(request,{...env,DB:observer.DB},ctx);
  if(response.status===101)return response;
  const headers=new Headers(response.headers);headers.set('X-Openfon-Test-Rate-Writes',String(observer.attempts));
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}};
`},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false,external:['cloudflare:*']});
  mf=new Miniflare(convertV4MiniflareOptions({port:Number(process.env.OPENFON_TEST_PORT || 8811), inspectorPort:Number(process.env.OPENFON_INSPECTOR_PORT || 9251), defaultPersistRoot:temp,cf:false,workers:[
    {name:'openfon',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-01',
     d1Databases:{DB:'smoke-db'},durableObjects:{CALL_SESSION:{className:'CallSession',useSQLite:true},ASTERISK_CALL:{className:'AsteriskCall',useSQLite:true}},
     outboundService:'mock-provider',bindings:{ASTERISK_ENABLED:'true',
       DEFAULT_LLM_BASE_URL:'https://llm.smoke.invalid/v1',DEFAULT_LLM_MODEL:'synthetic',DEFAULT_LLM_API_KEY:'synthetic-test-only',
       DEFAULT_TTS_PROVIDER:'browser',DEFAULT_TTS_VOICE:'en-US-AvaMultilingualNeural',
       REALTIME_BASE_URL:'wss://realtime.smoke.invalid/v1/realtime',REALTIME_MODEL:'gpt-realtime-2',REALTIME_API_KEY:'synthetic-test-only'}},
    {name:'mock-provider',modules:true,script:mockScript,compatibilityDate:'2026-05-01',outboundService:async()=>new Response('Network disabled',{status:502}),
     serviceBindings:{RECORD:async request=>{if(new URL(request.url).pathname==='/ready-gate'){if(!allowReady)await new Promise(resolve=>{releaseReady=resolve;});return Response.json({ok:true});}telemetry.push({path:new URL(request.url).pathname,body:await request.json()});return Response.json({ok:true});}}}
  ]}));
  await mf.ready;
  const db=await mf.getD1Database('DB','openfon');
  for(const name of (await readdir(resolve(root,'migrations'))).filter(x=>x.endsWith('.sql')).sort()) {
    await db.batch(unstable_splitSqlQuery(await readFile(resolve(root,'migrations',name),'utf8')).map(sql=>db.prepare(sql)));
  }
  const password='synthetic-only-asterisk-password-32-bytes';
  const hash=execFileSync(process.execPath,[resolve(root,'scripts/asterisk-credential.mjs')],{input:password,encoding:'utf8'}).trim();
  await db.batch([
    db.prepare("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused')"),
    db.prepare("INSERT INTO businesses(id,user_id,slug,name,max_concurrent_calls) VALUES('business','owner','smoke','Synthetic business',1)"),
    db.prepare("INSERT INTO provider_settings(business_id,llm_base_url) VALUES('business','')"),
    db.prepare("INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language,engine,realtime_model) VALUES('assistant','business','smoke-agent','active','Alex','Helpful receptionist','en','realtime','gpt-realtime-2')"),
    db.prepare("INSERT INTO asterisk_routes(id,business_id,assistant_id,password_sha256,enabled,password_hash) VALUES('pbx','business','assistant',lower(hex(randomblob(32))),1,?)").bind(hash),
  ]);
  if (process.argv.includes('--asterisk')) {
    await runAsteriskRuntime({temp,db,telemetry,wait,password});
  } else {
  const authorization='Basic '+Buffer.from('pbx:'+password).toString('base64');
  const upgrade=async(call,auth=authorization)=>mf.dispatchFetch('https://openfon.smoke.invalid/ws/asterisk/pbx?call='+call,{headers:{Upgrade:'websocket',Authorization:auth,'Sec-WebSocket-Protocol':'media'}});
  assert.equal((await upgrade('bad','Basic '+Buffer.from('pbx:'+'x'.repeat(32)).toString('base64'))).status,401);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM calls').first()).n,0);
  for(const scenario of ['invalid-start','start-timeout']){
    const bad=await upgrade(scenario);assert.equal(bad.status,101);const pbx=bad.webSocket;pbx.accept();
    const before=await db.prepare("SELECT id,status,connected_at FROM calls WHERE status='active'").first();
    assert.equal(before.connected_at,null,'bridge creation is not a connection');
    assert.equal((await upgrade(scenario+'-capacity')).status,403,'unready reservation still occupies capacity');
    if(scenario==='invalid-start')pbx.send(JSON.stringify({event:'MEDIA_START',format:'slin16',optimal_frame_size:640,ptime:20}));
    await wait(async()=>{const row=await db.prepare('SELECT status,carrier_released_at FROM calls WHERE id=?').bind(before.id).first();return row.status==='failed' && row.carrier_released_at;},scenario+' immediate failure/release',25000);
    const after=await db.prepare('SELECT status,outcome,connected_at,failure_code FROM calls WHERE id=?').bind(before.id).first();
    assert.equal(after.connected_at,null);assert.equal(after.outcome,'failed');assert.ok(after.failure_code);
    try{pbx.close();}catch{}
  }
  allowReady=false;
  const response=await upgrade('first');assert.equal(response.status,101);carrier=response.webSocket;carrier.accept();carrier.binaryType='arraybuffer';
  assert.equal((await upgrade('first')).status,403,'known-full workspace rejects duplicate before owner contact');
  assert.equal((await upgrade('second')).status,403,'concurrent call cap');
  const received=[];
  carrier.addEventListener('message',event=>{
    if(typeof event.data!=='string'){received.push({audio:event.data});return;}
    const msg=JSON.parse(event.data);received.push(msg);
    assert.ok(['ANSWER','HANGUP','MARK_MEDIA','FLUSH_MEDIA'].includes(msg.command));
    if(msg.command==='MARK_MEDIA')carrier.send(JSON.stringify({event:'MEDIA_MARK_PROCESSED',correlation_id:msg.correlation_id}));
  });
  assert.equal((await db.prepare("SELECT connected_at FROM calls WHERE status='active'").first()).connected_at,null);
  carrier.send(JSON.stringify({event:'MEDIA_START',connection_id:'simulated',channel:'WebSocket/simulated',channel_id:'first',format:'ulaw',optimal_frame_size:160,ptime:20}));
  await wait(()=>typeof releaseReady==='function','provider readiness held');
  assert.equal((await db.prepare("SELECT connected_at FROM calls WHERE status='active'").first()).connected_at,null,'valid MEDIA_START alone is not ready');
  allowReady=true;releaseReady();
  await wait(()=>received.some(x=>x.audio),'greeting audio');
  await wait(async()=>Boolean((await db.prepare("SELECT connected_at FROM calls WHERE status='active'").first())?.connected_at),'actual session ready marks connection');
  carrier.send(new Uint8Array(160).fill(255));
  await wait(()=>telemetry.some(x=>x.path==='/input'),'input PCM');
  assert.equal(telemetry.find(x=>x.path==='/input').body.bytes,960);
  await wait(()=>received.some(x=>x.command==='FLUSH_MEDIA'),'interruption');
  await wait(()=>received.some(x=>x.command==='HANGUP'),'playback drain/hangup');
  await wait(async()=>{const row=await db.prepare("SELECT status,carrier_released_at FROM calls WHERE channel='asterisk' AND connected_at IS NOT NULL").first();return row?.carrier_released_at && row.status!=='active';},'call finalization');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM calls WHERE channel='asterisk'").first()).n,3);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM calls WHERE connected_at IS NOT NULL").first()).n,1,'only ready call contributes to connected metrics');
  assert.equal(telemetry.filter(x=>x.path==='/unexpected').length,0);
  assert.equal((await upgrade('first')).status,409,'completed channel cannot replay');
  await db.prepare("UPDATE asterisk_routes SET enabled=0").run();assert.equal((await upgrade('disabled')).status,401);
  console.log('PASS Asterisk synthetic workerd smoke: invalid MEDIA_START/start timeout fail without connection, reserved capacity, delayed session-ready metrics, auth, duplicate rejection, admission limit, greeting PCM, inbound conversion, flush, marks/drain, hangup, D1 finalization, disabled route. No real PBX/provider/PSTN.');
  }
} finally {try{carrier?.close();}catch{}await mf?.dispose();await rm(temp,{recursive:true,force:true});}
