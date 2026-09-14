#!/usr/bin/env node
/** Actual workerd Asterisk owner + migrated D1. Hold the real reservation
 * statement while a second D1 request changes its checked inputs. Trusted
 * binding credential fixture; no public auth, provider/PBX or external calls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { unstable_splitSqlQuery } from 'wrangler';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const root=fileURLToPath(new URL('../',import.meta.url));
const persist=await mkdtemp(resolve(tmpdir(),'openfon-asterisk-admission-'));
const bundle=await build({stdin:{resolveDir:root,loader:'ts',contents:`
import { AsteriskCall } from './src/asterisk-control';
export class Probe extends AsteriskCall {
  constructor(ctx,env){
    let held=false,release,sessionFetches=0;
    const DB={prepare(sql){
      const statement=env.DB.prepare(sql);
      if(sql.includes('INSERT OR IGNORE INTO calls'))return {bind(...args){
        const bound=statement.bind(...args);return {async first(){
          held=true;await new Promise(resolve=>{release=resolve;});held=false;
          return bound.first();
        }};
      }};
      return statement;
    }};
    super(ctx,{...env,DB,ASTERISK_ENABLED:'true',REALTIME_BASE_URL:'wss://provider.invalid/v1/realtime',
      REALTIME_API_KEY:'synthetic-instance',REALTIME_MODEL:'gpt-realtime-2',DEFAULT_TTS_PROVIDER:'browser',
      CALL_SESSION:{idFromName:id=>id,get:()=>({fetch:async()=>{sessionFetches++;return new Response(null,{status:503});}})}});
    this.ctx=ctx;this.release=()=>release?.();this.inspect=()=>({held,sessionFetches});
  }
  async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==='/probe')return Response.json({...this.inspect(),entries:[...await this.ctx.storage.list()],alarm:await this.ctx.storage.getAlarm()});
    if(url.pathname==='/release'){this.release();return new Response(null,{status:204});}
    return super.fetch(request);
  }
}
export default {fetch(request,env){const name=new URL(request.url).searchParams.get('object');return env.PROBE.get(env.PROBE.idFromName(name)).fetch(request);}};
`},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});
const options=()=>({...convertV4MiniflareOptions({cf:false,port:Number(process.env.OPENFON_TEST_PORT||8811),inspectorPort:Number(process.env.OPENFON_INSPECTOR_PORT||9251),workers:[{
  name:'asterisk-admission',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-01',
  d1Databases:{DB:'admission-db'},durableObjects:{PROBE:{className:'Probe',useSQLite:true}},
  outboundService:()=>{throw Error('External request forbidden');},
}]}),resourcePersistencePath:persist});
const verifier='synthetic-trusted-binding-verifier';
const admission=createHash('sha256').update(JSON.stringify(['pbx','biz','assistant',verifier])).digest('hex');
const call=name=>'ast_'+createHash('sha256').update(name).digest('hex');
let mf;
const send=(name,path)=>mf.dispatchFetch(`http://local.test${path}?object=${name}&call=${call(name)}&route=pbx`,{headers:{
  'X-Openfon-Asterisk-Admission':admission,...(path==='/media'?{Upgrade:'websocket','Sec-WebSocket-Protocol':'media'}:{})}});
const probe=async name=>(await send(name,'/probe')).json();
const waitHeld=async name=>{
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if((await probe(name)).held)return;await new Promise(resolve=>setTimeout(resolve,20));}
  throw Error('Reservation did not reach held boundary');
};
const cases=[
  {name:'provider-key',seed:true,sql:"UPDATE provider_settings SET realtime_api_key='synthetic-rotated'",reject:true},
  {name:'provider-selection',seed:true,sql:"UPDATE provider_settings SET realtime_provider='custom',realtime_base_url='wss://custom.example.com/realtime'",reject:true},
  {name:'provider-url',seed:true,sql:"UPDATE provider_settings SET realtime_base_url='wss://other.example.com/realtime'",reject:true},
  {name:'model',seed:true,sql:"UPDATE assistants SET realtime_model='kataleptic-realtime-hd'",reject:true},
  {name:'voice',seed:true,sql:"UPDATE assistants SET realtime_voice='changed-voice'",reject:true},
  {name:'provider-inserted',seed:false,sql:"INSERT INTO provider_settings(business_id) VALUES('biz')",reject:true},
  {name:'provider-deleted',seed:true,sql:"DELETE FROM provider_settings",reject:true},
  {name:'route-reassigned',seed:true,sql:"UPDATE asterisk_routes SET assistant_id='other'",reject:true},
  {name:'unchanged',seed:true,sql:null,reject:false},
  {name:'unrelated-stt',seed:true,sql:"UPDATE provider_settings SET stt_model='unrelated'",reject:false},
];
const results=[];
try {
  mf=new Miniflare(options());await mf.ready;
  const db=await mf.getD1Database('DB','asterisk-admission');
  for(const name of (await readdir(resolve(root,'migrations'))).filter(name=>name.endsWith('.sql')).sort()){
    await db.batch(unstable_splitSqlQuery(await readFile(resolve(root,'migrations',name),'utf8')).map(sql=>db.prepare(sql)));
  }
  await db.batch([
    db.prepare("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused')"),
    db.prepare("INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','admission','Fixture')"),
    ...['assistant','other'].map(id=>db.prepare("INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language,engine,realtime_model) VALUES(?,'biz',?,'active','Alex','Helpful','en','realtime','gpt-realtime-2')").bind(id,id)),
    db.prepare("INSERT INTO asterisk_routes(id,business_id,assistant_id,password_sha256,enabled,password_hash) VALUES('pbx','biz','assistant',lower(hex(randomblob(32))),1,?)").bind(verifier),
  ]);
  for(const scenario of cases){
    await db.batch([
      db.prepare('DELETE FROM calls'),db.prepare('DELETE FROM provider_settings'),
      db.prepare("UPDATE assistants SET engine='realtime',realtime_model='gpt-realtime-2',realtime_voice=''"),
      db.prepare("UPDATE asterisk_routes SET assistant_id='assistant'"),
    ]);
    if(scenario.seed)await db.prepare("INSERT INTO provider_settings(business_id,realtime_provider,realtime_api_key) VALUES('biz','kataleptic','synthetic-workspace')").run();
    const pending=send(scenario.name,'/media');
    // Always settle the held request before assertions/disposal, including a
    // broken fixture or original-source negative failure.
    let response;
    try {
      await waitHeld(scenario.name);
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM calls').first()).n,0);
      if(scenario.sql)await db.prepare(scenario.sql).run();
    } finally {await send(scenario.name,'/release');response=await pending;}
    const state=await probe(scenario.name);
    const count=(await db.prepare('SELECT COUNT(*) n FROM calls').first()).n;
    results.push({name:scenario.name,status:response.status,calls:count,sessionFetches:state.sessionFetches});
    console.log(JSON.stringify({observation:results.at(-1)}));
    assert.equal(response.status,scenario.reject?403:503,scenario.name+' admission status');
    assert.equal(count,scenario.reject?0:1,scenario.name+' call count');
    assert.equal(state.sessionFetches,scenario.reject?0:1,scenario.name+' session dispatch');
    if(scenario.reject){assert.deepEqual(state.entries,[['retired',true]]);assert.equal(state.alarm,null);}
  }
  await mf.dispose();mf=undefined;
  mf=new Miniflare(options());await mf.ready;
  for(const scenario of cases.filter(scenario=>scenario.reject)){
    const state=await probe(scenario.name);assert.deepEqual(state.entries,[['retired',true]]);assert.equal(state.alarm,null);
  }
  console.log(JSON.stringify({evidence:'actual workerd owner + migrated D1; held SQL boundary; synthetic trusted binding/session; no public auth/provider/PBX',results,persistedRetirementAfterRestart:true}));
} finally {
  await mf?.dispose();await rm(persist,{recursive:true,force:true});
}
