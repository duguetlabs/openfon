import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reserveTelnyxCall, telnyxLocalCallId } from '../src/telnyx-admission';
import { SqliteD1, applyMigrations } from './sqlite-d1';
import { fakeEnv } from './fake-d1';
import type { Env } from '../src/types';
import type { TelnyxCallCorrelation } from '../src/telnyx-webhook';

const call: TelnyxCallCorrelation = { connectionId:'connection',callLegId:'leg',callSessionId:'session',callControlId:'control' };
const number='+12025550101';
let db: SqliteD1, env: Env, id: string;
const reserve=()=>reserveTelnyxCall(env,id,call,number,'synthetic caller');
const rows=()=>({calls:db.database.prepare('SELECT * FROM calls ORDER BY id').all(),links:db.database.prepare('SELECT * FROM telnyx_call_links ORDER BY call_id').all()});
const changes=()=>Number(db.database.prepare('SELECT total_changes() n').get()!.n);
function holdBatch(mutate:()=>void) {
  let before:ReturnType<typeof rows>, after:ReturnType<typeof rows>, delta=0, results:unknown;
  env.DB={prepare:(sql:string)=>db.prepare(sql),async batch(statements:Parameters<SqliteD1['batch']>[0]) {
    mutate();before=rows();const start=changes();
    const result=await db.batch(statements);after=rows();delta=changes()-start;results=result;
    return result;
  }} as unknown as D1Database;
  return ()=>({before,after,delta,results});
}
beforeEach(async()=>{
  db=new SqliteD1();applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'),('other-owner','other-owner@example.invalid','unused');
    INSERT INTO businesses(id,user_id,slug,name,max_concurrent_calls,max_calls_per_day) VALUES('biz','owner','biz','Fixture',5,100),('other-biz','other-owner','other-biz','Other',5,100);
    INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language,engine,realtime_model) VALUES
      ('assistant','biz','assistant','active','Alex','Helpful','en','realtime','gpt-realtime-2'),
      ('other','biz','other','active','Other','Helpful','en','realtime','gpt-realtime-2'),
      ('cross','other-biz','cross','active','Cross','Helpful','en','realtime','gpt-realtime-2');
    INSERT INTO provider_settings(business_id,realtime_provider,realtime_api_key) VALUES('biz','kataleptic','synthetic-workspace');
    INSERT INTO telnyx_number_routes VALUES('connection','+12025550101','biz','assistant',1);`);
  env={...fakeEnv(),DB:db as unknown as D1Database,REALTIME_BASE_URL:'wss://provider.invalid/v1/realtime',REALTIME_MODEL:'gpt-realtime-2',REALTIME_API_KEY:'synthetic-instance',DEFAULT_TTS_PROVIDER:'browser',AZURE_SPEECH_KEY:''};
  id=await telnyxLocalCallId(call);
});
afterEach(()=>db.close());

describe('Telnyx checked admission snapshot',()=>{
  it.each([
    ['provider key',"UPDATE provider_settings SET realtime_api_key='rotated'"],
    ['provider key removed',"UPDATE provider_settings SET realtime_api_key=''"],
    ['provider selection',"UPDATE provider_settings SET realtime_provider='custom',realtime_base_url='wss://custom.example.com/realtime'"],
    ['provider URL',"UPDATE provider_settings SET realtime_base_url='wss://other.example.com/realtime'"],
    ['provider deleted','DELETE FROM provider_settings'],
    ['engine',"UPDATE assistants SET engine='pipeline' WHERE id='assistant'"],
    ['model',"UPDATE assistants SET realtime_model='kataleptic-realtime-hd' WHERE id='assistant'"],
    ['voice',"UPDATE assistants SET realtime_voice='changed' WHERE id='assistant'"],
    ['route assistant',"UPDATE telnyx_number_routes SET assistant_id='other'"],
    ['route workspace',"UPDATE telnyx_number_routes SET business_id='other-biz',assistant_id='cross'"],
    ['route disabled','UPDATE telnyx_number_routes SET enabled=0'],
    ['assistant paused',"UPDATE assistants SET state='paused' WHERE id='assistant'"],
  ])('refuses a conflicting %s change before the batch',async(_name,sql)=>{
    const observation=holdBatch(()=>db.exec(sql));
    expect(await reserve()).toBe(false);
    expect(observation().after).toEqual(observation().before);expect(observation().delta).toBe(0);
    expect(rows()).toEqual({calls:[],links:[]});
  });
  it.each(['insert','delete'])('pins provider presence even with equivalent instance defaults: %s',async change=>{
    db.exec('DELETE FROM provider_settings');
    if(change==='delete')db.exec("INSERT INTO provider_settings(business_id) VALUES('biz')");
    const observation=holdBatch(()=>db.exec(change==='insert'?"INSERT INTO provider_settings(business_id) VALUES('biz')":'DELETE FROM provider_settings'));
    expect(await reserve()).toBe(false);expect(observation().delta).toBe(0);expect(rows()).toEqual({calls:[],links:[]});
  });
  it.each(['absent','instance','openai','custom'])('admits unchanged %s configuration once',async provider=>{
    db.exec('DELETE FROM provider_settings');
    if(provider==='instance')db.exec("INSERT INTO provider_settings(business_id) VALUES('biz')");
    if(provider==='openai')db.exec("INSERT INTO provider_settings(business_id,realtime_provider,realtime_api_key) VALUES('biz','openai','synthetic-direct'); UPDATE assistants SET realtime_model='',realtime_voice='alloy' WHERE id='assistant'");
    if(provider==='custom')db.exec("INSERT INTO provider_settings(business_id,realtime_provider,realtime_base_url,realtime_api_key) VALUES('biz','custom','wss://custom.example.com/realtime','synthetic-custom'); UPDATE assistants SET realtime_model='custom-model',realtime_voice='custom-voice' WHERE id='assistant'");
    expect(await reserve()).toBe(true);const saved=rows(),start=changes();
    expect(await reserve()).toBe(true);expect(rows()).toEqual(saved);expect(changes()).toBe(start);
    expect(saved.calls).toHaveLength(1);expect(saved.links).toHaveLength(1);
  });
  it.each([['gpt-realtime-2','alloy'],['gpt-realtime','custom-voice']])('refuses incompatible direct OpenAI %s/%s before batching',async(model,voice)=>{
    db.exec("UPDATE provider_settings SET realtime_provider='openai'");
    db.database.prepare("UPDATE assistants SET realtime_model=?,realtime_voice=? WHERE id='assistant'").run(model,voice);
    let batched=false;holdBatch(()=>{batched=true;});
    expect(await reserve()).toBe(false);expect(batched).toBe(false);expect(rows()).toEqual({calls:[],links:[]});
  });
  it('permits unrelated speech/text edits without freezing the entire provider row',async()=>{
    holdBatch(()=>db.exec("UPDATE provider_settings SET stt_model='unrelated',llm_model='unrelated'"));
    expect(await reserve()).toBe(true);expect(rows().calls).toHaveLength(1);
    db.exec("UPDATE assistants SET realtime_voice='later' WHERE id='assistant'");
    expect(db.database.prepare("SELECT realtime_voice FROM assistants WHERE id='assistant'").get()).toEqual({realtime_voice:'later'});
  });
  it('retains exact-link recovery after route/provider edits without new charge or writes',async()=>{
    expect(await reserve()).toBe(true);
    db.exec("UPDATE telnyx_number_routes SET enabled=0,assistant_id='other'; DELETE FROM provider_settings");
    const saved=rows(),start=changes();expect(await reserve()).toBe(true);
    expect(rows()).toEqual(saved);expect(changes()).toBe(start);
  });
  it.each(['callControlId','callSessionId','callLegId','connectionId'] as const)('does not report success for a mismatching existing %s',async field=>{
    expect(await reserve()).toBe(true);const saved=rows(),start=changes();
    expect(await reserveTelnyxCall(env,id,{...call,[field]:'different'},number,'caller')).toBe(false);
    expect(rows()).toEqual(saved);expect(changes()).toBe(start);
  });
  it('does not create a link when the reservation INSERT ignores a preexisting call',async()=>{
    db.database.prepare("INSERT INTO calls(id,business_id,assistant_id,channel,environment,reserved_at) VALUES(?,'biz','assistant','telnyx','live',datetime('now'))").run(id);
    const saved=rows(),start=changes();expect(await reserve()).toBe(false);
    expect(rows()).toEqual(saved);expect(changes()).toBe(start);
  });
  it.each(['concurrency','daily'])('keeps SQL-time %s quota refusal atomic',async quota=>{
    const observation=holdBatch(()=>{
      db.exec(quota==='concurrency'?"UPDATE businesses SET max_concurrent_calls=1 WHERE id='biz'":"UPDATE businesses SET max_calls_per_day=1 WHERE id='biz'");
      db.exec("INSERT INTO calls(id,business_id,channel,environment,reserved_at) VALUES('other-call','biz','telnyx','live',datetime('now'))");
    });
    expect(await reserve()).toBe(false);expect(observation().delta).toBe(0);expect(observation().after).toEqual(observation().before);
  });
  it('rolls the call INSERT back when the link statement fails, then permits one fresh retry',async()=>{
    const saved=rows();db.hook=sql=>{if(sql.includes('INSERT OR IGNORE INTO telnyx_call_links'))throw Error('synthetic link failure');};
    await expect(reserve()).rejects.toThrow('synthetic link failure');expect(rows()).toEqual(saved);
    db.hook=null;expect(await reserve()).toBe(true);expect(rows().calls).toHaveLength(1);expect(rows().links).toHaveLength(1);
  });
  it('does not infer admission from inflated driver change metadata',async()=>{
    env.DB={prepare:(sql:string)=>db.prepare(sql),async batch(statements:Parameters<SqliteD1['batch']>[0]){
      db.exec("UPDATE provider_settings SET realtime_api_key='changed'");
      return (await db.batch(statements)).map(result=>({...result,meta:{changes:100}}));
    }} as unknown as D1Database;
    expect(await reserve()).toBe(false);expect(rows()).toEqual({calls:[],links:[]});
  });
});
