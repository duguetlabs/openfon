import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {Hono} from 'hono';
import {SqliteD1,applyMigrations} from './sqlite-d1';
import {persistCallActions,registerManagedActions,businessWeekStart} from '../src/managed-actions';
import {registerManagedWebBoundary} from '../src/managed-web';
import type {Env} from '../src/types';
let db:SqliteD1;let env:Env;
beforeEach(()=>{db=new SqliteD1();applyMigrations(db);db.exec(`INSERT INTO users(id,email,password_hash)VALUES('u','u@test.invalid','hash'),('other','o@test.invalid','hash');INSERT INTO businesses(id,user_id,slug,name)VALUES('b','u','test','Test'),('other','other','other','Other');INSERT INTO calls(id,business_id,status,intent,message_json)VALUES('c','b','completed','booking','{"caller_name":"Ada","message":"Please call me"}'),('other','other','completed',null,null);`);db.exec(readFileSync(new URL('../migrations/0026_business_actions.sql',import.meta.url),'utf8'));env={DB:db,OPENFON_MANAGED_WEB:'true'} as unknown as Env;});
afterEach(()=>db.close());
function app(){const app=new Hono<{Bindings:Env;Variables:{userId:string}}>();app.use('*',async(c,next)=>{c.set('userId','u');await next();});registerManagedWebBoundary(app);registerManagedActions(app);return app;}
const get=(path:string)=>app().request(`http://local${path}`,{},env);
describe('Managed business actions',()=>{
 it('migrates one call into distinct request and message without claiming a confirmed booking',()=>{const rows=db.database.prepare('SELECT kind,content FROM action_items ORDER BY kind').all();expect(rows).toEqual([{kind:'booking_request',content:'Appointment requested'},{kind:'message',content:'Please call me'}]);expect(db.database.prepare("SELECT name,slug FROM businesses WHERE id='b'").get()).toEqual({name:'Test',slug:'test'});});
 it('repeated projection is idempotent and keeps handled status',async()=>{db.exec("UPDATE action_items SET status='handled' WHERE source_key='message'");await get('/api/me/actions?environment=all');await get('/api/me/actions?environment=all');expect(db.database.prepare('SELECT count(*) AS n FROM action_items').get()).toEqual({n:2});expect(db.database.prepare("SELECT status FROM action_items WHERE source_key='message'").get()).toEqual({status:'handled'});});
 it('multiple reordered extraction entries and duplicate slots do not overwrite acknowledged tasks',async()=>{const items=[{source_key:'todo_inventory',kind:'todo' as const,content:'Check inventory'},{source_key:'callback_customer',kind:'callback' as const,content:'Call Ada'}];await persistCallActions(env,'c',items);db.exec("UPDATE action_items SET status='handled' WHERE source_key='todo_inventory'");await persistCallActions(env,'c',[...items].reverse());await persistCallActions(env,'c',[{...items[0],content:'Stale revised content'},items[0]]);expect(db.database.prepare("SELECT content,status FROM action_items WHERE source_key='todo_inventory'").get()).toEqual({content:'Check inventory',status:'handled'});expect(db.database.prepare('SELECT count(*) AS n FROM action_items').get()).toEqual({n:4});});
 it('multiple same-kind caller actions survive reordered input while identical source/content deduplicates',async()=>{
  db.exec("INSERT INTO calls(id,business_id,status)VALUES('fresh','b','active')");
  const first={source_key:'first',source_turn_id:20,kind:'booking_request' as const,content:'Book an eye test'};
  const second={source_key:'second',source_turn_id:10,kind:'booking_request' as const,content:'Book a cleaning'};
  await persistCallActions(env,'fresh',[first,second,{...second,content:'  Book a cleaning  '}]);
  expect(db.database.prepare("SELECT count(*) AS n FROM action_items WHERE call_id='fresh'").get()).toEqual({n:2});
  expect((await(await get('/api/me/actions?environment=all')).json()).items.some((a:any)=>a.call_id==='fresh')).toBe(false);
  db.exec("UPDATE calls SET status='completed',intent='booking',summary='Two appointments requested' WHERE id='fresh'");
  expect(db.database.prepare("SELECT count(*) AS n FROM action_items WHERE call_id='fresh'").get()).toEqual({n:2});
  await persistCallActions(env,'fresh',[second,first,{...first,content:'A differently worded stale extraction'}]);
  expect(db.database.prepare("SELECT count(*) AS n FROM action_items WHERE call_id='fresh'").get()).toEqual({n:2});
 });
 it('maps the earliest caller source to a handled historical singleton and retains additional requests',async()=>{
  db.exec("UPDATE action_items SET status='handled' WHERE call_id='c' AND kind='booking_request'");
  await persistCallActions(env,'c',[{source_key:'later',source_turn_id:20,kind:'booking_request',content:'Second appointment'},{source_key:'earlier',source_turn_id:10,kind:'booking_request',content:'First appointment'}]);
  expect(db.database.prepare("SELECT status,content FROM action_items WHERE call_id='c' AND source_key='booking'").get()).toEqual({status:'handled',content:'Appointment requested'});
  expect(db.database.prepare("SELECT content FROM action_items WHERE call_id='c' AND kind='booking_request' AND source_key!='booking'").all()).toEqual([{content:'Second appointment'}]);
 });
 it('concurrent extraction completions admit one immutable snapshot',async()=>{
  db.exec("INSERT INTO calls(id,business_id,status)VALUES('race','b','active')");
  await Promise.all([persistCallActions(env,'race',[{source_key:'one',source_turn_id:1,kind:'todo',content:'Check stock'}]),persistCallActions(env,'race',[{source_key:'two',source_turn_id:1,kind:'todo',content:'Check the stock please'}])]);
  expect(db.database.prepare("SELECT count(*) AS n FROM action_items WHERE call_id='race'").get()).toEqual({n:1});
 });
 it('terminal legacy writers still generate fallback requests without structured extraction',()=>{
  db.exec("INSERT INTO calls(id,business_id,status)VALUES('fallback','b','active');UPDATE calls SET status='completed',intent='booking' WHERE id='fallback'");
  expect(db.database.prepare("SELECT kind FROM action_items WHERE call_id='fallback'").get()).toEqual({kind:'booking_request'});
 });
 it('never seals a partial invalid extraction but does seal a deliberate empty result',async()=>{
  db.exec("INSERT INTO calls(id,business_id,status)VALUES('invalid','b','active'),('empty','b','active')");
  await expect(persistCallActions(env,'invalid',[{source_key:'valid',kind:'todo',content:'Valid task'},{source_key:'bad:key',kind:'todo',content:'Invalid source key'}])).rejects.toThrow('Invalid extracted actions');
  expect(db.database.prepare("SELECT * FROM call_action_extractions WHERE call_id='invalid'").get()).toBeUndefined();
  await persistCallActions(env,'empty',[]);
  await persistCallActions(env,'empty',[{source_key:'late',kind:'todo',content:'Stale late task'}]);
  expect(db.database.prepare("SELECT count(*) AS n FROM action_items WHERE call_id='empty'").get()).toEqual({n:0});
 });
 it('database rejects linking an item to another workspace call',()=>{expect(()=>db.exec("INSERT INTO action_items(id,business_id,call_id,source_key,kind,content)VALUES('bad','b','other','bad','todo','bad')")).toThrow('action call must belong to business');});
 it('never reads or updates another account item',async()=>{await persistCallActions(env,'other',[{source_key:'private',kind:'todo',content:'Private'}]);const result=await(await get('/api/me/actions?environment=all')).json();expect(JSON.stringify(result)).not.toContain('Private');const res=await app().request('http://local/api/me/actions/action_other_private',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:'handled'})},env);expect(res.status).toBe(404);});
 it('handles status, urgency, due dates and invalid values explicitly',async()=>{const id='action_message_c';const route=app();const send=(body:unknown)=>route.request(`http://local/api/me/actions/${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)},env);expect((await send({status:'confirmed'})).status).toBe(400);expect((await send({urgent:1})).status).toBe(400);expect((await send({due_at:'invalid'})).status).toBe(400);expect((await send({status:'handled',urgent:true,due_at:'2026-10-05T10:00:00Z'})).status).toBe(200);expect(db.database.prepare('SELECT status,urgent FROM action_items WHERE id=?').get(id)).toEqual({status:'handled',urgent:1});});
 it('keeps private tests out of customer inbox by default',async()=>{db.exec("UPDATE calls SET environment='test' WHERE id='c'");expect((await(await get('/api/me/actions')).json()).items).toHaveLength(0);expect((await(await get('/api/me/actions?environment=test')).json()).items).toHaveLength(2);});
 it('computes Monday in the actual business timezone across DST',()=>{expect(businessWeekStart('Europe/Vienna',new Date('2026-10-25T14:00:00Z'))).toBe('2026-10-18T22:00:00.000Z');expect(businessWeekStart('Europe/Vienna',new Date('2026-10-26T14:00:00Z'))).toBe('2026-10-25T23:00:00.000Z');});
 it('deleting a call removes its linked items',()=>{db.exec("DELETE FROM calls WHERE id='c'");expect(db.database.prepare('SELECT count(*) AS n FROM action_items').get()).toEqual({n:0});});
});
describe('Managed customer response boundary',()=>{
 it.each(['/api/me/provider','/api/me/provider/catalog','/api/me/engine-presets','/api/me/call-summaries','/api/me/profiles/p/apply','/api/me/business/b/profiles','/api/me/business/b/agent'])('blocks technical route %s',async(path)=>{expect((await get(path)).status).toBe(404);});
 it('strips technical values while retaining installed iOS decoding shape',async()=>{const route=app();route.get('/api/me/assistants/a',c=>c.json({id:'a',greeting:'Hello',engine:'realtime',realtime_model:'private-model',realtime_voice:'cedar',voice:'old',llm_model:'private-text'}));const data=await(await route.request('http://local/api/me/assistants/a',{},env)).json();expect(data).toEqual({id:'a',greeting:'Hello',engine:'',realtime_voice:'',voice:'cedar'});});
 it('rejects customer routing writes before the handler executes',async()=>{let writes=0;const route=app();route.put('/api/me/assistants/a',c=>{writes++;return c.json({ok:true});});const res=await route.request('http://local/api/me/assistants/a',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({engine:'pipeline'})},env);expect(res.status).toBe(400);expect(writes).toBe(0);});
 it('sanitizes technical errors without replacing ordinary validation',async()=>{const route=app();route.get('/api/me/example',c=>c.json({error:'Azure model private-name failed'},502));const result=await(await route.request('http://local/api/me/example',{},env)).json();expect(result.error).toBe('This action could not complete. Please try again.');});
});
