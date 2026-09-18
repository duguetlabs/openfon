import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { applyMigrations, SqliteD1 } from './sqlite-d1';
import { fakeEnv, fakeCtx } from './fake-d1';
import type { Env } from '../src/types';
let db: SqliteD1;
let env: Env;
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2026-09-10T12:00:00Z');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES('biz','owner','biz','Business','Configured workspace');
    INSERT INTO agent_settings(business_id,agent_name,persona,language) VALUES('biz','Alex','Helpful','en');`);
  env = { ...fakeEnv(undefined as never), DB: db as unknown as D1Database };
  expect((await request('/api/me/bootstrap')).status).toBe(200);
});
afterEach(() => { db.close(); vi.useRealTimers(); });
function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', token = 'session') {
  return worker.fetch(new Request('https://example.invalid'+path, { method, headers: { Cookie: `ofs=${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) }), env, fakeCtx);
}
const changes = () => db.database.prepare('SELECT total_changes() AS n').get();
function seed(id:string, instructions='') {
  db.database.prepare("INSERT INTO assistants(id,business_id,public_slug,name,custom_instructions) VALUES(?,'biz',?,'Draft',?)").run(id,id,instructions);
}
it('caps assistant count atomically before writes or attachments and permits safe deletion', async () => {
  for(let i=0;i<31;i++)seed('draft-'+i);
  const before=changes();
  for(let i=0;i<3;i++) expect((await request('/api/me/assistants',{name:'Overflow'})).status).toBe(409);
  expect(changes()).toEqual(before);
  expect((await request('/api/me/assistants/draft-0',undefined,'DELETE','wrong')).status).toBe(401);
  expect((await request('/api/me/assistants/asst_biz',undefined,'DELETE')).status).toBe(409);
  expect((await request('/api/me/assistants/draft-0',undefined,'DELETE')).status).toBe(200);
  expect((await request('/api/me/assistants',{name:'Replacement'})).status).toBe(201);
});
it('bounds cumulative UTF8 config and permits shrinking without rewriting legacy oversized data', async () => {
  seed('large');
  const bytes=()=>Number((db.database.prepare(`SELECT SUM(length(CAST(id AS BLOB))+length(CAST(public_slug AS BLOB))+length(CAST(name AS BLOB))+length(CAST(greeting AS BLOB))+length(CAST(persona AS BLOB))+length(CAST(language AS BLOB))+length(CAST(voice AS BLOB))+length(CAST(custom_instructions AS BLOB))+length(CAST(engine AS BLOB))+length(CAST(realtime_model AS BLOB))+length(CAST(realtime_voice AS BLOB))+length(CAST(llm_model AS BLOB))) AS n FROM assistants`).get() as {n:number}).n);
  const room=1048576-bytes();
  db.database.prepare("UPDATE assistants SET custom_instructions=? WHERE id='large'").run('é'.repeat(Math.floor(room/2))+'x'.repeat(room%2));
  expect(bytes()).toBe(1048576);const before=changes();
  expect((await request('/api/me/assistants',{name:'Too large'})).status).toBe(409);
  expect((await request('/api/me/assistants/large',{greeting:'x'},'PUT')).status).toBe(409);
  expect(changes()).toEqual(before);
  expect((await request('/api/me/assistants/large',{custom_instructions:'short'},'PUT')).status).toBe(200);
});
it('refuses daily updates and compatibility saves atomically, without charging refused requests', async () => {
  seed('draft');db.exec("UPDATE rate_counters SET count=200 WHERE bucket='assistants:biz'");
  const before=changes();
  expect((await request('/api/me/assistants/draft',{name:'Rejected'},'PUT')).status).toBe(429);
  expect((await request('/api/me/assistants',{name:'Rejected'})).status).toBe(429);
  expect(changes()).toEqual(before);
  const legacy=await db.prepare("SELECT * FROM agent_settings WHERE business_id='biz'").first();
  expect((await request('/api/me/business/biz/agent',{agent_name:'Rejected'},'PUT')).status).toBe(429);
  expect(await db.prepare("SELECT * FROM agent_settings WHERE business_id='biz'").first()).toEqual(legacy);
  expect((await request('/api/me/assistants/draft',undefined,'DELETE')).status).toBe(200);
  expect((await request('/api/me/assistants',{name:'Still refused'})).status).toBe(429);
  vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
  expect((await request('/api/me/assistants',{name:'New day'})).status).toBe(201);
});
it('rolls back a concurrent-boundary batch and keeps other workspaces independent', async () => {
  seed('draft');db.exec("UPDATE rate_counters SET count=199 WHERE bucket='assistants:biz'");
  await expect(db.batch([
    db.prepare("UPDATE assistants SET name='first' WHERE id='draft'"),
    db.prepare("UPDATE assistants SET name='second' WHERE id='draft'"),
  ])).rejects.toThrow('OPENFON_ASSISTANT_WRITE_LIMIT');
  expect(await db.prepare("SELECT name FROM assistants WHERE id='draft'").first()).toEqual({name:'Draft'});
  expect(await db.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:biz'").first()).toEqual({count:199});
  db.exec("INSERT INTO users(id,email,password_hash) VALUES('other-owner','other@example.invalid','unused'); INSERT INTO businesses(id,user_id,slug,name) VALUES('other','other-owner','other','Other'); INSERT INTO assistants(id,business_id,public_slug) VALUES('other','other','other')");
  expect(await db.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:other'").first()).toEqual({count:1});
});
it('keeps old large/many assistants out of bootstrap and paginates bounded list previews', async () => {
  db.exec('DROP TRIGGER assistant_insert_budget; DROP TRIGGER assistant_update_budget;');
  for(let i=0;i<40;i++)seed('old-'+String(i).padStart(2,'0'),'x'.repeat(128000));
  const response=await request('/api/me/bootstrap');expect(response.status).toBe(200);
  const text=await response.text();expect(text.length).toBeLessThan(20000);
  const parsed=JSON.parse(text);expect(parsed.assistants).toHaveLength(32);expect(parsed.assistants[0].public_slug).toBe('biz');
  expect(parsed.assistants.every((x:object)=>!('custom_instructions' in x)&&!('greeting' in x))).toBe(true);
  const first=await (await request('/api/me/assistants')).json() as Array<{id:string}>;
  const second=await (await request('/api/me/assistants?offset=32')).json() as Array<{id:string}>;
  expect(first).toHaveLength(32);expect(second).toHaveLength(9);expect(new Set([...first,...second].map(x=>x.id)).size).toBe(41);
});
it('retains call history and prevents deleting live or routed assistants', async () => {
  seed('draft');db.exec("INSERT INTO calls(id,business_id,assistant_id,status) VALUES('call','biz','draft','active')");
  expect((await request('/api/me/assistants/draft',undefined,'DELETE')).status).toBe(409);
  db.exec("UPDATE calls SET status='completed' WHERE id='call'");
  expect((await request('/api/me/assistants/draft',undefined,'DELETE')).status).toBe(200);
  expect(await db.prepare("SELECT assistant_id FROM calls WHERE id='call'").first()).toEqual({assistant_id:null});
  seed('routed');db.exec("INSERT INTO asterisk_routes(id,business_id,assistant_id,password_sha256,enabled) VALUES('pbx','biz','routed',lower(hex(randomblob(32))),0)");
  expect((await request('/api/me/assistants/routed',undefined,'DELETE')).status).toBe(409);
});
