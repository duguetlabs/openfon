import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { applyMigrations, SqliteD1 } from './sqlite-d1';
import { fakeEnv, fakeCtx } from './fake-d1';
import type { Env } from '../src/types';
let db: SqliteD1;
let env: Env;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2026-09-10T12:00:00Z');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','biz','Business');
    INSERT INTO knowledge_collections(id,business_id,name) VALUES('one','biz','One'),('two','biz','Two');`);
  env = { ...fakeEnv(undefined as never), DB: db as unknown as D1Database };
});
afterEach(() => { db.close(); vi.useRealTimers(); });
function request(path: string, body: unknown, method = 'POST', token = 'session') {
  return worker.fetch(new Request('https://example.invalid'+path, { method, headers: { Cookie: `ofs=${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, fakeCtx);
}
const changes = () => db.database.prepare('SELECT total_changes() AS n').get();
function seed(id: string, content = '', collection = 'one') {
  db.database.prepare("INSERT INTO knowledge_items(id,business_id,collection_id,kind,status,content) VALUES(?,'biz',?,'note','draft',?)").run(id, collection, content);
}
it('enforces the cumulative item cap across collections and rejects without any writes', async () => {
  for (let i=0;i<500;i++) seed(`item-${i}`, '', i%2 ? 'one' : 'two');
  const before = changes();
  for (let i=0;i<5;i++) expect((await request('/api/me/knowledge/collections/two/items', { kind: 'note', content: 'new draft' })).status).toBe(409);
  expect(changes()).toEqual(before);
  expect(db.database.prepare("SELECT count(*) AS n FROM knowledge_items WHERE business_id='biz'").get()).toEqual({ n: 500 });
  // Deletion remains available, but deleting cannot replenish the daily write budget.
  db.exec("DELETE FROM knowledge_items WHERE id='item-0'");
  const afterDelete = changes();
  expect((await request('/api/me/knowledge/collections/one/items', { kind: 'note', content: 'replacement' })).status).toBe(429);
  expect(changes()).toEqual(afterDelete);
  vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
  expect((await request('/api/me/knowledge/collections/one/items', { kind: 'note', content: 'replacement' })).status).toBe(201);
});
it('counts UTF-8 bytes and permits shrinking at the byte boundary', async () => {
  const content = 'é'.repeat((2097152-4)/2); // note kind adds four bytes: exactly2MiB.
  seed('large', content);
  const before = changes();
  expect((await request('/api/me/knowledge/collections/two/items', { kind: 'note', content: 'x' })).status).toBe(409);
  expect((await request('/api/me/knowledge/items/large', { title: 'x' }, 'PUT')).status).toBe(409);
  expect((await request('/api/me/knowledge/items/large', { content: content+'x' }, 'PUT')).status).toBe(413); // request body limit is independently retained.
  expect(changes()).toEqual(before);
  expect((await request('/api/me/knowledge/items/large', { content: 'short' }, 'PUT')).status).toBe(200);
  expect((await request('/api/me/knowledge/collections/two/items', { kind: 'note', content: 'now fits' })).status).toBe(201);
});
it('refuses updates for a spent daily budget without mutation and isolates another workspace', async () => {
  seed('editable');
  db.exec("UPDATE rate_counters SET count=499 WHERE bucket='knowledge:biz'");
  expect((await request('/api/me/knowledge/items/editable', { content: 'last save' }, 'PUT')).status).toBe(200);
  const before = changes();
  expect((await request('/api/me/knowledge/items/editable', { content: 'must not persist' }, 'PUT')).status).toBe(429);
  expect(changes()).toEqual(before);
  expect(db.database.prepare("SELECT content FROM knowledge_items WHERE id='editable'").get()).toEqual({ content: 'last save' });
  db.exec("INSERT INTO users(id,email,password_hash) VALUES('other','other@example.invalid','unused'); INSERT INTO sessions(token,user_id,expires_at) VALUES('other-session','other','2026-09-10T12:00:00Z'); INSERT INTO businesses(id,user_id,slug,name) VALUES('other','other','other','Other'); INSERT INTO knowledge_collections(id,business_id,name) VALUES('other','other','Other');");
  expect((await request('/api/me/knowledge/collections/other/items', { kind: 'note', content: 'isolated' })).status).toBe(404);
  expect((await request('/api/me/knowledge/collections/other/items', { kind: 'note', content: 'isolated' }, 'POST', 'other-session')).status).toBe(201);
});
it('rolls back a batch that crosses the quota instead of leaving a partial import', async () => {
  seed('initial');
  db.exec("UPDATE rate_counters SET count=499 WHERE bucket='knowledge:biz'");
  await expect(db.batch(['a','b'].map(id => db.prepare("INSERT INTO knowledge_items(id,business_id,collection_id,kind,status) VALUES(?,'biz','one','note','draft')").bind(id)))).rejects.toThrow('OPENFON_KNOWLEDGE_WRITE_LIMIT');
  expect(db.database.prepare("SELECT count FROM rate_counters WHERE bucket='knowledge:biz'").get()).toEqual({ count: 499 });
  expect(db.database.prepare('SELECT count(*) AS n FROM knowledge_items').get()).toEqual({ n: 1 });
});
it('preserves oversized pre-migration knowledge and allows it to be shortened', () => {
  const legacy = new SqliteD1();
  try {
    applyMigrations(legacy, 1, 12);
    legacy.exec(`INSERT INTO users(id,email,password_hash) VALUES('owner','old@example.invalid','unused');
      INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','biz','Business');
      INSERT INTO knowledge_collections(id,business_id,name) VALUES('one','biz','One');`);
    const text = 'x'.repeat(2097152);
    legacy.database.prepare("INSERT INTO knowledge_items(id,business_id,collection_id,kind,status,content) VALUES('old','biz','one','note','draft',?)").run(text);
    applyMigrations(legacy, 13, 13);
    expect(legacy.database.prepare("SELECT length(CAST(content AS BLOB)) AS bytes FROM knowledge_items WHERE id='old'").get()).toEqual({ bytes: 2097152 });
    expect(() => legacy.exec("UPDATE knowledge_items SET content=content||'x' WHERE id='old'")).toThrow('OPENFON_KNOWLEDGE_STORAGE_LIMIT');
    legacy.exec("UPDATE knowledge_items SET content='short' WHERE id='old'");
    expect(legacy.database.prepare("SELECT content FROM knowledge_items WHERE id='old'").get()).toEqual({ content: 'short' });
  } finally { legacy.close(); }
});
it('counts embedded NUL bytes at the SQL boundary without a text round-trip', () => {
  seed('nul', 'é'.repeat((2097152-6)/2)+'\0x');
  const before = changes();
  expect(() => db.exec("UPDATE knowledge_items SET title='x' WHERE id='nul'")).toThrow('OPENFON_KNOWLEDGE_STORAGE_LIMIT');
  expect(changes()).toEqual(before);
  expect(db.database.prepare("SELECT length(CAST(content AS BLOB)) AS bytes FROM knowledge_items WHERE id='nul'").get()).toEqual({ bytes: 2097148 });
});
it('allows call-reference cleanup after the daily editing allowance is spent', () => {
  db.exec("INSERT INTO calls(id,business_id,status) VALUES('call','biz','completed'); INSERT INTO call_turns(id,call_id,role,text) VALUES(1,'call','caller','Question');");
  seed('linked');
  db.exec("UPDATE knowledge_items SET source_call_id='call',source_turn_id=1 WHERE id='linked'; UPDATE rate_counters SET count=500 WHERE bucket='knowledge:biz';");
  db.exec("DELETE FROM calls WHERE id='call'");
  expect(db.database.prepare("SELECT source_call_id,source_turn_id FROM knowledge_items WHERE id='linked'").get()).toEqual({ source_call_id: null, source_turn_id: null });
  expect(db.database.prepare("SELECT count FROM rate_counters WHERE bucket='knowledge:biz'").get()).toEqual({ count: 500 });
});
