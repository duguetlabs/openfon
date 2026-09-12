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
  failTransactionAt='';
  inTransaction=false;
  check(step:string){if(this.inTransaction && this.failTransactionAt===step)throw Error('transaction '+step);}
  async put(key:string,value:unknown){this.check('put');this.data.set(key,value);}
  async delete(keys:string|string[]){this.check('delete');for(const key of typeof keys==='string'?[keys]:keys)this.data.delete(key);}
  async transaction<T>(run:(txn:Storage)=>Promise<T>){
    const txn=new Storage();txn.data=structuredClone(this.data);txn.alarm=this.alarm;
    txn.failTransactionAt=this.failTransactionAt;txn.inTransaction=true;
    const result=await run(txn);txn.check('commit');
    this.data=txn.data;this.alarm=txn.alarm;return result;
  }
  async setAlarm(time:number){this.alarm=time;}
  async deleteAlarm(){this.check('deleteAlarm');this.alarm=null;}
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
    expect([...recovered.storage.data]).toEqual([['retired',true]]);
  });
});


describe('Asterisk operational state retirement',()=>{
  const marker=(storage:Storage)=>{expect([...storage.data]).toEqual([['retired',true]]);expect(storage.alarm).toBeNull();};
  it('compacts a completed legacy call without altering its completed outcome',async()=>{
    db.exec(`INSERT INTO calls(id,business_id,assistant_id,channel,status,environment,connected_at,carrier_released_at) VALUES('${call}','biz','assistant','asterisk','completed','live',datetime('now'),datetime('now'))`);
    const completed=owner();
    for(const [key,value] of Object.entries({call,deadline:1,ending:'playback_complete',cleanup:1}))await completed.storage.put(key,value);
    await completed.object.alarm();marker(completed.storage);
    expect((await db.prepare('SELECT status FROM calls WHERE id=?').bind(call).first<{status:string}>())?.status).toBe('completed');
  });
  it('provider and quota rejections retain only the replay marker',async()=>{
    for(const rejection of ['provider','quota']){
      if(rejection==='provider')env.REALTIME_API_KEY='';
      else {env.REALTIME_API_KEY='synthetic';db.exec('UPDATE businesses SET max_concurrent_calls=0');}
      const rejected=owner();expect((await rejected.object.fetch(request())).status).toBe(403);marker(rejected.storage);
      expect((await owner(rejected.storage).object.fetch(request())).status).toBe(409);marker(rejected.storage);
    }
  });
  it('retires failed setup after projection and keeps replay protection without a D1 row',async()=>{
    const failed=owner();expect((await failed.object.fetch(request())).status).toBe(503);
    expect(failed.storage.data.get('call')).toBe(call);
    await failed.object.alarm();marker(failed.storage);
    db.exec('DELETE FROM calls');
    const restarted=owner(failed.storage);expect((await restarted.object.fetch(request())).status).toBe(409);
    await restarted.object.alarm();marker(failed.storage);
    expect(await db.prepare('SELECT COUNT(*) n FROM calls').first()).toEqual({n:0});
  });
  it('recovers an admission query error before retiring its identifying state',async()=>{
    db.hook=sql=>{if(sql.includes('SELECT a.engine'))throw Error('admission outage');};
    const failed=owner();expect((await failed.object.fetch(request())).status).toBe(503);
    expect(failed.storage.data.get('call')).toBe(call);expect(failed.storage.alarm).toBeTruthy();
    db.hook=null;await failed.object.alarm();marker(failed.storage);
  });
  it('does not compact before terminal D1 projection succeeds',async()=>{
    const failed=owner();await failed.object.fetch(request());
    const retained=structuredClone([...failed.storage.data]);
    db.hook=sql=>{if(sql.includes("failure_code=COALESCE"))throw Error('projection outage');};
    await expect(failed.object.alarm()).rejects.toThrow('projection outage');
    expect([...failed.storage.data]).toEqual(retained);expect(failed.storage.alarm).toBeGreaterThan(Date.now());
    db.hook=null;await failed.object.alarm();marker(failed.storage);
  });
  for(const step of ['put','delete','deleteAlarm','commit']) it(`retains recovery state and alarm on compaction transaction ${step} failure`,async()=>{
    const failed=owner();await failed.object.fetch(request());
    await failed.storage.put('deadline',Date.now()+10000);
    const retained=structuredClone([...failed.storage.data]);failed.storage.failTransactionAt=step;
    await expect(failed.object.alarm()).rejects.toThrow('transaction '+step);
    expect([...failed.storage.data]).toEqual(retained);expect(failed.storage.alarm).toBeGreaterThan(Date.now());
    failed.storage.failTransactionAt='';await owner(failed.storage).object.alarm();marker(failed.storage);
  });
  it('keeps a recovery alarm when rejection compaction fails',async()=>{
    env.REALTIME_API_KEY='';const rejected=owner();rejected.storage.failTransactionAt='delete';
    expect((await rejected.object.fetch(request())).status).toBe(503);
    expect(rejected.storage.data.get('call')).toBe(call);expect(rejected.storage.alarm).toBeGreaterThan(Date.now());
    rejected.storage.failTransactionAt='';await rejected.object.alarm();marker(rejected.storage);
  });
  it('initial transaction failure creates neither unarmed identity nor a D1 call',async()=>{
    const failed=owner();failed.storage.failTransactionAt='commit';
    expect((await failed.object.fetch(request())).status).toBe(503);
    expect([...failed.storage.data]).toEqual([]);expect(failed.storage.alarm).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) n FROM calls').first()).toEqual({n:0});
    failed.storage.failTransactionAt='';expect((await failed.object.fetch(request())).status).toBe(503);
    expect(failed.storage.data.get('call')).toBe(call); // retry reached setup
  });
  it('wakes a legacy rejected object with no alarm without admitting a replay',async()=>{
    const legacy=owner();await legacy.storage.put('call',call);
    expect((await legacy.object.fetch(request())).status).toBe(409);expect(legacy.storage.alarm).toBeTruthy();
    await legacy.object.alarm();await legacy.object.alarm();marker(legacy.storage);
  });
  it('late queued finish cannot resurrect a retired owner',async()=>{
    const failed=owner();await failed.object.fetch(request());await failed.object.alarm();
    await (failed.object as unknown as {finish(call:string,reason:string):Promise<void>}).finish(call,'late_close');
    marker(failed.storage);
  });
});
