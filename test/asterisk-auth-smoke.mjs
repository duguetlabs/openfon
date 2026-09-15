#!/usr/bin/env node
/** Actual workerd/PBKDF2 with a deterministic budget clock and test-only DB
 * adapter that rejects every write. No external provider/PBX/PSTN requests. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const root=fileURLToPath(new URL('../',import.meta.url)),password='synthetic_Auth_01234567890123456789';
const hash=execFileSync(process.execPath,['scripts/asterisk-credential.mjs'],{cwd:root,input:password,encoding:'utf8'}).trim();
const bundle=await build({stdin:{resolveDir:root,loader:'ts',contents:`
import { authenticateAsterisk } from './src/asterisk-routes';
let clock=Date.now(),reads=0,hold=true;Date.now=()=>clock;
const env={ASTERISK_ENABLED:'true',DB:{
 prepare(sql){
  if(!sql.startsWith('SELECT'))throw Error('write forbidden');
  return {bind(route){return {async first(){
   reads++;while(hold)await new Promise(resolve=>setTimeout(resolve,10));if(route!=='pbx')return null;
   return sql.includes('password_hash FROM')?{password_hash:${JSON.stringify(hash)}}:{id:'pbx'};
  }};}};
 }
}};
export default {async fetch(request){const url=new URL(request.url);
 if(url.pathname==='/stats')return Response.json({reads});
 if(url.pathname==='/release'){hold=false;return new Response(null,{status:204});}
 if(url.pathname==='/refill'){clock+=500;return new Response(null,{status:204});}
 const valid=await authenticateAsterisk(env,url.searchParams.get('route')||'pbx',request.headers.get('Authorization'));
 return new Response(null,{status:valid?204:401});
}};
`},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false});
let mf;
try{
 mf=new Miniflare(convertV4MiniflareOptions({cf:false,port:Number(process.env.OPENFON_TEST_PORT||8811),inspectorPort:Number(process.env.OPENFON_INSPECTOR_PORT||9251),workers:[{name:'auth-budget',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-01',outboundService:()=>{throw Error('External request forbidden');}}]}));
 await mf.ready;
 const send=(path,route='pbx',secret=password)=>mf.dispatchFetch('http://local.test'+path+'?route='+route,{headers:{Authorization:'Basic '+Buffer.from(route+':'+secret).toString('base64')}});
 const stats=async()=>(await send('/stats')).json();
 const held=Array.from({length:4},()=>send('/attempt'));
 try{
  const until=Date.now()+5000;while((await stats()).reads<4 && Date.now()<until)await new Promise(r=>setTimeout(r,10));
  assert.equal((await stats()).reads,4);
  for(let i=0;i<100;i++)assert.equal((await send('/attempt','route'+i)).status,401);
  assert.equal((await stats()).reads,4,'saturated concurrency rejects before lookup despite varying caller keys');
 }finally{await send('/release');}
 assert.deepEqual((await Promise.all(held)).map(x=>x.status),[204,204,204,204]);
 for(let i=0;i<100;i++)assert.equal((await send('/attempt','pbx','b'.repeat(32))).status,401);
 assert.equal((await stats()).reads,20,'four successful checks plus twelve wrong-password checks exhaust sixteen starts');
 await send('/refill');assert.equal((await send('/attempt')).status,204);
 assert.equal((await stats()).reads,22);assert.equal((await send('/attempt')).status,401);assert.equal((await stats()).reads,22);
 console.log('PASS actual-workerd auth budget: four concurrent lookups, sixteen starts shared across arbitrary caller keys, real PBKDF2 correct/wrong checks, refill at two/second; saturated checks do no reads/writes. Deterministic clock, test-only DB adapter, no external requests.');
}finally{await mf?.dispose();}
