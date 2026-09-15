import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { syncLegacyKnowledge } from '../src/studio-api';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

const migration = readFileSync(new URL('../migrations/0021_knowledge_tenant_guards.sql', import.meta.url), 'utf8');
const guards = ['knowledge_item_tenant_insert', 'knowledge_item_tenant_update', 'knowledge_attachment_tenant_insert', 'knowledge_attachment_tenant_update'];
const original = process.env.OPENFON_TENANT_ORIGINAL === '1';
let db: SqliteD1;
let env: Env;
const sql = (s: string) => db.exec(s);
function snapshot() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
const schema = () => db.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const count = (bucket = 'knowledge:b1') => (db.database.prepare('SELECT COALESCE(SUM(count),0) AS n FROM rate_counters WHERE bucket=?').get(bucket) as { n: number }).n;
function applyAtomic(text = migration) {
  sql('BEGIN IMMEDIATE');
  try { sql(text); sql('COMMIT'); } catch (e) { sql('ROLLBACK'); throw e; }
}
function dropGuards() { for (const name of guards) sql(`DROP TRIGGER IF EXISTS ${name}`); }
async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', token = 's1') {
  return worker.fetch(new Request('https://openfon.test' + path, {
    method, headers: { Cookie: `ofs=${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}
beforeEach(async () => {
  db = new SqliteD1(); applyMigrations(db, 1, 20);
  sql(`INSERT INTO users(id,email,password_hash) VALUES('u1','one@example.invalid','unused'),('u2','two@example.invalid','unused');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('s1','u1','2099-01-01'),('s2','u2','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('b1','u1','one','One'),('b2','u2','two','Two');
    INSERT INTO agent_settings(business_id) VALUES('b1'),('b2');
    INSERT INTO provider_settings(business_id) VALUES('b1'),('b2');`);
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: '', DEFAULT_LLM_MODEL: 'instance',
    DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: '', DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser',
    REALTIME_BASE_URL: 'wss://instance.example/realtime', REALTIME_MODEL: 'kataleptic-realtime' } as unknown as Env;
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  expect((await request('/api/me/bootstrap', undefined, 'GET', 's2')).status).toBe(200);
  sql(`INSERT INTO assistants(id,business_id,public_slug) VALUES('a1','b1','extra-one'),('a2','b2','extra-two');
    INSERT INTO knowledge_collections(id,business_id,name) VALUES('c1','b1','One'),('cnext','b1','Next'),('c2','b2','Two');
    INSERT INTO knowledge_items(id,business_id,collection_id,kind,title) VALUES('i1','b1','c1','note','Original');
    INSERT INTO assistant_knowledge_collections(assistant_id,collection_id) VALUES('a1','c1');`);
  if (!original) applyAtomic();
});
afterEach(() => db.close());

const mismatches = [
  ['item insert', "INSERT INTO knowledge_items(id,business_id,collection_id,kind) VALUES('bad','b1','c2','note')"],
  ['item OR IGNORE', "INSERT OR IGNORE INTO knowledge_items(id,business_id,collection_id,kind) VALUES('bad','b1','c2','note')"],
  ['item collection update', "UPDATE knowledge_items SET collection_id='c2',title='Lost' WHERE id='i1'"],
  ['attachment insert', "INSERT INTO assistant_knowledge_collections VALUES('a1','c2',datetime('now'))"],
  ['attachment OR IGNORE', "INSERT OR IGNORE INTO assistant_knowledge_collections VALUES('a1','c2',datetime('now'))"],
  ['attachment assistant update', "UPDATE assistant_knowledge_collections SET assistant_id='a2' WHERE assistant_id='a1' AND collection_id='c1'"],
  ['attachment collection update', "UPDATE assistant_knowledge_collections SET collection_id='c2' WHERE assistant_id='a1' AND collection_id='c1'"],
] as const;
it.each(mismatches)('tenant guard refuses %s without persisted side effects', (name, statement) => {
  const before = snapshot(); let error = '';
  try { sql(statement); } catch (e) { error = String(e); }
  const after = snapshot();
  console.log('tenant-sql-diagnostic', JSON.stringify({ name, original, error, before, after }));
  expect(error).toContain('OPENFON_KNOWLEDGE_TENANT_MISMATCH');
  expect(after).toEqual(before);
});

it.each([
  "INSERT INTO knowledge_items(id,business_id,collection_id,kind) VALUES('bad','b1','missing','note')",
  "INSERT INTO assistant_knowledge_collections(assistant_id,collection_id) VALUES('missing','c1')",
  "INSERT INTO assistant_knowledge_collections(assistant_id,collection_id) VALUES('a1','missing')",
])('guard explicitly refuses a missing parent: %s', statement => {
  const before = snapshot(); expect(() => sql(statement)).toThrow('OPENFON_KNOWLEDGE_TENANT_MISMATCH'); expect(snapshot()).toEqual(before);
});

it.each([
  ['item mismatch', "INSERT INTO knowledge_items(id,business_id,collection_id,kind) VALUES('corrupt','b1','c2','note')"],
  ['missing collection for item', "INSERT INTO knowledge_items(id,business_id,collection_id,kind) VALUES('corrupt','b1','missing','note')"],
  ['attachment mismatch', "INSERT INTO assistant_knowledge_collections(assistant_id,collection_id) VALUES('a1','c2')"],
  ['missing assistant', "INSERT INTO assistant_knowledge_collections(assistant_id,collection_id) VALUES('missing','c1')"],
  ['missing collection for attachment', "INSERT INTO assistant_knowledge_collections(assistant_id,collection_id) VALUES('a1','missing')"],
])('upgrade refuses %s before any DDL or repair', (_name, corrupt) => {
  dropGuards();
  // Deliberate privileged-corruption fixture, not an untrusted HTTP producer.
  sql('PRAGMA foreign_keys=OFF'); sql(corrupt); sql('PRAGMA foreign_keys=ON');
  const before = snapshot(), beforeSchema = schema();
  expect(() => applyAtomic()).toThrow(/malformed JSON/);
  expect(schema()).toEqual(beforeSchema); expect(snapshot()).toEqual(before);
});

it('clean upgrade preserves all data counters source references and installs four guards', () => {
  dropGuards();
  sql("INSERT INTO calls(id,business_id,status) VALUES('call','b1','completed'); INSERT INTO call_turns(id,call_id,role,text) VALUES(1,'call','caller','Question'); UPDATE knowledge_items SET source_call_id='call',source_turn_id=1 WHERE id='i1'");
  const before = snapshot(); applyAtomic(); expect(snapshot()).toEqual(before);
  const names = (db.database.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map(x => x.name);
  expect(guards.filter(x => names.includes(x))).toEqual(guards);
});
it('late migration failure rolls back installed DDL through caller transaction rollback', () => {
  dropGuards(); const before = snapshot(), beforeSchema = schema();
  expect(() => applyAtomic(migration + "\nSELECT json('SYNTHETIC_LATE_MIGRATION_FAILURE');")).toThrow(/malformed JSON/);
  expect(schema()).toEqual(beforeSchema); expect(snapshot()).toEqual(before);
});
it('ABORT preserves preceding transaction statements until caller explicitly rolls back', () => {
  const before = snapshot(); sql('BEGIN');
  try {
    sql("UPDATE businesses SET name='Earlier transaction write' WHERE id='b1'"); const afterEarlier = snapshot();
    expect(() => sql(mismatches[0][1])).toThrow('OPENFON_KNOWLEDGE_TENANT_MISMATCH');
    expect(snapshot()).toEqual(afterEarlier); expect(snapshot()).not.toEqual(before);
  } finally { sql('ROLLBACK'); }
  expect(snapshot()).toEqual(before);
});
it.each(['existing order', 'budget recreated last'])('statement refusal removes quota effects with %s', ordering => {
  if (ordering === 'budget recreated last') {
    const trigger = db.database.prepare("SELECT sql FROM sqlite_master WHERE name='knowledge_insert_budget'").get() as { sql: string };
    sql('DROP TRIGGER knowledge_insert_budget'); sql(trigger.sql);
  }
  const before = snapshot(); expect(() => sql(mismatches[0][1])).toThrow('OPENFON_KNOWLEDGE_TENANT_MISMATCH'); expect(snapshot()).toEqual(before);
});
it('valid move charges once and duplicate attachment has no new charge', () => {
  const spent = count(); sql("UPDATE knowledge_items SET collection_id='cnext' WHERE id='i1'"); expect(count()).toBe(spent + 1);
  const before = snapshot(); sql("INSERT OR IGNORE INTO assistant_knowledge_collections(assistant_id,collection_id) VALUES('a1','c1')"); expect(snapshot()).toEqual(before);
});
it('validation SELECTs preserve immediately gated changes chains for zero and accepted writes', async () => {
  const before = snapshot();
  await db.batch([db.prepare("UPDATE assistants SET name='No match' WHERE id='missing'"), db.prepare("INSERT OR IGNORE INTO assistant_knowledge_collections SELECT 'a1','cnext',datetime('now') WHERE changes()>0")]);
  expect(snapshot()).toEqual(before); const spent = count('assistants:b1');
  await db.batch([db.prepare("UPDATE assistants SET name='Accepted' WHERE id='a1'"), db.prepare("INSERT OR IGNORE INTO assistant_knowledge_collections SELECT 'a1','cnext',datetime('now') WHERE changes()>0")]);
  expect(db.database.prepare("SELECT 1 FROM assistant_knowledge_collections WHERE assistant_id='a1' AND collection_id='cnext'").get()).toBeTruthy(); expect(count('assistants:b1')).toBe(spent + 1);
});
it('late invalid attachment rolls back earlier batch row and counter writes', async () => {
  const before = snapshot();
  await expect(db.batch([db.prepare("UPDATE knowledge_items SET title='Earlier batch write' WHERE id='i1'"), db.prepare(mismatches[3][1])])).rejects.toThrow('OPENFON_KNOWLEDGE_TENANT_MISMATCH');
  expect(snapshot()).toEqual(before);
});
it.each(['call', 'turn'])('source %s deletion keeps SET NULL working at exhausted edit quota', target => {
  sql("INSERT INTO calls(id,business_id,status) VALUES('call','b1','completed'); INSERT INTO call_turns(id,call_id,role,text) VALUES(1,'call','caller','Question'); UPDATE knowledge_items SET source_call_id='call',source_turn_id=1 WHERE id='i1'; UPDATE rate_counters SET count=500 WHERE bucket='knowledge:b1'");
  sql(target === 'call' ? "DELETE FROM calls WHERE id='call'" : 'DELETE FROM call_turns WHERE id=1');
  expect(db.database.prepare("SELECT source_call_id,source_turn_id FROM knowledge_items WHERE id='i1'").get()).toEqual({ source_call_id: target === 'call' ? null : 'call', source_turn_id: null }); expect(count()).toBe(500);
});
it('parent ownership remains immutable and legitimate collection cascade deletion succeeds', () => {
  const before = snapshot();
  expect(() => sql("UPDATE knowledge_collections SET business_id='b2' WHERE id='c1'")).toThrow();
  expect(() => sql("UPDATE assistants SET business_id='b2' WHERE id='a1'")).toThrow(); expect(snapshot()).toEqual(before);
  sql("DELETE FROM knowledge_collections WHERE id='c1'");
  expect(db.database.prepare("SELECT 1 FROM knowledge_items WHERE id='i1'").get()).toBeUndefined();
  expect(db.database.prepare("SELECT 1 FROM assistant_knowledge_collections WHERE collection_id='c1'").get()).toBeUndefined();
});

it('API item creation derives ownership and ignores supplied foreign identities', async () => {
  const response = await request('/api/me/knowledge/collections/c1/items', { id: 'forged', business_id: 'b2', collection_id: 'c2', source_call_id: 'foreign', kind: 'note', content: 'Owned' });
  expect(response.status).toBe(201); const item = await response.json() as any;
  expect(item).toMatchObject({ business_id: 'b1', collection_id: 'c1', source_call_id: null }); expect(item.id).not.toBe('forged');
});
it('API rejects foreign item moves attachments and turn sources without writes', async () => {
  const before = snapshot();
  expect((await request('/api/me/knowledge/items/i1', { collection_id: 'c2' }, 'PUT')).status).toBe(404);
  expect((await request('/api/me/assistants/a1/knowledge-collections/c2', {})).status).toBe(404);
  expect((await request('/api/me/knowledge/collections/c2/items', { kind: 'note' })).status).toBe(404);
  expect((await request('/api/me/knowledge/drafts/from-turn', { callId: 'foreign', turnId: 999, collectionId: 'c1' })).status).toBe(404);
  expect(snapshot()).toEqual(before);
});
it('API rejects cross-workspace moves and attachments for one historical owner', async () => {
  // Model a pre0008 duplicate-workspace account without changing API ownership.
  const trigger = db.database.prepare("SELECT sql FROM sqlite_master WHERE name='businesses_one_workspace_per_user_update'").get() as { sql: string };
  sql('DROP TRIGGER businesses_one_workspace_per_user_update');
  sql("UPDATE businesses SET user_id='u1' WHERE id='b2'"); sql(trigger.sql);
  const before = snapshot();
  expect((await request('/api/me/knowledge/items/i1', { collection_id: 'c2' }, 'PUT')).status).toBe(404);
  expect((await request('/api/me/assistants/a1/knowledge-collections/c2', {})).status).toBe(404);
  expect(snapshot()).toEqual(before);
});
it('API item CAS conflict retains committed peer edit without a second charge', async () => {
  let afterPeer: ReturnType<typeof snapshot> | null = null;
  db.hook = statement => {
    if (statement.includes('UPDATE knowledge_items SET collection_id=')) { db.hook = null; sql("UPDATE knowledge_items SET title='Peer' WHERE id='i1'"); afterPeer = snapshot(); }
  };
  expect((await request('/api/me/knowledge/items/i1', { content: 'Stale edit' }, 'PUT')).status).toBe(409); expect(afterPeer).not.toBeNull(); expect(snapshot()).toEqual(afterPeer);
});
it('API accepted assistant creation and explicit attachment retain atomic default attachment', async () => {
  const response = await request('/api/me/assistants', { name: 'New draft', engine: 'pipeline' }); expect(response.status).toBe(201);
  const assistant = await response.json() as any;
  const attached = db.database.prepare('SELECT collection_id FROM assistant_knowledge_collections WHERE assistant_id=?').all(assistant.id);
  expect(attached).toEqual([{ collection_id: 'kc_default_b1' }]);
  expect((await request(`/api/me/assistants/${assistant.id}/knowledge-collections/cnext`, {})).status).toBe(200);
});
it('API legacy projection and missing-default repair preserve same-tenant relationships', async () => {
  expect((await request('/api/me/business/b1', { faqs_json: '[{"q":"Hours?","a":"Weekdays"}]' }, 'PUT')).status).toBe(200);
  sql("DELETE FROM knowledge_collections WHERE id='kc_default_b1'");
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  expect(db.database.prepare("SELECT business_id,collection_id,question FROM knowledge_items WHERE kind='faq'").all()).toEqual([{ business_id: 'b1', collection_id: 'kc_default_b1', question: 'Hours?' }]);
  expect(db.database.prepare("SELECT 1 FROM assistant_knowledge_collections WHERE assistant_id='asst_b1' AND collection_id='kc_default_b1'").get()).toBeTruthy();
});
it('API valid caller-turn draft preserves source identities and private state', async () => {
  sql("INSERT INTO calls(id,business_id,status) VALUES('call','b1','completed'); INSERT INTO call_turns(id,call_id,role,text) VALUES(1,'call','caller','Question')");
  const response = await request('/api/me/knowledge/drafts/from-turn', { callId: 'call', turnId: 1, collectionId: 'c1' }); expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ business_id: 'b1', collection_id: 'c1', source_call_id: 'call', source_turn_id: 1, status: 'draft' });
});
it('legacy helper invalid destination rolls back earlier source write and snapshot chain', async () => {
  const before = snapshot();
  await expect(syncLegacyKnowledge(env, { id: 'b1', services_json: '[]', faqs_json: '[{"q":"Injected","a":"Invalid destination"}]' }, 'c2', { services: false, faqs: true }, [db.prepare("UPDATE businesses SET name='Earlier source write' WHERE id='b1'")])).rejects.toThrow('OPENFON_KNOWLEDGE_TENANT_MISMATCH');
  expect(snapshot()).toEqual(before);
});
