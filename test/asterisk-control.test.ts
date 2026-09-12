import { AsteriskAuthBudget, asteriskAuthBudget } from '../src/asterisk-auth-budget';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../src/auth';
import { AsteriskCall } from '../src/asterisk-control';
import { ASTERISK_ADMISSION_HEADER, asteriskAdmissionVersion, authenticateAsterisk } from '../src/asterisk-routes';
import { applyMigrations, SqliteD1 } from './sqlite-d1';
import worker from '../src/index';
import { fakeEnv, fakeCtx } from './fake-d1';
import type { Env } from '../src/types';
let db: SqliteD1;
let env: Env;
let admission: string;
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
  failAlarmAt=0;alarmWrites=0;
  async setAlarm(time:number){if(++this.alarmWrites===this.failAlarmAt)throw Error('alarm outage');this.alarm=time;}
  async deleteAlarm(){this.check('deleteAlarm');this.alarm=null;}
}
function owner(storage=new Storage()) {
  return {storage,object:new AsteriskCall({storage,waitUntil:()=>{}} as unknown as DurableObjectState,env)};
}
async function expire(live:ReturnType<typeof owner>){if(live.storage.data.has('cleanup'))await live.storage.put('cleanup',1);await live.object.alarm();}
const request=()=>new Request(`https://internal/media?call=${call}&route=pbx`,{headers:{Upgrade:'websocket',[ASTERISK_ADMISSION_HEADER]:admission}});
beforeEach(async()=>{
  const budget=new AsteriskAuthBudget();vi.spyOn(asteriskAuthBudget,'acquire').mockImplementation(()=>budget.acquire());
  db=new SqliteD1();applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused');
    INSERT INTO businesses(id,user_id,slug,name,max_concurrent_calls,max_calls_per_day) VALUES('biz','owner','biz','Business',1,2);
    INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language,engine,realtime_model) VALUES('assistant','biz','assistant','active','Alex','Helpful','en','realtime','gpt-realtime-2');`);
  await db.prepare("INSERT INTO asterisk_routes(id,business_id,assistant_id,password_sha256,enabled,password_hash) VALUES('pbx','biz','assistant',lower(hex(randomblob(32))),1,?)").bind(await hashPassword(password)).run();
  admission=await asteriskAdmissionVersion('pbx',(await db.prepare('SELECT business_id,assistant_id,password_hash FROM asterisk_routes').first())! as {business_id:string;assistant_id:string;password_hash:string});
  env={...fakeEnv(undefined as never),DB:db as unknown as D1Database,ASTERISK_ENABLED:'true',REALTIME_BASE_URL:'wss://realtime.example.invalid/v1/realtime',REALTIME_MODEL:'gpt-realtime-2',REALTIME_API_KEY:'synthetic-only'};
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();db.close();});
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
    await expire(recovered);expect((await db.prepare('SELECT status FROM calls WHERE id=?').bind(call).first<{status:string}>())?.status).toBe('failed');
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
    await expire(failed);marker(failed.storage);
    db.exec('DELETE FROM calls');
    const restarted=owner(failed.storage);expect((await restarted.object.fetch(request())).status).toBe(409);
    await restarted.object.alarm();marker(failed.storage);
    expect(await db.prepare('SELECT COUNT(*) n FROM calls').first()).toEqual({n:0});
  });
  it('recovers an admission query error before retiring its identifying state',async()=>{
    db.hook=sql=>{if(sql.includes('SELECT a.engine'))throw Error('admission outage');};
    const failed=owner();expect((await failed.object.fetch(request())).status).toBe(503);
    expect(failed.storage.data.get('call')).toBe(call);expect(failed.storage.alarm).toBeTruthy();
    db.hook=null;await expire(failed);marker(failed.storage);
  });
  it('does not compact before terminal D1 projection succeeds',async()=>{
    const failed=owner();await failed.object.fetch(request());
    await failed.storage.put('cleanup',1);const retained=structuredClone([...failed.storage.data]);
    db.hook=sql=>{if(sql.includes("failure_code=COALESCE"))throw Error('projection outage');};
    await expect(expire(failed)).rejects.toThrow('projection outage');
    expect([...failed.storage.data]).toEqual(retained);expect(failed.storage.alarm).toBeGreaterThan(Date.now());
    db.hook=null;await expire(failed);marker(failed.storage);
  });
  for(const step of ['put','delete','deleteAlarm','commit']) it(`retains recovery state and alarm on compaction transaction ${step} failure`,async()=>{
    const failed=owner();await failed.object.fetch(request());
    await failed.storage.put('deadline',Date.now()+10000);
    await failed.storage.put('cleanup',1);const retained=structuredClone([...failed.storage.data]);failed.storage.failTransactionAt=step;
    await expect(expire(failed)).rejects.toThrow('transaction '+step);
    expect([...failed.storage.data]).toEqual(retained);expect(failed.storage.alarm).toBeGreaterThan(Date.now());
    failed.storage.failTransactionAt='';await expire(owner(failed.storage));marker(failed.storage);
  });
  it('keeps a recovery alarm when rejection compaction fails',async()=>{
    env.REALTIME_API_KEY='';const rejected=owner();rejected.storage.failTransactionAt='delete';
    expect((await rejected.object.fetch(request())).status).toBe(503);
    expect(rejected.storage.data.get('call')).toBe(call);expect(rejected.storage.alarm).toBeGreaterThan(Date.now());
    rejected.storage.failTransactionAt='';await expire(rejected);marker(rejected.storage);
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
    await legacy.object.alarm();await expire(legacy);marker(legacy.storage);
  });
  it('late queued finish cannot resurrect a retired owner',async()=>{
    const failed=owner();await failed.object.fetch(request());await expire(failed);
    await (failed.object as unknown as {finish(call:string,reason:string):Promise<void>}).finish(call,'late_close');
    marker(failed.storage);
  });
});


describe('Asterisk startup connection boundary',()=>{
  function deferred<T>(){
    let resolve!:(value:T)=>void;
    const promise=new Promise<T>(r=>{resolve=r;});
    return {promise,resolve};
  }
  function pendingSession(){
    const response=deferred<Response>(), opened=deferred<void>();
    const fetch=vi.fn(()=>{opened.resolve();return response.promise;});
    env.CALL_SESSION={idFromName:()=>call,get:()=>({fetch})} as unknown as DurableObjectNamespace;
    return {fetch,opened:opened.promise,resolve:response.resolve};
  }
  const waitOpening=async(upstream:ReturnType<typeof pendingSession>,result:Promise<Response>)=>{
    // Authentication performs real asynchronous crypto. Observe the operation,
    // rather than assuming any number of event-loop turns means it completed.
    await Promise.race([upstream.opened,result.then(response=>{throw Error(`startup returned ${response.status} before session fetch`);})]);
    expect(upstream.fetch).toHaveBeenCalledTimes(1);
  };
  const row=()=>db.prepare('SELECT status,outcome,connected_at,carrier_released_at,failure_code FROM calls WHERE id=?').bind(call).first<Record<string,unknown>>();
  it('alarm progresses during stalled session upgrade and rejects/closes late installation',async()=>{
    const upstream=pendingSession(), live=owner();const result=live.object.fetch(request());await waitOpening(upstream,result);
    expect((await row())?.connected_at).toBeNull();
    await live.object.alarm();
    expect(await row()).toMatchObject({status:'failed',outcome:'failed',connected_at:null,failure_code:'asterisk_start_failed'});
    expect((await row())?.carrier_released_at).toBeTruthy();
    const socket={accept:vi.fn(),close:vi.fn()};upstream.resolve({status:101,webSocket:socket} as unknown as Response);
    expect((await result).status).toBe(409);expect(socket.close).toHaveBeenCalledTimes(1);
    await expire(live);expect([...live.storage.data]).toEqual([['retired',true]]);
  });
  it('bounds startup to ten seconds, releases capacity, and closes a socket arriving after timeout',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const upstream=pendingSession(), live=owner();const result=live.object.fetch(request());await waitOpening(upstream,result);
    await vi.advanceTimersByTimeAsync(10000);expect((await result).status).toBe(503);
    expect(await row()).toMatchObject({status:'failed',outcome:'failed',connected_at:null});expect((await row())?.carrier_released_at).toBeTruthy();
    const socket={accept:vi.fn(),close:vi.fn()};upstream.resolve({status:101,webSocket:socket} as unknown as Response);
    await Promise.resolve();await Promise.resolve();expect(socket.close).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });
  it('waits for delayed admission validation before starting the upstream timeout',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const entered=deferred<void>(), release=deferred<void>();
    const digest=crypto.subtle.digest.bind(crypto.subtle);
    const auth=vi.spyOn(crypto.subtle,'digest').mockImplementation(async(algorithm,data)=>{
      entered.resolve();await release.promise;return digest(algorithm,data);
    });
    const upstream=pendingSession(), live=owner();const result=live.object.fetch(request());
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(60000);
      expect(upstream.fetch).not.toHaveBeenCalled();
      expect(await row()).toBeNull();expect(vi.getTimerCount()).toBe(0);
      release.resolve();await waitOpening(upstream,result);
      expect(await row()).toMatchObject({status:'active',connected_at:null});
      await vi.advanceTimersByTimeAsync(9999);
      expect((await row())?.status).toBe('active');
      await vi.advanceTimersByTimeAsync(1);
      expect((await result).status).toBe(503);
      expect(await row()).toMatchObject({status:'failed',connected_at:null});
      expect((await row())?.carrier_released_at).toBeTruthy();
    } finally {
      release.resolve();upstream.resolve(new Response(null,{status:503}));
      await result;auth.mockRestore();
    }
  });
  it('projects unready failure even if ordinary CallSession close finalized first',async()=>{
    db.exec(`INSERT INTO calls(id,business_id,assistant_id,channel,status,environment,outcome) VALUES('${call}','biz','assistant','asterisk','completed','live','answered')`);
    const live=owner();await live.storage.put('call',call);
    await (live.object as unknown as {finish(call:string,reason:string):Promise<void>}).finish(call,'invalid_carrier_frame');
    expect(await row()).toMatchObject({status:'failed',outcome:'failed',connected_at:null,failure_code:'asterisk_start_failed'});
  });
});

describe('Asterisk cleanup grace and terminal classification',()=>{
  const finish=(live:ReturnType<typeof owner>,reason:string)=>(live.object as unknown as {finish(call:string,reason:string):Promise<void>}).finish(call,reason);
  const seed=()=>db.exec(`INSERT INTO calls(id,business_id,assistant_id,channel,environment,reserved_at,connected_at) VALUES('${call}','biz','assistant','asterisk','live',datetime('now'),datetime('now'))`);
  const row=()=>db.prepare('SELECT status,outcome,failure_code,failure_message,ended_at,carrier_released_at FROM calls WHERE id=?').bind(call).first<Record<string,unknown>>();
  it('queued early alarm preserves normal call and rearms exact future cleanup deadline',async()=>{
    seed();const live=owner();await live.storage.put('call',call);await finish(live,'socket_closed');
    const cleanup=live.storage.data.get('cleanup');
    await live.object.alarm();
    expect(live.storage.alarm).toBe(cleanup);expect(live.storage.data.has('retired')).toBe(false);
    expect(await row()).toMatchObject({status:'active',failure_code:null});
    db.exec("UPDATE calls SET status='completed',outcome='answered'");
    await expire(live);expect(await row()).toMatchObject({status:'completed',outcome:'answered',failure_code:null});
  });
  it('failed final alarm write and failed early rearm retain grace and recovery state',async()=>{
    seed();const live=owner();await live.storage.put('call',call);live.storage.failAlarmAt=2;
    await expect(finish(live,'playback_complete')).rejects.toThrow('alarm outage');
    const cleanup=live.storage.data.get('cleanup') as number;
    expect(live.storage.alarm).toBeLessThan(cleanup);
    live.storage.failAlarmAt=4;await expect(live.object.alarm()).rejects.toThrow('alarm outage');
    expect(live.storage.data.get('cleanup')).toBe(cleanup);expect(live.storage.data.has('retired')).toBe(false);
    expect(await row()).toMatchObject({status:'active',failure_code:null});
    live.storage.failAlarmAt=0;await live.object.alarm();expect(live.storage.alarm).toBe(cleanup);
    await expire(live);expect(await row()).toMatchObject({status:'failed',failure_code:'asterisk_session_lost'});
  });
  for(const reason of ['invalid_carrier_frame','invalid_session_frame','playback_error','playback_overflow','drain_timeout','session_error','socket_error','readiness_projection_failed'])
    it(`records connected ${reason} even when generic completion wins first`,async()=>{
      seed();db.exec("UPDATE calls SET status='completed',outcome='answered'");const live=owner();await live.storage.put('call',call);
      await finish(live,reason);await finish(live,'socket_closed');
      expect(await row()).toMatchObject({status:'failed',outcome:'failed',failure_code:`asterisk_${reason}`,failure_message:'The telephone audio connection failed.'});
      expect((await row())?.ended_at).toBeTruthy();expect((await row())?.carrier_released_at).toBeTruthy();
      db.exec("UPDATE calls SET status='completed',outcome='answered',failure_code=NULL WHERE status='active'");
      expect((await row())?.status).toBe('failed');
    });
  for(const reason of ['socket_closed','session_ended','playback_complete'])it(`preserves normal connected ${reason}`,async()=>{
    seed();const live=owner();await live.storage.put('call',call);await finish(live,reason);
    expect(await row()).toMatchObject({status:'active',failure_code:null,failure_message:null});
    db.exec("UPDATE calls SET status='completed',outcome='answered' WHERE status='active'");
    await finish(live,reason);expect(await row()).toMatchObject({status:'completed',outcome:'answered',failure_code:null});
  });
  it('preserves existing provider failure metadata',async()=>{
    seed();db.exec("UPDATE calls SET status='failed',outcome='failed',failure_code='provider_error',failure_message='Provider failed'");
    await finish(owner(),'session_error');expect(await row()).toMatchObject({status:'failed',failure_code:'provider_error',failure_message:'Provider failed'});
  });
});

 it('owner recovery preserves an already completed connected call',async()=>{
   db.exec(`INSERT INTO calls(id,business_id,assistant_id,channel,status,environment,connected_at,outcome) VALUES('${call}','biz','assistant','asterisk','completed','live',datetime('now'),'answered')`);
   const live=owner();await live.storage.put('call',call);await live.object.alarm();
   expect(await db.prepare('SELECT status,outcome,failure_code FROM calls WHERE id=?').bind(call).first()).toEqual({status:'completed',outcome:'answered',failure_code:null});
 });

describe('Asterisk established socket close codes',()=>{
  class Socket {
    readyState=1;binaryType='arraybuffer';listeners=new Map<string,((event:unknown)=>void)[]>();
    accept(){} send(){} close(){this.readyState=3;}
    addEventListener(type:string,fn:(event:unknown)=>void){this.listeners.set(type,[...(this.listeners.get(type)||[]),fn]);}
    emit(type:string,event:unknown){for(const fn of this.listeners.get(type)||[])fn(event);}
  }
  for(const side of ['carrier','session'])for(const code of [1000,1005,1011,1006])
    it(`${side} close ${code} preserves normal completion or projects abnormal failure`,async()=>{
      db.exec(`INSERT INTO calls(id,business_id,assistant_id,channel,environment,reserved_at) VALUES('${call}','biz','assistant','asterisk','live',datetime('now'))`);
      const live=owner(),session=new Socket();let carrier!:Socket;
      vi.stubGlobal('WebSocketPair',class {0=new Socket();1=carrier=new Socket();});
      const NativeResponse=Response;
      vi.stubGlobal('Response',class extends NativeResponse {constructor(body:null,init:ResponseInit & {webSocket?:unknown}){super(null);Object.defineProperty(this,'status',{value:init.status});Object.defineProperty(this,'webSocket',{value:init.webSocket});}});
      const control=live.object as unknown as {install(call:string,response:Response):Promise<Response>;pending:Promise<unknown>};
      await live.storage.put('call',call);
      try {
        expect((await control.install(call,{status:101,webSocket:session} as unknown as Response)).status).toBe(101);
        carrier.emit('message',{data:JSON.stringify({event:'MEDIA_START',connection_id:'fixture',channel:'fixture',format:'ulaw',optimal_frame_size:160,ptime:20})});
        session.emit('message',{data:JSON.stringify({type:'ready',mode:'realtime',greeting:''})});await control.pending;
        const selected=side==='carrier'?carrier:session;selected.emit('close',{code});await control.pending;
        const row=await db.prepare('SELECT status,outcome,connected_at,carrier_released_at,failure_code FROM calls WHERE id=?').bind(call).first<Record<string,unknown>>();
        expect(row?.connected_at).toBeTruthy();expect(row?.carrier_released_at).toBeTruthy();
        if(code===1000 || code===1005){
          expect(row).toMatchObject({status:'active',failure_code:null});
          db.exec("UPDATE calls SET status='completed',outcome='answered' WHERE status='active'");
        } else expect(row).toMatchObject({status:'failed',outcome:'failed',failure_code:'asterisk_socket_error'});
        await expire(live);expect([...live.storage.data]).toEqual([['retired',true]]);
        expect((await db.prepare('SELECT status FROM calls WHERE id=?').bind(call).first())?.status).toBe(code===1000 || code===1005?'completed':'failed');
      } finally {carrier?.emit('close',{code:1000});session.emit('close',{code:1000});await control.pending;}
    });
});

it('credential rotation after the fresh owner check cannot reserve against the changed route',async()=>{
  let changed=false;
  db.hook=sql=>{if(!changed && sql.includes('SELECT a.engine')){changed=true;db.exec("UPDATE asterisk_routes SET password_hash='rotated'");}};
  expect((await owner().object.fetch(request())).status).toBe(403);
  expect(await db.prepare('SELECT COUNT(*) n FROM calls').first()).toEqual({n:0});
});
