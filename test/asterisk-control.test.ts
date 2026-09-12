import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AsteriskCall } from '../src/asterisk-control';
import { asteriskDigest, authenticateAsterisk } from '../src/asterisk-routes';
import { applyMigrations, SqliteD1 } from './sqlite-d1';
import worker from '../src/index';
import { fakeEnv, fakeCtx } from './fake-d1';
import type { Env } from '../src/types';
let db: SqliteD1;
let env: Env;
const password='synthetic-password-with-at-least-32-bytes';
const auth='Basic '+btoa('pbx:'+password);
const call='ast_'+'a'.repeat(64);
class Storage {
  data=new Map<string,unknown>();alarm: number|null=null;
  async get<T>(key:string){return this.data.get(key) as T|undefined;}
  async put(key:string,value:unknown){this.data.set(key,value);}
  async setAlarm(time:number){this.alarm=time;}
  async deleteAlarm(){this.alarm=null;}
}
function owner(storage=new Storage()) {
  return {storage,object:new AsteriskCall({storage,waitUntil:()=>{}} as unknown as DurableObjectState,env)};
}
const request=()=>new Request(`https://internal/media?call=${call}&route=pbx`,{headers:{Upgrade:'websocket',Authorization:auth}});
beforeEach(async()=>{
  db=new SqliteD1();applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused');
    INSERT INTO businesses(id,user_id,slug,name,max_concurrent_calls,max_calls_per_day) VALUES('biz','owner','biz','Business',1,2);
    INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language,engine,realtime_model) VALUES('assistant','biz','assistant','active','Alex','Helpful','en','realtime','gpt-realtime-2');`);
  await db.prepare("INSERT INTO asterisk_routes VALUES('pbx','biz','assistant',?,1)").bind(await asteriskDigest(password)).run();
  env={...fakeEnv(undefined as never),DB:db as unknown as D1Database,ASTERISK_ENABLED:'true',REALTIME_BASE_URL:'wss://realtime.example.invalid/v1/realtime',REALTIME_MODEL:'gpt-realtime-2',REALTIME_API_KEY:'synthetic-only'};
});
afterEach(()=>db.close());
describe('Asterisk authorization, admission and recovery',()=>{
  it('requires matching route identity and full secret; disabled routes revoke new calls',async()=>{
    expect(await authenticateAsterisk(env,'pbx',auth)).toBe(true);
    for(const value of [null,'Basic !!!','Bearer '+password,'Basic '+btoa('other:'+password),'Basic '+btoa('pbx:'+password+'x')]) expect(await authenticateAsterisk(env,'pbx',value)).toBe(false);
    await db.prepare('UPDATE asterisk_routes SET enabled=0').run();expect(await authenticateAsterisk(env,'pbx',auth)).toBe(false);
  });
  it('missing provider credentials reserve no call',async()=>{
    env.REALTIME_API_KEY='';env.DEFAULT_LLM_API_KEY='';
    expect((await owner().object.fetch(request())).status).toBe(403);
    expect(await db.prepare('SELECT COUNT(*) n FROM calls').first()).toEqual({n:0});
  });
  it('workspace OpenAI key admits without instance keys or explicit model',async()=>{
    env.REALTIME_API_KEY='';env.DEFAULT_LLM_API_KEY='';
    db.exec("INSERT INTO provider_settings(business_id,realtime_provider,realtime_api_key) VALUES('biz','openai','synthetic-only'); UPDATE assistants SET realtime_model=''");
    // Fake CallSession deliberately cannot upgrade; admission nevertheless occurred.
    expect((await owner().object.fetch(request())).status).toBe(503);
    expect(await db.prepare('SELECT COUNT(*) n FROM calls').first()).toEqual({n:1});
  });
  it('schema prevents assigning a route to a foreign workspace assistant',()=>{
    db.exec("INSERT INTO users(id,email,password_hash) VALUES('other-owner','other@example.invalid','unused'); INSERT INTO businesses(id,user_id,slug,name) VALUES('other','other-owner','other','Other')");
    expect(()=>db.exec("UPDATE asterisk_routes SET business_id='other'")).toThrow();
  });
  it('paused and pipeline assistants reserve no calls',async()=>{
    for(const sql of ["UPDATE assistants SET state='paused'","UPDATE assistants SET state='active',engine='pipeline'"]) {
      db.exec(sql);expect((await owner().object.fetch(request())).status).toBe(403);
      expect(await db.prepare('SELECT COUNT(*) n FROM calls').first()).toEqual({n:0});
    }
  });
  it('counts other carrier reservations against the workspace concurrency limit',async()=>{
    db.exec("INSERT INTO calls(id,business_id,assistant_id,channel,environment,reserved_at) VALUES('tnx_existing','biz','assistant','telnyx','live',datetime('now'))");
    expect((await owner().object.fetch(request())).status).toBe(403);
  });
  it('enforces daily limit even after prior calls complete',async()=>{
    db.exec("INSERT INTO calls(id,business_id,assistant_id,status,environment) VALUES('one','biz','assistant','completed','live'),('two','biz','assistant','completed','live')");
    expect((await owner().object.fetch(request())).status).toBe(403);
  });
  it('failed upstream setup releases the reservation and forbids replay after restart',async()=>{
    const first=owner();expect((await first.object.fetch(request())).status).toBe(503);
    const row=await db.prepare('SELECT status,carrier_released_at FROM calls WHERE id=?').bind(call).first<{status:string;carrier_released_at:string}>();
    expect(row?.status).toBe('failed');expect(row?.carrier_released_at).toBeTruthy();
    expect((await owner(first.storage).object.fetch(request())).status).toBe(409);
  });
  it('browser websocket route cannot attach to an admitted PBX call',async()=>{
    db.exec(`INSERT INTO calls(id,business_id,assistant_id,channel,environment,reserved_at) VALUES('${call}','biz','assistant','asterisk','live',datetime('now'))`);
    const response=await worker.fetch(new Request(`https://openfon.test/ws/call/${call}`,{headers:{Upgrade:'websocket'}}),env,fakeCtx);
    expect(response.status).toBe(404);
  });
  it('D1 outage during recovery retains a future alarm',async()=>{
    const recovered=owner();await recovered.storage.put('call',call);
    db.hook=()=>{throw Error('synthetic outage');};
    await expect(recovered.object.alarm()).rejects.toThrow('synthetic outage');
    expect(recovered.storage.alarm).toBeGreaterThan(Date.now());
  });
  it('alarm recovers an admitted owner lost before media attached, then retires lost session',async()=>{
    db.exec(`INSERT INTO calls(id,business_id,assistant_id,channel,environment,reserved_at,connected_at) VALUES('${call}','biz','assistant','asterisk','live',datetime('now'),datetime('now'))`);
    const recovered=owner();await recovered.storage.put('call',call);await recovered.object.alarm();
    expect((await db.prepare('SELECT carrier_released_at FROM calls WHERE id=?').bind(call).first<{carrier_released_at:string}>())?.carrier_released_at).toBeTruthy();
    await recovered.object.alarm();expect((await db.prepare('SELECT status FROM calls WHERE id=?').bind(call).first<{status:string}>())?.status).toBe('failed');
    expect(recovered.storage.alarm).toBeNull();
  });
});
