import { AsteriskAuthBudget, asteriskAuthBudget } from '../src/asterisk-auth-budget';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { hashPassword, verifyPassword } from '../src/auth';
import { asteriskDigest, authenticateAsterisk } from '../src/asterisk-routes';
import { applyMigrations, SqliteD1 } from './sqlite-d1';
import { fakeEnv, fakeCtx } from './fake-d1';
import worker from '../src/index';
import type { Env } from '../src/types';
let db:SqliteD1,env:Env;
const password='a'.repeat(32), authorization='Basic '+btoa('pbx:'+password);
const migration=(name:string)=>db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
beforeEach(()=>{
  const budget=new AsteriskAuthBudget();vi.spyOn(asteriskAuthBudget,'acquire').mockImplementation(()=>budget.acquire());
  db=new SqliteD1();applyMigrations(db,1,9);migration('0010_provider_capabilities.sql');migration('0011_asterisk_inbound.sql');
  db.exec("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'); INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','biz','Business'); INSERT INTO assistants(id,business_id,public_slug) VALUES('assistant','biz','public')");
  env={...fakeEnv(undefined as never),DB:db as unknown as D1Database,ASTERISK_ENABLED:'true'};
});
afterEach(()=>{vi.restoreAllMocks();db.close();});
const provision=async()=>{
  migration('0014_asterisk_credentials.sql');
  const hash=await hashPassword(password);
  await db.prepare("INSERT INTO asterisk_routes(id,business_id,assistant_id,password_sha256,enabled,password_hash) VALUES('pbx','biz','assistant',lower(hex(randomblob(32))),1,?)").bind(hash).run();
  return hash;
};
it('migration preserves route assignments and revocation, discards legacy verifiers and requires reprovisioning',async()=>{
  const old=await asteriskDigest(password);
  for(const [id,enabled] of [['pbx',1],['revoked',0]])await db.prepare("INSERT INTO asterisk_routes VALUES(?,'biz','assistant',?,?)").bind(id,old,enabled).run();
  migration('0014_asterisk_credentials.sql');
  const rows=(await db.prepare('SELECT * FROM asterisk_routes ORDER BY id').all<Record<string,unknown>>()).results;
  expect(rows).toHaveLength(2);
  for(const row of rows){expect(row).toMatchObject({business_id:'biz',assistant_id:'assistant',enabled:0,password_hash:null});expect(row.password_sha256).not.toBe(old);}
  expect(await authenticateAsterisk(env,'pbx',authorization)).toBe(false);
  expect(()=>db.exec("UPDATE asterisk_routes SET enabled=1 WHERE id='pbx'")).toThrow();
  await db.prepare("UPDATE asterisk_routes SET password_hash=?,enabled=1 WHERE id='pbx'").bind(await hashPassword(password)).run();
  expect(await authenticateAsterisk(env,'pbx',authorization)).toBe(true);
  expect((await db.prepare("SELECT enabled FROM asterisk_routes WHERE id='revoked'").first())?.enabled).toBe(0);
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
it('rejects legacy fast digest even if it matches the presented password',async()=>{
  await provision();const digest=await asteriskDigest(password);
  await db.prepare('UPDATE asterisk_routes SET password_hash=?,password_sha256=?').bind(digest,digest).run();
  expect(await authenticateAsterisk(env,'pbx',authorization)).toBe(false);
});
it('uses independently salted KDF verifiers and validates correct/wrong credentials without writes',async()=>{
  const first=await provision(),second=await hashPassword(password);expect(first).not.toBe(second);
  expect(first.split(':').map(x=>atob(x).length)).toEqual([16,32]);
  const writes:string[]=[];db.hook=sql=>{if(!sql.startsWith('SELECT'))writes.push(sql);};
  expect(await authenticateAsterisk(env,'pbx',authorization)).toBe(true);
  for(const value of [null,'Basic !!!','Basic '+btoa('other:'+password),'Basic '+btoa('pbx:'+'b'.repeat(32))])expect(await authenticateAsterisk(env,'pbx',value)).toBe(false);
  expect(writes).toEqual([]);
});
it('revocation and rotation during KDF verification prevent admission',async()=>{
  await provision();
  const derive=crypto.subtle.deriveBits.bind(crypto.subtle);
  for(const update of ["UPDATE asterisk_routes SET enabled=0", "UPDATE asterisk_routes SET password_hash='invalidated'"]){
    await db.prepare('UPDATE asterisk_routes SET enabled=1,password_hash=?').bind(await hashPassword(password)).run();
    const spy=vi.spyOn(crypto.subtle,'deriveBits').mockImplementation(async(...args)=>{db.exec(update);return derive(...args);});
    expect(await authenticateAsterisk(env,'pbx',authorization)).toBe(false);spy.mockRestore();
  }
});
it('public unauthorized handshakes make zero D1 writes and authorized requests still dispatch',async()=>{
  await provision();const fetch=vi.fn(async()=>new Response(null,{status:204}));
  env.ASTERISK_CALL={idFromName:(id:string)=>id,get:()=>({fetch})} as unknown as DurableObjectNamespace;
  const writes:string[]=[];db.hook=sql=>{if(!sql.startsWith('SELECT'))writes.push(sql);};
  const request=(auth:string)=>new Request('https://local.test/ws/asterisk/pbx?call=fixture',{headers:{Upgrade:'websocket',Authorization:auth}});
  expect((await worker.fetch(request('Basic '+btoa('pbx:'+'b'.repeat(32))),env,fakeCtx)).status).toBe(401);
  expect(writes).toEqual([]);expect(fetch).not.toHaveBeenCalled();
  expect((await worker.fetch(request(authorization),env,fakeCtx)).status).toBe(204);expect(fetch).toHaveBeenCalledTimes(1);expect(writes).toHaveLength(1);
});
it('stdin provisioning produces helper-compatible salted verifiers without echoing the password',async()=>{
  const provision=()=>execFileSync(process.execPath,['scripts/asterisk-credential.mjs'],{input:password+'\n',encoding:'utf8'}).trim();
  const first=provision(),second=provision();expect(first).not.toBe(second);expect(first).not.toContain(password);
  expect(await verifyPassword(password,first)).toBe(true);expect(await verifyPassword('wrong',first)).toBe(false);
});

it('rejects non-ASCII provisioning and authentication rather than accepting ambiguous Basic encoding',async()=>{
  const unicode='é'.repeat(32);
  const result=spawnSync(process.execPath,['scripts/asterisk-credential.mjs'],{input:unicode,encoding:'utf8'});
  expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(result.stderr).not.toContain(unicode);
  await provision();await db.prepare('UPDATE asterisk_routes SET password_hash=?').bind(await hashPassword(unicode)).run();
  for(const encoded of [btoa('pbx:'+unicode),Buffer.from('pbx:'+unicode,'utf8').toString('base64')]){
    expect(await authenticateAsterisk(env,'pbx','Basic '+encoded)).toBe(false);
  }
});
it('bounds known-route KDF starts without attacker-indexed state or D1 writes',async()=>{
  await provision();const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);
  const derive=vi.spyOn(crypto.subtle,'deriveBits').mockResolvedValue(new ArrayBuffer(32));const statements:string[]=[];db.hook=sql=>statements.push(sql);
  for(let i=0;i<100;i++)expect(await authenticateAsterisk(env,'pbx','Basic '+btoa('pbx:'+'b'.repeat(32)))).toBe(false);
  expect(derive).toHaveBeenCalledTimes(16);expect(statements).toHaveLength(16);
  expect(statements.every(sql=>sql.startsWith('SELECT'))).toBe(true);
});
it('bounds concurrent checks before lookup across arbitrary route names and releases after errors',async()=>{
  await provision();let unblock!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{unblock=r;}),entered=new Promise<void>(r=>{started=r;});
  const original=crypto.subtle.deriveBits.bind(crypto.subtle);let count=0;
  const spy=vi.spyOn(crypto.subtle,'deriveBits').mockImplementation(async(...args)=>{if(++count===4)started();await gate;return original(...args);});
  const checks=Array.from({length:4},()=>authenticateAsterisk(env,'pbx',authorization));
  try{
    await entered;const reads:string[]=[];db.hook=sql=>reads.push(sql);
    for(let i=0;i<100;i++)expect(await authenticateAsterisk(env,'route'+i,'Basic '+btoa('route'+i+':'+password))).toBe(false);
    expect(reads).toEqual([]);expect(count).toBe(4);
  }finally{unblock();await Promise.all(checks);spy.mockRestore();}
  db.hook=()=>{throw Error('lookup outage');};await expect(authenticateAsterisk(env,'pbx',authorization)).rejects.toThrow('lookup outage');
  db.hook=null;expect(await authenticateAsterisk(env,'pbx',authorization)).toBe(true);
  const failure=vi.spyOn(crypto.subtle,'deriveBits').mockRejectedValueOnce(Error('KDF outage'));
  await expect(authenticateAsterisk(env,'pbx',authorization)).rejects.toThrow('KDF outage');failure.mockRestore();
  expect(await authenticateAsterisk(env,'pbx',authorization)).toBe(true);
});
it('refills at two starts per second without clock rollback credit or double-release capacity',()=>{
  let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now);const budget=new AsteriskAuthBudget();
  const held=Array.from({length:4},()=>budget.acquire()!);expect(budget.acquire()).toBeNull();
  held[0]();held[0]();const fifth=budget.acquire()!;expect(budget.acquire()).toBeNull();
  fifth();for(const release of held.slice(1))release();
  for(let i=0;i<11;i++)budget.acquire()!();expect(budget.acquire()).toBeNull();
  now=500;expect(budget.acquire()).toBeNull();now=1499;expect(budget.acquire()).toBeNull();
  now=1500;budget.acquire()!();expect(budget.acquire()).toBeNull();
  now=100000;for(let i=0;i<16;i++)budget.acquire()!();expect(budget.acquire()).toBeNull();
});
it('disabled carrier skips the budget, lookup and KDF',async()=>{
  await provision();env.ASTERISK_ENABLED='false';const reads:string[]=[];db.hook=sql=>reads.push(sql);
  expect(await authenticateAsterisk(env,'pbx',authorization)).toBe(false);expect(reads).toEqual([]);expect(asteriskAuthBudget.acquire).not.toHaveBeenCalled();
});
it('rejects configuration syntax in helper and authenticator',async()=>{
  await provision();
  for(const symbol of [';', '#', '=', '\\', '"', '[', ']', ':']){
    const secret='a'.repeat(32)+symbol;
    const result=spawnSync(process.execPath,['scripts/asterisk-credential.mjs'],{input:secret,encoding:'utf8'});
    expect(result.status).toBe(1);expect(result.stdout).toBe('');
    await db.prepare('UPDATE asterisk_routes SET password_hash=?').bind(await hashPassword(secret)).run();
    expect(await authenticateAsterisk(env,'pbx','Basic '+btoa('pbx:'+secret))).toBe(false);
  }
  const safe='AZaz09_-'.repeat(4),result=spawnSync(process.execPath,['scripts/asterisk-credential.mjs'],{input:safe,encoding:'utf8'});
  expect(result.status).toBe(0);expect(await verifyPassword(safe,result.stdout.trim())).toBe(true);
});
