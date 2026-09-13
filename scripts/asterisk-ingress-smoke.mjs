#!/usr/bin/env node
/** Actual workerd/PBKDF2/D1 public ingress; owner dispatch stubbed, no AI/PBX/network. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
const root=fileURLToPath(new URL('../',import.meta.url));
const password='synthetic_Ingress_01234567890123456789';
const hash=execFileSync(process.execPath,['scripts/asterisk-credential.mjs'],{cwd:root,input:password,encoding:'utf8'}).trim();
const bundle=await build({stdin:{resolveDir:root,loader:'ts',contents:`
import {Hono} from 'hono';import {registerAsteriskRoutes} from './src/asterisk-routes';
let writes=0,contacts=0,clock=Date.now();Date.now=()=>clock;
const app=new Hono();registerAsteriskRoutes(app);
export default {async fetch(request,env,ctx){const path=new URL(request.url).pathname;
 if(path==='/stats')return Response.json({writes,contacts});
 if(path==='/refill'){clock+=10000;return new Response(null,{status:204});}
 const DB=new Proxy(env.DB,{get(target,key){if(key==='prepare')return sql=>{
   if(!sql.trimStart().startsWith('SELECT'))writes++;
   return target.prepare(sql);
 };const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 return app.fetch(request,{...env,DB,ASTERISK_CALL:{idFromName(id){contacts++;return id;},get(){return {fetch:()=>new Response(null,{status:200})};}}},ctx);
}};`},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});
let mf;
try {
 mf=new Miniflare(convertV4MiniflareOptions({cf:false,port:Number(process.env.OPENFON_TEST_PORT||8811),inspectorPort:Number(process.env.OPENFON_INSPECTOR_PORT||9251),workers:[{name:'ingress',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-01',bindings:{ASTERISK_ENABLED:'true'},d1Databases:{DB:'ingress-db'},outboundService:()=>{throw Error('Network forbidden');}}]}));
 await mf.ready;const db=await mf.getD1Database('DB','ingress');
 for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
 await db.exec("INSERT INTO users(id,email,password_hash) VALUES('u','u@example.invalid','unused'); INSERT INTO businesses(id,user_id,slug,name,max_concurrent_calls,max_calls_per_day) VALUES('b','u','b','Business',1,1); INSERT INTO assistants(id,business_id,public_slug,name) VALUES('a','b','a','Assistant');");
 await db.prepare("INSERT INTO asterisk_routes(id,business_id,assistant_id,password_sha256,password_hash,enabled) VALUES('pbx','b','a',lower(hex(randomblob(32))),?,1)").bind(hash).run();
 let sequence=0;
 const connect=secret=>mf.dispatchFetch('http://local/ws/asterisk/pbx?call=fresh-'+(++sequence),{headers:{Upgrade:'websocket',Authorization:'Basic '+Buffer.from('pbx:'+(secret||password)).toString('base64'),'CF-Connecting-IP':'192.0.2.'+sequence}});
 const stats=async()=> (await mf.dispatchFetch('http://local/stats')).json();
 const counters=()=>db.prepare('SELECT * FROM rate_counters ORDER BY bucket,window_start').all();
 const before=await counters();
 for(const quota of ['concurrency','daily']){
   await db.exec(quota==='concurrency'?"INSERT INTO calls(id,business_id,channel,environment,reserved_at,started_at) VALUES('prior','b','telnyx','live',datetime('now'),datetime('now','-2 days'))":"INSERT INTO calls(id,business_id,status,environment,carrier_released_at) VALUES('prior','b','completed','live',datetime('now'))");
   for(let i=0;i<4;i++)assert.equal((await connect()).status,403,quota);
   assert.deepEqual(await stats(),{writes:0,contacts:0});
   assert.deepEqual((await counters()).results,before.results);
   await db.exec("DELETE FROM calls WHERE id='prior'");
 }
 await mf.dispatchFetch('http://local/refill');
 for(let i=0;i<16;i++)assert.equal((await connect()).status,200);
 assert.equal((await connect()).status,429);
 assert.deepEqual(await stats(),{writes:0,contacts:16});
 assert.deepEqual((await counters()).results,before.results);
 await mf.dispatchFetch('http://local/refill');
 await db.exec('UPDATE asterisk_routes SET enabled=0');
 assert.equal((await connect()).status,401);
 assert.deepEqual(await stats(),{writes:0,contacts:16});
 console.log(JSON.stringify({result:'PASS',runtime:'actual workerd/PBKDF2/D1',owner:'stubbed dispatch',cases:['8 fresh quota refusals without owner identity or D1 writes','16 accepted forwards then local429','revoked401'],rateWriteAttempts:0,counterRowsUnchanged:true,AI:'none',PBX:'none'}));
} finally {await mf?.dispose();}
