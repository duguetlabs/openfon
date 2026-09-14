#!/usr/bin/env node
/** Actual workerd Telnyx owner + migrated D1, held before the atomic admission
 * batch. Synthetic verified-event boundary and carrier command responses only;
 * no public signature/network/provider/audio acceptance claim. */
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
const persist=await mkdtemp(resolve(tmpdir(),'openfon-telnyx-admission-runtime-'));
const bundle=await build({stdin:{resolveDir:root,loader:'ts',contents:`
import { TelnyxCall } from './src/telnyx-control';
export class Probe extends TelnyxCall {
  constructor(ctx,env){
    let held=false,release,batchError=false,batchResults=null,sessionFetches=0;
    const pending=[];
    const state={storage:ctx.storage,waitUntil(p){pending.push(p);ctx.waitUntil(p);}};
    const DB={prepare:sql=>env.DB.prepare(sql),async batch(statements){
      held=true;await new Promise(resolve=>{release=resolve;});held=false;
      try { const result=await env.DB.batch(statements);batchResults=result.map(r=>({changes:r.meta.changes}));return result; }
      catch(error){batchError=true;throw error;}
    }};
    super(state,{...env,DB,TELNYX_ENABLED:'true',TELNYX_API_KEY:'synthetic-carrier',TELNYX_PUBLIC_ORIGIN:'https://fixture.invalid',
      REALTIME_BASE_URL:'wss://provider.invalid/v1/realtime',REALTIME_API_KEY:'synthetic-instance',REALTIME_MODEL:'gpt-realtime-2',DEFAULT_TTS_PROVIDER:'browser',
      CALL_SESSION:{idFromName:id=>id,get:()=>({fetch:async()=>{sessionFetches++;return new Response(null,{status:503});}})}});
    this.ctx=ctx;this.release=()=>release?.();this.inspect=()=>({held,batchError,batchResults,sessionFetches});
    this.drain=async()=>{while(pending.length)await pending.shift();};
  }
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/probe')return Response.json({...this.inspect(),control:await this.ctx.storage.get('control'),alarm:await this.ctx.storage.getAlarm()});
    if(path==='/release'){this.release();return new Response(null,{status:204});}
    if(path==='/drain'){await this.drain();return new Response(null,{status:204});}
    return super.fetch(request);
  }
}
export default {fetch(request,env){const name=new URL(request.url).searchParams.get('object');return env.PROBE.get(env.PROBE.idFromName(name)).fetch(request);}};
`},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});
const commands=[];
const options=()=>({...convertV4MiniflareOptions({cf:false,port:Number(process.env.OPENFON_TEST_PORT||8810),inspectorPort:Number(process.env.OPENFON_INSPECTOR_PORT||9250),workers:[{
  name:'telnyx-admission',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-01',
  d1Databases:{DB:'admission-db'},durableObjects:{PROBE:{className:'Probe',useSQLite:true}},
  outboundService:request=>{
    const url=new URL(request.url);
    if(url.origin!=='https://api.telnyx.com'||!url.pathname.match(/\/actions\/(answer|hangup|streaming_start)$/))throw Error('Unexpected external request');
    commands.push(url.pathname.split('/').at(-1));return Response.json({data:{result:'ok'}});
  },
}]}),resourcePersistencePath:persist});
const call=name=>({connectionId:'connection',callLegId:'leg-'+name,callSessionId:'session-'+name,callControlId:'control-'+name});
const callId=name=>'tnx_'+createHash('sha256').update('telnyx\0connection\0leg-'+name).digest('hex');
let mf;
const send=(name,path,body)=>mf.dispatchFetch('http://local.test'+path+'?object='+name,{method:'POST',...(body?{body:JSON.stringify(body)}:{})});
const probe=async name=>(await send(name,'/probe')).json();
async function waitHeld(name){
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if((await probe(name)).held)return;await new Promise(resolve=>setTimeout(resolve,20));}
  throw Error('Admission batch did not reach hold');
}
const cases=[
  {name:'key',sql:"UPDATE provider_settings SET realtime_api_key='rotated'"},
  {name:'selection',sql:"UPDATE provider_settings SET realtime_provider='custom',realtime_base_url='wss://custom.example.com/realtime'"},
  {name:'url',sql:"UPDATE provider_settings SET realtime_base_url='wss://other.example.com/realtime'"},
  {name:'model',sql:"UPDATE assistants SET realtime_model='kataleptic-realtime-hd' WHERE id='assistant'"},
  {name:'voice',sql:"UPDATE assistants SET realtime_voice='changed' WHERE id='assistant'"},
  {name:'provider-insert',absent:true,sql:"INSERT INTO provider_settings(business_id) VALUES('biz')"},
  {name:'provider-delete',sql:'DELETE FROM provider_settings'},
  {name:'assistant',sql:"UPDATE telnyx_number_routes SET assistant_id='other'"},
  {name:'workspace',sql:"UPDATE telnyx_number_routes SET business_id='other-biz',assistant_id='cross'"},
  {name:'ignored-call',existing:true},
  {name:'mismatched-link',existing:true,link:true},
  {name:'concurrency',sql:"UPDATE businesses SET max_concurrent_calls=0 WHERE id='biz'"},
  {name:'daily',sql:"UPDATE businesses SET max_calls_per_day=0 WHERE id='biz'"},
  {name:'link-rollback',rollback:true,sql:"CREATE TRIGGER reject_link BEFORE INSERT ON telnyx_call_links BEGIN SELECT RAISE(ABORT,'synthetic link failure'); END"},
  {name:'exact-replay',existing:true,link:true,replay:true,accept:true},
  {name:'unchanged',accept:true},
  {name:'unrelated',accept:true,sql:"UPDATE provider_settings SET stt_model='unrelated',llm_model='unrelated'"},
];
const results=[],failures=[];
try {
  mf=new Miniflare(options());await mf.ready;
  const db=await mf.getD1Database('DB','telnyx-admission');
  for(const name of (await readdir(resolve(root,'migrations'))).filter(n=>n.endsWith('.sql')).sort())
    await db.batch(unstable_splitSqlQuery(await readFile(resolve(root,'migrations',name),'utf8')).map(sql=>db.prepare(sql)));
  await db.batch([
    db.prepare("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'),('other-owner','other-owner@example.invalid','unused')"),
    db.prepare("INSERT INTO businesses(id,user_id,slug,name,max_concurrent_calls,max_calls_per_day) VALUES('biz','owner','biz','Fixture',5,100),('other-biz','other-owner','other-biz','Other',5,100)"),
    ...[['assistant','biz'],['other','biz'],['cross','other-biz']].map(([id,biz])=>db.prepare("INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language,engine,realtime_model) VALUES(?,?,?,'active','Alex','Helpful','en','realtime','gpt-realtime-2')").bind(id,biz,id)),
    db.prepare("INSERT INTO telnyx_number_routes VALUES('connection','+12025550101','biz','assistant',1)"),
  ]);
  const rows=async()=>({calls:(await db.prepare('SELECT * FROM calls ORDER BY id').all()).results,links:(await db.prepare('SELECT * FROM telnyx_call_links ORDER BY call_id').all()).results});
  for(const scenario of cases){
    await db.batch([
      db.prepare('DROP TRIGGER IF EXISTS reject_link'),db.prepare('DELETE FROM calls'),db.prepare('DELETE FROM provider_settings'),
      db.prepare("UPDATE businesses SET max_concurrent_calls=5,max_calls_per_day=100"),
      db.prepare("UPDATE assistants SET engine='realtime',realtime_model='gpt-realtime-2',realtime_voice=''"),
      db.prepare("UPDATE telnyx_number_routes SET business_id='biz',assistant_id='assistant',enabled=1"),
    ]);
    if(!scenario.absent)await db.prepare("INSERT INTO provider_settings(business_id,realtime_provider,realtime_api_key) VALUES('biz','kataleptic','synthetic-workspace')").run();
    const id=callId(scenario.name),correlation=call(scenario.name);commands.length=0;
    if(scenario.existing)await db.prepare("INSERT INTO calls(id,business_id,assistant_id,channel,environment,reserved_at) VALUES(?,'biz','assistant','telnyx','live',datetime('now'))").bind(id).run();
    if(scenario.link)await db.prepare("INSERT INTO telnyx_call_links(call_id,connection_id,call_leg_id,call_session_id,call_control_id,phone_number) VALUES(?,?,?,?,?,'+12025550101')").bind(id,correlation.connectionId,correlation.callLegId,correlation.callSessionId,scenario.replay?correlation.callControlId:'mismatch').run();
    if(scenario.replay)await db.batch([db.prepare('UPDATE telnyx_number_routes SET enabled=0'),db.prepare('DELETE FROM provider_settings')]);
    const replayBefore=scenario.replay?await rows():null;
    const response=await send(scenario.name,'/events',{id:crypto.randomUUID(),type:'call.initiated',callId:id,call:correlation,from:'+12025550100',to:'+12025550101'});
    assert.equal(response.status,204);
    let before;
    if(scenario.replay){before=replayBefore;await send(scenario.name,'/drain');}
    else {
      try {await waitHeld(scenario.name);if(scenario.sql)await db.prepare(scenario.sql).run();before=await rows();}
      finally {await send(scenario.name,'/release');await send(scenario.name,'/drain');}
    }
    const state=await probe(scenario.name),after=await rows();
    const observation={name:scenario.name,admitted:state.control.admitted,calls:after.calls.length,links:after.links.length,commands:[...commands],sessionFetches:state.sessionFetches,batchError:state.batchError,batchResults:state.batchResults};
    results.push(observation);console.log(JSON.stringify({observation}));
    try {
      assert.equal(state.control.admitted,Boolean(scenario.accept),scenario.name+' admission');
      assert.equal(state.sessionFetches,0);
      if(scenario.replay){assert.deepEqual(after,before,'exact-link recovery retains original rows after route/provider edits');assert.equal(state.batchResults,null);assert.equal(state.held,false);}
      if(scenario.accept){assert.equal(after.calls.length,1);assert.equal(after.links.length,1);assert.ok(commands.includes('answer'));}
      else {
        assert.deepEqual(after,before,scenario.name+' call/link preservation');assert.ok(!commands.includes('answer'));assert.ok(!commands.includes('streaming_start'));
        if(scenario.rollback){assert.equal(state.batchError,true);assert.equal(state.control.inbox.length,1);assert.ok(state.alarm>Date.now());}
        else {assert.equal(state.control.ending,true);assert.ok(commands.includes('hangup'));}
      }
    } catch(error){failures.push({name:scenario.name,message:error.message});}
  }
  const sourceHashes={};for(const name of ['src/telnyx-admission.ts','src/telnyx-control.ts','test/telnyx-admission-smoke.mjs'])sourceHashes[name]=createHash('sha256').update(await readFile(resolve(root,name))).digest('hex');
  console.log(JSON.stringify({evidence:'actual workerd Telnyx owner and migrated D1; synthetic verified-event/command boundary; held atomic batch, no external carrier/AI',sourceHashes,results,failures}));
  assert.equal(failures.length,0,'Native admission scenarios failed; see preserved observations');
} finally {await mf?.dispose();await rm(persist,{recursive:true,force:true});}
