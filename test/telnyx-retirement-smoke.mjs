#!/usr/bin/env node
/** Local SQLite-backed workerd storage check; no external requests or real calls.
 * Run: node test/telnyx-retirement-smoke.mjs
 * Test-only routes below are bundled here, never exported by the application.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const root = fileURLToPath(new URL('../', import.meta.url));
const persist = await mkdtemp(resolve(tmpdir(), 'openfon-retirement-'));
const bundle = await build({ stdin: {resolveDir:root, loader:'ts', contents:`
import { TelnyxCall } from './src/telnyx-control';
import { CallSession } from './src/call-session';
export class Probe extends TelnyxCall {
  constructor(ctx, env) {
    const DB = { prepare(sql) {
      // Terminal reconciliation only. Any attempted admission is a test failure.
      if (!sql.startsWith('UPDATE')) throw new Error('Unexpected admission');
      return {bind() {return {async run() {return {meta:{changes:0}};}};}};
    }};
    super(ctx, {...env, DB, TELNYX_ENABLED:'true'}); this.ctx = ctx;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/snapshot') return Response.json({entries:[...await this.ctx.storage.list()],alarm:await this.ctx.storage.getAlarm()});
    if (path === '/expire') {
      const s = await this.ctx.storage.get('control');
      if (!s?.terminal) return new Response('not terminal',{status:409});
      s.cleanupAt=Date.now()-1;
      await this.ctx.storage.put('control',s);
      await super.alarm();
      return new Response(null,{status:204});
    }
    return super.fetch(request);
  }
}
export class FailureProbe extends TelnyxCall {
  constructor(ctx, env) { super(ctx,env); this.ctx=ctx; }
  async fetch(request) {
    const id=new URL(request.url).searchParams.get('id');
    if (new URL(request.url).pathname === '/seed-failure') {
      await this.ctx.storage.put('control', {callId:id,call:{},inbox:[],seen:[],admitted:true,
        initiationSeen:true,answered:true,streamStarted:true,ending:true,terminal:true,
        reason:'carrier_stream_failed',cleanupAt:Date.now()+35*60_000,mediaClaimed:false,commands:{}});
      await this.alarm(); return new Response(null,{status:204});
    }
    return Response.json({alarm:await this.ctx.storage.getAlarm(),control:await this.ctx.storage.get('control')});
  }
}
export class SessionProbe extends CallSession {
  async fetch(request) {
    this.callId=new URL(request.url).searchParams.get('id');
    this.history=[{role:'system',content:''}];
    this.summarized={summary:'Saved conversation',intent:'question',messageJson:'{"message":"Call back"}'};
    await this.finalize(); return new Response(null,{status:204});
  }
}
export default {async fetch(request,env) {
  const url=new URL(request.url), id=url.searchParams.get('id');
  if (url.pathname === '/init-db') {
    await env.DB.exec("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY,business_id TEXT,assistant_id TEXT,channel TEXT,status TEXT,outcome TEXT,failure_code TEXT,failure_message TEXT,started_at TEXT,connected_at TEXT,ended_at TEXT,carrier_released_at TEXT,duration_s INTEGER,summary TEXT,intent TEXT,message_json TEXT)");
    return new Response(null,{status:204});
  }
  if (url.pathname === '/seed-call') {
    await env.DB.prepare("INSERT INTO calls(id,business_id,channel,status,started_at,connected_at,carrier_released_at) VALUES (?,'biz','telnyx','active',datetime('now'),datetime('now'),datetime('now'))").bind(id).run();
    return new Response(null,{status:204});
  }
  if (url.pathname === '/row') return Response.json(await env.DB.prepare('SELECT * FROM calls WHERE id=?').bind(id).first());
  if (url.pathname === '/finalize') return env.SESSION.get(env.SESSION.idFromName(id)).fetch(request);
  if (url.pathname === '/seed-failure' || url.pathname === '/failure-state') return env.FAILURE.get(env.FAILURE.idFromName(id)).fetch(request);
  return env.PROBE.get(env.PROBE.idFromName('retirement')).fetch(request);
}};
`}, bundle:true, format:'esm', platform:'browser', target:'es2022', write:false });
const options = () => ({...convertV4MiniflareOptions({cf:false,
  port:Number(process.env.OPENFON_TEST_PORT || 8810), inspectorPort:Number(process.env.OPENFON_INSPECTOR_PORT || 9250),
  workers:[{name:'retirement-test',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-01',
    d1Databases:{DB:'finalization-db'},durableObjects:{PROBE:{className:'Probe',useSQLite:true},FAILURE:{className:'FailureProbe',useSQLite:true},SESSION:{className:'SessionProbe',useSQLite:true}},outboundService:()=>{throw new Error('No external requests allowed');}}]}),resourcePersistencePath:persist});
let mf;
const event = type => ({id:crypto.randomUUID(),type,callId:'tnx_'+'a'.repeat(64),call:{callControlId:'synthetic-control',callLegId:'synthetic-leg',callSessionId:'synthetic-session',connectionId:'synthetic-connection'},from:'+12025550100',to:'+12025550101'});
const post = (path, body) => mf.dispatchFetch('http://local.test'+path,{method:'POST',...(body?{body:JSON.stringify(body)}:{})});
const snapshot = async () => (await mf.dispatchFetch('http://local.test/snapshot')).json();
try {
  mf = new Miniflare(options()); await mf.ready;
  assert.equal((await post('/events',event('call.hangup'))).status,204);
  for (let i=0;i<100;i++) {
    if ((await snapshot()).entries.some(([key,s])=>key==='control'&&s.terminal)) break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  const terminal = await snapshot();
  const control = terminal.entries.find(([key]) => key === 'control')?.[1];
  assert.ok(control?.terminal);
  assert.equal(terminal.alarm, control.cleanupAt, 'idle terminal owner must sleep until actual cleanup');
  assert.equal((await post('/expire')).status,204);
  assert.deepEqual(await snapshot(),{entries:[['retired',true]],alarm:null});
  await mf.dispose();
  mf = new Miniflare(options()); await mf.ready;
  assert.deepEqual(await snapshot(),{entries:[['retired',true]],alarm:null});
  for (const type of ['call.initiated','call.answered','call.hangup']) assert.equal((await post('/events',event(type))).status,204);
  assert.equal((await mf.dispatchFetch('http://local.test/media',{headers:{Upgrade:'websocket','x-telnyx-streaming-auth-token':'a'.repeat(64)}})).status,403);
  assert.equal((await post('/reconcile')).status,204);
  assert.deepEqual(await snapshot(),{entries:[['retired',true]],alarm:null});
  assert.equal((await post('/init-db')).status,204);
  for (const order of ['carrier-first','session-first']) {
    const id='tnx_'+(order==='carrier-first'?'b':'c').repeat(64);
    assert.equal((await post('/seed-call?id='+id)).status,204);
    if (order==='session-first') assert.equal((await post('/finalize?id='+id)).status,204);
    assert.equal((await post('/seed-failure?id='+id)).status,204);
    // Evict both owners and reopen the same actual D1/SQLite storage before
    // the late finalizer, reproducing the idle terminal owner's durable state.
    await mf.dispose(); mf=new Miniflare(options()); await mf.ready;
    if (order==='carrier-first') assert.equal((await post('/finalize?id='+id)).status,204);
    const row=await (await mf.dispatchFetch('http://local.test/row?id='+id)).json();
    assert.equal(row.status,'failed',order+' status'); assert.equal(row.outcome,'failed');
    assert.equal(row.failure_code,'carrier_stream_failed');
    assert.equal(row.failure_message,'The telephone audio connection failed. Please review the call and retry.');
    assert.equal(row.summary,'Saved conversation'); assert.equal(row.message_json,'{"message":"Call back"}');
    assert.ok(row.ended_at); assert.ok(row.carrier_released_at);
    const state=await (await mf.dispatchFetch('http://local.test/failure-state?id='+id)).json();
    assert.equal(state.alarm,state.control.cleanupAt);
  }
  console.log('PASS actual D1 finalization: both carrier/session write orders preserve failure and conversation after runtime restart, without terminal polling.');
  console.log('PASS SQLite workerd retirement: atomic marker/control/alarm compaction, persisted restart, late events/media/reconcile inert. Synthetic only.');
} finally {
  await mf?.dispose();
  await rm(persist,{recursive:true,force:true});
}
