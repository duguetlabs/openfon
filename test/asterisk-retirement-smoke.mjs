#!/usr/bin/env node
/** Real SQLite-backed workerd DO/D1 retirement and restart, no external calls.
 * Test-only Probe routes/injected transaction failure never enter the app bundle.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { unstable_splitSqlQuery } from 'wrangler';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const root=fileURLToPath(new URL('../',import.meta.url));
const persist=await mkdtemp(resolve(tmpdir(),'openfon-asterisk-retirement-'));
const bundle=await build({stdin:{resolveDir:root,loader:'ts',contents:`
import { AsteriskCall } from './src/asterisk-control';
export class Probe extends AsteriskCall {
  constructor(ctx,env){
    let fail=false;
    const storage=new Proxy(ctx.storage,{get(target,key){
      if(key==='transaction') return fn=>target.transaction(async txn=>{
        const result=await fn(txn);
        if(fail && await txn.get('retired'))throw new Error('injected compaction rollback');
        return result;
      });
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    super({storage,waitUntil:p=>ctx.waitUntil(p)}, {...env,ASTERISK_ENABLED:'true',REALTIME_BASE_URL:'wss://provider.invalid/v1/realtime',REALTIME_API_KEY:'fixture-only',REALTIME_MODEL:'gpt-realtime-2',DEFAULT_TTS_PROVIDER:'browser',CALL_SESSION:{idFromName:x=>x,get:()=>({fetch:async()=>new Response(null,{status:503})})}});
    this.ctx=ctx;this.fail=value=>{fail=value;};
  }
  async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==='/snapshot')return Response.json({entries:[...await this.ctx.storage.list()],alarm:await this.ctx.storage.getAlarm()});
    if(url.pathname==='/seed-completed'){
      await this.ctx.storage.put({call:url.searchParams.get('call'),deadline:1,ending:'playback_complete',cleanup:1});
      await this.ctx.storage.setAlarm(Date.now()+60000);
      return new Response(null,{status:204});
    }
    if(url.pathname==='/expire'){
      this.fail(url.searchParams.get('fail')==='true');
      try{await super.alarm();return new Response(null,{status:204});}
      catch{return new Response(null,{status:503});}
      finally{this.fail(false);}
    }
    return super.fetch(request);
  }
}
export default {fetch(request,env){const name=new URL(request.url).searchParams.get('object')||'failed';return env.PROBE.get(env.PROBE.idFromName(name)).fetch(request);}};
`},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});
const options=()=>({...convertV4MiniflareOptions({cf:false,port:Number(process.env.OPENFON_TEST_PORT||8811),inspectorPort:Number(process.env.OPENFON_INSPECTOR_PORT||9251),workers:[{
  name:'asterisk-retirement',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-01',
  d1Databases:{DB:'retirement-db'},durableObjects:{PROBE:{className:'Probe',useSQLite:true}},
  outboundService:()=>{throw Error('External request forbidden');},
}]}),resourcePersistencePath:persist});
let mf;
const password='synthetic-password-with-at-least-32-bytes';
const auth='Basic '+Buffer.from('pbx:'+password).toString('base64');
const call=object=>'ast_'+createHash('sha256').update(object).digest('hex');
const send=(object,path,extra='')=>mf.dispatchFetch(`http://local.test${path}?object=${object}&call=${call(object)}&route=pbx${extra}`,{headers:{Authorization:auth,...(path==='/media'?{Upgrade:'websocket'}:{})}});
const snapshot=async object=>(await send(object,'/snapshot')).json();
const marker={entries:[['retired',true]],alarm:null};
try{
  mf=new Miniflare(options());await mf.ready;
  let db=await mf.getD1Database('DB','asterisk-retirement');
  for(const name of (await readdir(resolve(root,'migrations'))).filter(x=>x.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(resolve(root,'migrations',name),'utf8')).map(sql=>db.prepare(sql)));
  await db.batch([
    db.prepare("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused')"),
    db.prepare("INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','retirement','Fixture')"),
    db.prepare("INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language,engine,realtime_model) VALUES('assistant','biz','retirement','active','Alex','Helpful','en','realtime','gpt-realtime-2')"),
    db.prepare("INSERT INTO asterisk_routes VALUES('pbx','biz','assistant',?,1)").bind(createHash('sha256').update(password).digest('hex')),
  ]);
  await db.prepare("INSERT INTO calls(id,business_id,assistant_id,channel,status,environment,connected_at,carrier_released_at) VALUES(?,'biz','assistant','asterisk','completed','live',datetime('now'),datetime('now'))").bind(call('completed')).run();
  assert.equal((await send('completed','/seed-completed')).status,204);
  assert.equal((await send('completed','/expire')).status,204);assert.deepEqual(await snapshot('completed'),marker);
  assert.equal((await db.prepare('SELECT status FROM calls WHERE id=?').bind(call('completed')).first()).status,'completed');
  assert.equal((await send('failed','/media')).status,503);
  const before=await snapshot('failed');assert.ok(before.entries.some(([key])=>key==='call'));assert.ok(before.alarm);
  assert.equal((await send('failed','/expire','&fail=true')).status,503);
  const rolledBack=await snapshot('failed');assert.deepEqual(rolledBack.entries,before.entries);assert.ok(rolledBack.alarm);
  assert.equal((await send('failed','/expire')).status,204);assert.deepEqual(await snapshot('failed'),marker);
  await db.prepare("UPDATE assistants SET state='paused'").run();
  assert.equal((await send('rejected','/media')).status,403);assert.deepEqual(await snapshot('rejected'),marker);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM calls').first()).n,2);
  await db.prepare('DELETE FROM calls').run();await db.prepare("UPDATE assistants SET state='active'").run();
  await mf.dispose();mf=new Miniflare(options());await mf.ready;
  db=await mf.getD1Database('DB','asterisk-retirement');
  for(const object of ['completed','failed','rejected']){
    assert.deepEqual(await snapshot(object),marker);
    assert.equal((await send(object,'/media')).status,409);
    assert.equal((await send(object,'/expire')).status,204);
    assert.deepEqual(await snapshot(object),marker);
  }
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM calls').first()).n,0);
  console.log('PASS Asterisk SQLite-workerd retirement: completed call, failed setup and rejected admission compact to marker only; actual transaction rollback preserves recovery fields/alarm; persisted restart and D1 row deletion cannot admit late replay. No external calls.');
}finally{await mf?.dispose();await rm(persist,{recursive:true,force:true});}
