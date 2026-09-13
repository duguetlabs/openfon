#!/usr/bin/env node
/** Real workerd/D1/DO restart; synthetic carrier failure projection and mocked summary AI. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(resolve(tmpdir(), 'openfon-asterisk-finalization-'));
let mf, db, failProjection = false, failDuringSummary = false, summaries = 0;
const fail = async id => db.prepare(`UPDATE calls SET status='failed',outcome='failed',
  ended_at='2026-09-12 12:00:55',carrier_released_at='2026-09-12 12:00:55',
  failure_code='asterisk_socket_error',failure_message='Socket failed' WHERE id=?`).bind(id).run();
try {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
import { CallSession } from './src/call-session';
export class Probe extends CallSession {
  constructor(state,env) {
    const wrap = (statement,sql) => new Proxy(statement,{get(target,key){
      if(key==='bind')return (...args)=>wrap(target.bind(...args),sql);
      if(key==='run' && sql.startsWith('UPDATE calls SET duration_s'))return async()=>{
        if((await env.PROJECTION.fetch('https://projection.invalid')).status===503)throw Error('injected content projection failure');
        return target.run();
      };
      const value=target[key]; return typeof value==='function'?value.bind(target):value;
    }});
    const DB=new Proxy(env.DB,{get(target,key){if(key==='prepare')return sql=>wrap(target.prepare(sql),sql);
      const value=target[key];return typeof value==='function'?value.bind(target):value;}});
    super(state,{...env,DB});this.probeState=state;
  }
  async fetch(request) {
    const {id,initialize}=await request.json();
    if(initialize) await this.probeState.storage.put({callId:id,hardDeadline:Date.now()-1});
    else await this.alarm();
    return Response.json({keys:[...(await this.probeState.storage.list()).keys()]});
  }
}
export default {async fetch(request,env){const id=new URL(request.url).pathname.slice(1);
  return env.SESSION.get(env.SESSION.idFromName(id)).fetch(request);}};
` }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, external: ['cloudflare:*'] });
  const start = async () => {
    mf = new Miniflare(convertV4MiniflareOptions({ port: Number(process.env.OPENFON_TEST_PORT || 8811), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9251), resourcePersistencePath: temp, cf: false, workers: [{
      name: 'probe', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-01',
      d1Databases: { DB: 'probe-db' }, durableObjects: { SESSION: { className: 'Probe', useSQLite: true } },
      bindings: { DEFAULT_LLM_BASE_URL: 'https://summary.invalid/v1', DEFAULT_LLM_MODEL: 'mock', DEFAULT_LLM_API_KEY: 'synthetic-only' },
      serviceBindings: { PROJECTION: async () => new Response('', {status: failProjection ? 503 : 200}) },
      outboundService: async request => {
        assert.equal(new URL(request.url).href, 'https://summary.invalid/v1/chat/completions');
        summaries++;
        if (failDuringSummary) await fail('during');
        return Response.json({choices:[{message:{content:JSON.stringify({summary:'Callback requested',intent:'message',message:'Please call tomorrow'})}}]});
      },
    }] }));
    await mf.ready; db = await mf.getD1Database('DB', 'probe');
  };
  await start();
  for (const name of (await readdir(resolve(root, 'migrations'))).filter(n => n.endsWith('.sql')).sort()) {
    await db.batch(unstable_splitSqlQuery(await readFile(resolve(root, 'migrations', name), 'utf8')).map(sql => db.prepare(sql)));
  }
  await db.exec("INSERT INTO users(id,email,password_hash) VALUES('u','u@example.invalid','unused'); INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','Business'); INSERT INTO agent_settings(business_id) VALUES('b');");
  const invoke = async (id, initialize = false) => (await mf.dispatchFetch(`http://local/${id}`, {method:'POST',body:JSON.stringify({id,initialize})})).json();
  const row = id => db.prepare('SELECT * FROM calls WHERE id=?').bind(id).first();
  const seed = async id => {
    await db.prepare("INSERT INTO calls(id,business_id,channel,status,started_at,connected_at) VALUES(?,'b','asterisk','active','2026-09-12 12:00:00','2026-09-12 12:00:40')").bind(id).run();
    await db.prepare("INSERT INTO call_turns(call_id,role,text) VALUES(?,'caller','Please call tomorrow'),(?,'agent','Certainly')").bind(id,id).run();
    await invoke(id,true);
  };
  const verify = async id => {
    const r = await row(id);
    for(const [key,value] of Object.entries({status:'failed',outcome:'failed',ended_at:'2026-09-12 12:00:55',duration_s:15,failure_code:'asterisk_socket_error',failure_message:'Socket failed',summary:'Callback requested',intent:'message'})) assert.equal(r[key],value,`${id}.${key}`);
    assert.equal(JSON.parse(r.message_json).message,'Please call tomorrow');
  };
  await seed('before'); await fail('before'); failProjection=true;
  await invoke('before');
  assert.equal((await row('before')).duration_s,null);
  assert.equal(summaries,1); // Summary persisted before the injected D1 write failure.
  await mf.dispose(); mf=null; failProjection=false;
  await start();
  assert.deepEqual((await invoke('before')).keys,[]);
  await verify('before'); assert.equal(summaries,1);
  await invoke('before'); assert.equal(summaries,1);
  await seed('during'); failDuringSummary=true;
  assert.deepEqual((await invoke('during')).keys,[]);
  await verify('during'); assert.equal(summaries,2);
  console.log(JSON.stringify({result:'PASS',runtime:'actual workerd/D1/DO persisted restart',carrier:'synthetic failure projection',AI:'mocked only',cases:['failed before lookup, D1 write error, restart and cached retry','failure during summary','watchdog storage cleared and replay inert'],summaries}));
} finally {
  await mf?.dispose();
  await rm(temp,{recursive:true,force:true});
}
