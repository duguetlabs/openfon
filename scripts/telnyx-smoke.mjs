#!/usr/bin/env node
/** Local-only workerd/D1/WebSocket integration. Run: node scripts/telnyx-smoke.mjs
 * Uses the installed Wrangler toolchain's Miniflare/esbuild dependencies.
 * Every outbound request is intercepted by a local Worker; unknown hosts fail.
 * No deployment configuration, credentials, production database or API override.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { unstable_splitSqlQuery } from 'wrangler';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
// CI's existing command runs both scenarios sequentially on the reserved ports.
if (!process.argv.includes('--native') && !process.argv.includes('--synthesized')) {
  for (const mode of ['--native', '--synthesized']) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(resolve(tmpdir(), 'openfon-telnyx-smoke-'));
const synthesized = process.argv.includes('--synthesized');
const model = synthesized ? 'kataleptic-realtime-hd' : 'gpt-realtime-2';
let releaseSynthesis;
const commands = [];
const telemetry = [];
let mf;
let carrier;
const wait = async (predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(r => setTimeout(r, 25)); }
  console.error('Smoke diagnostics:', {actions:commands.map(x=>x.action),telemetry});
  if(mf) console.error('Call diagnostics:',await (await mf.getD1Database('DB','openfon')).prepare('SELECT status,channel,reserved_at,carrier_released_at FROM calls').all());
  throw new Error(`Timed out: ${label}`);
};
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const key = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
const call = { call_control_id: 'smoke-control', call_leg_id: randomUUID(), call_session_id: randomUUID(), connection_id: 'smoke-connection' };
const mockScript = `
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.hostname === 'westeurope.tts.speech.microsoft.com' && url.pathname === '/cognitiveservices/v1') {
    await env.RECORD.fetch('https://telemetry.smoke.invalid/synthesis', {method:'POST',body:'{}'});
    const tone = new ArrayBuffer(4800); const view = new DataView(tone);
    for (let i=0;i<2400;i++) view.setInt16(i*2,Math.round(8000*Math.sin(2*Math.PI*440*i/24000)),true);
    return new Response(tone);
  }
  if (url.hostname === 'api.telnyx.com') return env.RECORD.fetch(request);
  if (url.hostname === 'realtime.smoke.invalid' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
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
        responded = true;
        const bytes = atob(msg.audio).length;
        env.RECORD.fetch('https://telemetry.smoke.invalid/input', {method:'POST',body:JSON.stringify({bytes})});
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
  const bundle = await build({ entryPoints: [resolve(root, 'src/index.ts')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, external: ['cloudflare:*'] });
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false, port: Number(process.env.OPENFON_TEST_PORT || 8810), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9250), workers: [
    { name: 'openfon', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-01',
      d1Databases: { DB: 'smoke-db' }, durableObjects: { CALL_SESSION: { className:'CallSession',useSQLite:true }, TELNYX_CALL:{className:'TelnyxCall',useSQLite:true} },
      outboundService: 'mock-provider', bindings: {
        TELNYX_ENABLED:'true',TELNYX_API_KEY:'synthetic-test-only',TELNYX_PUBLIC_KEY:key,TELNYX_CONNECTION_ID:call.connection_id,TELNYX_PUBLIC_ORIGIN:'https://openfon.smoke.invalid',
        DEFAULT_LLM_BASE_URL:'https://llm.smoke.invalid/v1',DEFAULT_LLM_MODEL:'synthetic',DEFAULT_LLM_API_KEY:'synthetic-test-only',
        DEFAULT_TTS_PROVIDER:synthesized?'azure':'browser',AZURE_SPEECH_KEY:'synthetic-test-only',AZURE_SPEECH_REGION:'westeurope',DEFAULT_TTS_VOICE:'en-US-AvaMultilingualNeural',
        REALTIME_BASE_URL:'wss://realtime.smoke.invalid/v1/realtime',REALTIME_MODEL:model,REALTIME_API_KEY:'synthetic-test-only',
      },
    },
    { name:'mock-provider',modules:true,script:mockScript,compatibilityDate:'2026-05-01',
      outboundService: async () => new Response('Network disabled',{status:502}),
      serviceBindings:{ RECORD: async request => {
        const url = new URL(request.url); const body = await request.json();
        if(url.hostname==='api.telnyx.com') {
          assert.equal(request.method,'POST');
          assert.equal(request.headers.get('authorization'),'Bearer synthetic-test-only');
          assert.match(url.pathname,/^\/v2\/calls\/smoke-control\/actions\/(answer|streaming_start|hangup)$/);
          commands.push({action:url.pathname.split('/').at(-1),body});
        } else {
          telemetry.push({path:url.pathname,body});
          if (url.pathname === '/synthesis') await new Promise(resolve => { releaseSynthesis = resolve; });
        }
        return Response.json({data:{result:'ok'}});
      }},
    },
  ]}));
  await mf.ready;
  const db = await mf.getD1Database('DB','openfon');
  for(const name of (await readdir(resolve(root,'migrations'))).filter(name=>name.endsWith('.sql')).sort()) {
    const statements = unstable_splitSqlQuery(await readFile(resolve(root,'migrations',name),'utf8'));
    await db.batch(statements.map(sql => db.prepare(sql)));
  }
  await db.batch([
    db.prepare("INSERT INTO users(id,email,password_hash) VALUES('smoke-owner','smoke@example.invalid','unused')"),
    db.prepare("INSERT INTO businesses(id,user_id,slug,name) VALUES('smoke-business','smoke-owner','smoke','Synthetic business')"),
    db.prepare("INSERT INTO provider_settings(business_id,llm_base_url) VALUES('smoke-business','')"),
    db.prepare("INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language,engine,realtime_model) VALUES('smoke-assistant','smoke-business','smoke-agent','active','Alex','Helpful receptionist','en','realtime',?)").bind(model),
    db.prepare("INSERT INTO telnyx_number_routes(connection_id,phone_number,business_id,assistant_id,enabled) VALUES(?, '+12025550101','smoke-business','smoke-assistant',1)").bind(call.connection_id),
  ]);
  const webhook = async (type, id=randomUUID()) => {
    const body=JSON.stringify({data:{id,record_type:'event',event_type:type,occurred_at:new Date().toISOString(),payload:{...call,...(type==='call.hangup'?{hangup_cause:'normal_clearing'}:{}),from:'+12025550100',to:'+12025550101',direction:'incoming'}}});
    const timestamp=String(Math.floor(Date.now()/1000));
    const signature=sign(null,Buffer.from(timestamp+'|'+body),privateKey).toString('base64');
    const response=await mf.dispatchFetch('https://openfon.smoke.invalid/api/telnyx/webhooks',{method:'POST',headers:{'Content-Type':'application/json','telnyx-timestamp':timestamp,'telnyx-signature-ed25519':signature},body});
    assert.equal(response.status,200,`webhook ${type}: ${await response.text()}`);
  };
  const initiatedId=randomUUID();
  await webhook('call.initiated',initiatedId);
  await wait(()=>commands.find(x=>x.action==='answer'),'answer command');
  await webhook('call.initiated',initiatedId);
  await webhook('call.answered');
  const stream=await wait(()=>commands.find(x=>x.action==='streaming_start'),'streaming command');
  assert.equal(stream.body.stream_codec,'PCMU');
  const mediaUrl=stream.body.stream_url.replace(/^wss:/,'https:');
  const rejected=await mf.dispatchFetch(mediaUrl,{headers:{Upgrade:'websocket','x-telnyx-streaming-auth-token':'0'.repeat(64)}});
  assert.equal(rejected.status,403,'reject unauthenticated carrier upgrade');
  const upgrade=await mf.dispatchFetch(mediaUrl,{headers:{Upgrade:'websocket','x-telnyx-streaming-auth-token':stream.body.stream_auth_token}});
  assert.equal(upgrade.status,101,await upgrade.text());
  carrier=upgrade.webSocket; assert.ok(carrier); carrier.accept();
  const received=[];
  carrier.addEventListener('message',event=>{
    const msg=JSON.parse(event.data); received.push(msg);
    assert.ok(['media','mark','clear'].includes(msg.event),'private event leaked to carrier');
    if(msg.event==='media') assert.equal(Buffer.from(msg.media.payload,'base64').length,160);
    if(msg.event==='mark') carrier.send(JSON.stringify({event:'mark',stream_id:'smoke-stream',mark:msg.mark}));
  });
  carrier.send(JSON.stringify({event:'connected',version:'1.0.0',connected:{'x-telnyx-streaming-auth-token':stream.body.stream_auth_token}}));
  carrier.send(JSON.stringify({event:'start',sequence_number:'1',stream_id:'smoke-stream',start:{...call,media_format:{encoding:'PCMU',sample_rate:8000,channels:1}}}));
  if (synthesized) {
    await wait(()=>releaseSynthesis,'greeting synthesis begins');
    carrier.send(JSON.stringify({event:'media',sequence_number:'2',stream_id:'smoke-stream',media:{track:'inbound',chunk:'1',timestamp:'0',payload:Buffer.alloc(160,255).toString('base64')}}));
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(telemetry.filter(x=>x.path==='/input').length,0,'caller input stays gated during pending synthesis');
    assert.equal(received.filter(x=>x.event==='media').length,0,'no response overtakes pending greeting');
    releaseSynthesis();
  }
  await wait(()=>received.some(x=>x.event==='media'),'realtime greeting PCM');
  assert.ok(received.some(x=>x.event==='media' && [...Buffer.from(x.media.payload,'base64')].some(byte=>byte!==255)), 'non-silent tone survives codec');
  if (!synthesized) carrier.send(JSON.stringify({event:'media',sequence_number:'2',stream_id:'smoke-stream',media:{track:'inbound',chunk:'1',timestamp:'0',payload:Buffer.alloc(160,255).toString('base64')}}));
  await wait(()=>telemetry.some(x=>x.path==='/input'),'PCM reaches realtime');
  assert.equal(telemetry.find(x=>x.path==='/input').body.bytes,960);
  await wait(()=>received.some(x=>x.event==='clear'),'barge-in clear');
  await wait(()=>commands.find(x=>x.action==='hangup'),'terminal carrier command');
  const before=await db.prepare("SELECT status,carrier_released_at FROM calls WHERE channel='telnyx'").first();
  assert.equal(before.carrier_released_at,null,'retain reservation until signed carrier confirmation');
  await webhook('call.hangup');
  await wait(async()=>{ const row=await db.prepare("SELECT status,carrier_released_at FROM calls WHERE channel='telnyx'").first(); return row?.carrier_released_at && row.status!=='active'; },'database finalization/release');
  const terminal=await db.prepare("SELECT status,outcome,failure_code,failure_message,ended_at,carrier_released_at FROM calls WHERE channel='telnyx'").first();
  assert.equal(terminal.status,'completed','normal call must complete successfully');
  assert.equal(terminal.outcome,'answered','synthetic normal call must be answered');
  assert.equal(terminal.failure_code,null,'normal call must have no failure code');
  assert.equal(terminal.failure_message,null,'normal call must have no failure message');
  assert.ok(terminal.ended_at,'normal call finalization must be recorded');
  assert.ok(terminal.carrier_released_at,'signed hangup must confirm carrier release');
  const rows=await db.prepare("SELECT COUNT(*) AS n FROM calls WHERE channel='telnyx'").first();
  assert.equal(rows.n,1,'duplicate initiated must not create another call');
  assert.equal(commands.filter(x=>x.action==='answer').length,1);
  assert.equal(telemetry.filter(x=>x.path==='/unexpected').length,0,'all outbound requests matched local mocks');
  console.log(synthesized ? 'Synthesized greeting ordering verified.' : 'Native greeting verified.');
  console.log('PASS Telnyx workerd smoke: signed ingress, idempotent admission, authenticated media, realtime PCM, clear/marks/drain, carrier hangup, completed/error-free D1 state and release. No external requests.');
} finally {
  releaseSynthesis?.();
  try { carrier?.close(); } catch {}
  await mf?.dispose();
  await rm(temp,{recursive:true,force:true});
}
