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
export default {fetch(request,env) {return env.PROBE.get(env.PROBE.idFromName('retirement')).fetch(request);}};
`}, bundle:true, format:'esm', platform:'browser', target:'es2022', write:false });
const options = () => ({...convertV4MiniflareOptions({cf:false,
  port:Number(process.env.OPENFON_TEST_PORT || 8810), inspectorPort:Number(process.env.OPENFON_INSPECTOR_PORT || 9250),
  workers:[{name:'retirement-test',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-01',
    durableObjects:{PROBE:{className:'Probe',useSQLite:true}},outboundService:()=>{throw new Error('No external requests allowed');}}]}),resourcePersistencePath:persist});
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
  assert.equal((await post('/expire')).status,204);
  assert.deepEqual(await snapshot(),{entries:[['retired',true]],alarm:null});
  await mf.dispose();
  mf = new Miniflare(options()); await mf.ready;
  assert.deepEqual(await snapshot(),{entries:[['retired',true]],alarm:null});
  for (const type of ['call.initiated','call.answered','call.hangup']) assert.equal((await post('/events',event(type))).status,204);
  assert.equal((await mf.dispatchFetch('http://local.test/media',{headers:{Upgrade:'websocket','x-telnyx-streaming-auth-token':'a'.repeat(64)}})).status,403);
  assert.equal((await post('/reconcile')).status,204);
  assert.deepEqual(await snapshot(),{entries:[['retired',true]],alarm:null});
  console.log('PASS SQLite workerd retirement: atomic marker/control/alarm compaction, persisted restart, late events/media/reconcile inert. Synthetic only.');
} finally {
  await mf?.dispose();
  await rm(persist,{recursive:true,force:true});
}
