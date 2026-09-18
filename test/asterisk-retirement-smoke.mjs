#!/usr/bin/env node
/** Real SQLite-backed workerd DO/D1 retirement and restart, no external calls.
 * Test-only Probe routes/injected transaction failure never enter the app bundle.
 */
import { execFileSync } from 'node:child_process';
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
const closeCases=['close-carrier-1000','close-carrier-1011','close-session-1000','close-session-1011'];
const bundle=await build({stdin:{resolveDir:root,loader:'ts',contents:`
import { AsteriskCall } from './src/asterisk-control';
export class Probe extends AsteriskCall {
  constructor(ctx,env){
    let fail=false,opening=false,lateClosed=false,resolveSession,readyWaiting=false,resolveReady,sessionPeer;
    const DB={prepare(sql){
      const statement=env.DB.prepare(sql);
      if(sql.includes('SET connected_at=COALESCE'))return {bind(...args){const bound=statement.bind(...args);return {async first(){readyWaiting=true;await new Promise(resolve=>{resolveReady=resolve;});return bound.first();}};}};
      return statement;
    }};
    const storage=new Proxy(ctx.storage,{get(target,key){
      if(key==='transaction') return fn=>target.transaction(async txn=>{
        const result=await fn(txn);
        if(fail && await txn.get('retired'))throw new Error('injected compaction rollback');
        return result;
      });
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    super({storage,waitUntil:p=>ctx.waitUntil(p)}, {...env,DB,ASTERISK_ENABLED:'true',REALTIME_BASE_URL:'wss://provider.invalid/v1/realtime',REALTIME_API_KEY:'fixture-only',REALTIME_MODEL:'gpt-realtime-2',DEFAULT_TTS_PROVIDER:'browser',CALL_SESSION:{idFromName:x=>x,get:()=>({fetch:async request=>{
      const id=new URL(request.url).searchParams.get('call');
      if(${JSON.stringify(['adjacent-ready','ended-ready','connected-failure',...closeCases].map(name=>'ast_'+createHash('sha256').update(name).digest('hex')))}.includes(id)){
        const pair=new WebSocketPair();pair[1].accept();sessionPeer=pair[1];
        pair[1].addEventListener('message',event=>{
          const msg=JSON.parse(event.data);
          if(msg.type==='start'){pair[1].send(JSON.stringify({type:'ready',mode:'realtime',greeting:''}));pair[1].send(new ArrayBuffer(960));}
          if(msg.type==='hangup')pair[1].close(1000,'done');
        });
        return new Response(null,{status:101,webSocket:pair[0]});
      }
      if(!${JSON.stringify(['stalled-alarm','stalled-timeout'].map(name=>'ast_'+createHash('sha256').update(name).digest('hex')))}.includes(id))return new Response(null,{status:503});
      opening=true;return new Promise(resolve=>{resolveSession=()=>{
        const pair=new WebSocketPair();pair[1].accept();pair[1].addEventListener('close',()=>{lateClosed=true;});
        resolve(new Response(null,{status:101,webSocket:pair[0]}));
      };});
    }})}});
    this.closeSession=code=>sessionPeer?.close(code,'fixture close');this.ctx=ctx;this.fail=value=>{fail=value;};this.opening=()=>({opening,lateClosed,readyWaiting});this.resolveReady=()=>resolveReady?.();this.resolveSession=()=>resolveSession?.();
  }
  async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==='/close-session'){this.closeSession(Number(url.searchParams.get('code')));return new Response(null,{status:204});}
    if(url.pathname==='/opening')return Response.json(this.opening());
    if(url.pathname==='/release-readiness'){this.resolveReady();return new Response(null,{status:204});}
    if(url.pathname==='/resolve-session'){this.resolveSession();return new Response(null,{status:204});}
    if(url.pathname==='/snapshot')return Response.json({entries:[...await this.ctx.storage.list()],alarm:await this.ctx.storage.getAlarm()});
    if(url.pathname==='/seed-completed'){
      await this.ctx.storage.put({call:url.searchParams.get('call'),deadline:1,ending:'playback_complete',cleanup:1});
      await this.ctx.storage.setAlarm(Date.now()+60000);
      return new Response(null,{status:204});
    }
    if(url.pathname==='/due'){if(await this.ctx.storage.get('cleanup'))await this.ctx.storage.put('cleanup',1);return new Response(null,{status:204});}
    if(url.pathname==='/alarm'){await super.alarm();return new Response(null,{status:204});}
    if(url.pathname==='/expire'){
      if(await this.ctx.storage.get('cleanup'))await this.ctx.storage.put('cleanup',1);
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
const call=object=>'ast_'+createHash('sha256').update(object).digest('hex');
const verifier=execFileSync(process.execPath,[resolve(root,'scripts/asterisk-credential.mjs')],{input:password,encoding:'utf8'}).trim();
const admission=createHash('sha256').update(JSON.stringify(['pbx','biz','assistant',verifier])).digest('hex');
const send=(object,path,extra='')=>mf.dispatchFetch(`http://local.test${path}?object=${object}&call=${call(object)}&route=pbx${extra}`,{headers:{'X-Openfon-Asterisk-Admission':admission,...(path==='/media'?{Upgrade:'websocket','Sec-WebSocket-Protocol':'media'}:{})}});
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
    db.prepare("INSERT INTO asterisk_routes(id,business_id,assistant_id,password_sha256,enabled,password_hash) VALUES('pbx','biz','assistant',lower(hex(randomblob(32))),1,?)").bind(verifier),
  ]);
  await db.prepare("INSERT INTO calls(id,business_id,assistant_id,channel,status,environment,connected_at,carrier_released_at) VALUES(?,'biz','assistant','asterisk','completed','live',datetime('now'),datetime('now'))").bind(call('completed')).run();
  assert.equal((await send('completed','/seed-completed')).status,204);
  assert.equal((await send('completed','/expire')).status,204);assert.deepEqual(await snapshot('completed'),marker);
  assert.equal((await db.prepare('SELECT status FROM calls WHERE id=?').bind(call('completed')).first()).status,'completed');
  assert.equal((await send('failed','/media')).status,503);
  await send('failed','/due');const before=await snapshot('failed');assert.ok(before.entries.some(([key])=>key==='call'));assert.ok(before.alarm);
  assert.equal((await send('failed','/expire','&fail=true')).status,503);
  const rolledBack=await snapshot('failed');assert.deepEqual(rolledBack.entries,before.entries);assert.ok(rolledBack.alarm);
  assert.equal((await send('failed','/expire')).status,204);assert.deepEqual(await snapshot('failed'),marker);
  await db.prepare("UPDATE assistants SET state='paused'").run();
  assert.equal((await send('rejected','/media')).status,403);assert.deepEqual(await snapshot('rejected'),marker);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM calls').first()).n,2);
  await db.prepare("UPDATE assistants SET state='active'").run();
  for(const object of ['stalled-alarm','stalled-timeout']){
    const pending=send(object,'/media');
    for(let i=0;i<100;i++){if((await (await send(object,'/opening')).json()).opening)break;await new Promise(r=>setTimeout(r,10));}
    assert.equal((await (await send(object,'/opening')).json()).opening,true);
    if(object==='stalled-alarm')assert.equal((await send(object,'/expire')).status,204,'alarm is not blocked by session fetch');
    else assert.equal((await pending).status,503,'bounded ten-second session startup');
    const failed=await db.prepare('SELECT status,connected_at,carrier_released_at FROM calls WHERE id=?').bind(call(object)).first();
    assert.equal(failed.status,'failed');assert.equal(failed.connected_at,null);assert.ok(failed.carrier_released_at);
    assert.equal((await send(object,'/resolve-session')).status,204);
    if(object==='stalled-alarm')assert.equal((await pending).status,409,'late install rejected after alarm');
    for(let i=0;i<100;i++){if((await (await send(object,'/opening')).json()).lateClosed)break;await new Promise(r=>setTimeout(r,10));}
    assert.equal((await (await send(object,'/opening')).json()).lateClosed,true,'late actual workerd socket closed');
    assert.equal((await send(object,'/expire')).status,204);assert.deepEqual(await snapshot(object),marker);
  }
  for(const object of ['adjacent-ready','ended-ready','connected-failure',...closeCases]){
    const response=await send(object,'/media');assert.equal(response.status,101);const pbx=response.webSocket;pbx.accept();pbx.binaryType='arraybuffer';
    let pcmBytes=0;pbx.addEventListener('message',event=>{if(typeof event.data!=='string')pcmBytes+=event.data.byteLength;});
    pbx.send(JSON.stringify({event:'MEDIA_START',connection_id:'fixture',channel:'fixture',format:'ulaw',optimal_frame_size:160,ptime:20}));
    for(let i=0;i<100;i++){if((await (await send(object,'/opening')).json()).readyWaiting && pcmBytes>0)break;await new Promise(r=>setTimeout(r,10));}
    assert.equal((await (await send(object,'/opening')).json()).readyWaiting,true);
    assert.equal(pcmBytes,160,'PCM adjacent to ready is delivered while readiness D1 write is pending');
    assert.equal((await db.prepare('SELECT connected_at FROM calls WHERE id=?').bind(call(object)).first()).connected_at,null);
    if(object==='ended-ready'){
      await db.prepare("UPDATE calls SET status='failed',outcome='failed' WHERE id=?").bind(call(object)).run();
      pbx.close(1000,'ended during pending projection');
    }
    assert.equal((await send(object,'/release-readiness')).status,204);
    for(let i=0;i<100;i++){
      const row=await db.prepare('SELECT connected_at,carrier_released_at FROM calls WHERE id=?').bind(call(object)).first();
      if(object!=='ended-ready'?row.connected_at:row.carrier_released_at)break;
      await new Promise(r=>setTimeout(r,10));
    }
    const row=await db.prepare('SELECT status,connected_at FROM calls WHERE id=?').bind(call(object)).first();
    if(object!=='ended-ready'){assert.ok(row.connected_at);if(object.startsWith('close-carrier-'))pbx.close(Number(object.split('-')[2]),'fixture close');else if(object.startsWith('close-session-'))assert.equal((await send(object,'/close-session','&code='+object.split('-')[2])).status,204);else if(object==='connected-failure')pbx.send('invalid frame');else pbx.close();}
    else {assert.equal(row.status,'failed');assert.equal(row.connected_at,null,'pending readiness cannot resurrect terminal row');}
    for(let i=0;i<100;i++){if((await snapshot(object)).entries.some(([key])=>key==='cleanup'))break;await new Promise(r=>setTimeout(r,10));}
    const grace=await snapshot(object);
    assert.equal((await send(object,'/alarm')).status,204);
    assert.deepEqual((await snapshot(object)).entries,grace.entries,'early alarm retains cleanup state');
    assert.equal((await snapshot(object)).alarm,grace.entries.find(([key])=>key==='cleanup')[1]);
    if(closeCases.includes(object)){
      const closed=await db.prepare('SELECT status,outcome,failure_code,carrier_released_at FROM calls WHERE id=?').bind(call(object)).first();
      assert.ok(closed.carrier_released_at);
      if(object.endsWith('1011'))assert.deepEqual({status:closed.status,outcome:closed.outcome,failure_code:closed.failure_code},{status:'failed',outcome:'failed',failure_code:'asterisk_socket_error'});
      else {assert.equal(closed.status,'active');assert.equal(closed.failure_code,null);await db.prepare("UPDATE calls SET status='completed',outcome='answered' WHERE id=? AND status='active'").bind(call(object)).run();}
    }
    if(object==='connected-failure'){const failed=await db.prepare('SELECT status,outcome,failure_code FROM calls WHERE id=?').bind(call(object)).first();assert.deepEqual(failed,{status:'failed',outcome:'failed',failure_code:'asterisk_invalid_carrier_frame'});}
    assert.equal((await send(object,'/expire')).status,204);assert.deepEqual(await snapshot(object),marker);
  }
  await db.prepare('DELETE FROM calls').run();
  await mf.dispose();mf=new Miniflare(options());await mf.ready;
  db=await mf.getD1Database('DB','asterisk-retirement');
  for(const object of ['completed','failed','rejected','stalled-alarm','stalled-timeout','adjacent-ready','ended-ready','connected-failure',...closeCases]){
    assert.deepEqual(await snapshot(object),marker);
    assert.equal((await send(object,'/media')).status,409);
    assert.equal((await send(object,'/expire')).status,204);
    assert.deepEqual(await snapshot(object),marker);
  }
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM calls').first()).n,0);
  console.log('PASS Asterisk SQLite-workerd retirement: completed call, failed setup and rejected admission compact to marker only; actual transaction rollback preserves recovery fields/alarm; persisted restart and D1 row deletion cannot admit late replay. stalled startup permits alarms, times out, and closes late actual sockets; adjacent ready+PCM survives pending D1 readiness without reviving failed calls. actual carrier/session1000 closes preserve normal completion and1011 closes project failure/release. No external calls.');
}finally{await mf?.dispose();await rm(persist,{recursive:true,force:true});}
