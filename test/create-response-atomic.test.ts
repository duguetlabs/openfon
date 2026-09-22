import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

let db: SqliteD1;
let env: Env;
const responseSql = 'SELECT * FROM assistants WHERE id = ?';
const failedReadSql = "SELECT *, json('SYNTHETIC_RESPONSE_READ_FAILURE') AS injected_failure FROM assistants WHERE id = ?";
const isCreate = (sql: string) => sql.includes('INSERT INTO assistants (');
const snapshot = () => (db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
  .map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
const create = (body: unknown = { name: '  New draft  ' }) => worker.fetch(new Request('https://openfon.test/api/me/assistants', {
  method: 'POST', headers: { Cookie: 'ofs=session', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
const query = (sql: string) => db.database.prepare(sql).all();
beforeEach(async () => {
  db = new SqliteD1(); applyMigrations(db);
  db.exec("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'); INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01'); INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','owned','Owned'); INSERT INTO agent_settings(business_id) VALUES('biz'); INSERT INTO provider_settings(business_id) VALUES('biz');");
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: '', DEFAULT_LLM_MODEL: 'instance', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: '', DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime', REALTIME_MODEL: 'kataleptic-realtime-hd' } as unknown as Env;
  expect((await worker.fetch(new Request('https://openfon.test/api/me/bootstrap', { headers: { Cookie: 'ofs=session' } }), env, {} as ExecutionContext)).status).toBe(200);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

it.each([false, true])('response failure rolls back requested create before explicit retry (foundation repair=%s)', async repair => {
  if (repair) db.exec("DELETE FROM assistants; DELETE FROM provider_settings");
  const initial = snapshot(); let baseline: ReturnType<typeof snapshot> | undefined, insideRead: ReturnType<typeof snapshot> | undefined;
  let armed = true, readWasInBatch = false, inBatch = false;
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    if (sql === responseSql && armed) { armed = false; return prepare(failedReadSql); }
    return prepare(sql);
  });
  vi.spyOn(db, 'batch').mockImplementation(async statements => { inBatch = true; try { return await batch(statements); } finally { inBatch = false; } });
  db.hook = sql => {
    if (isCreate(sql) && !baseline) baseline = snapshot();
    if (sql === failedReadSql) { insideRead = snapshot(); readWasInBatch = inBatch; }
  };
  const failed = await create(); const afterFailure = snapshot();
  const retry = await create(); const retried = await retry.json() as { id: string };
  const afterRetry = snapshot();
  console.log('create-response-diagnostic', JSON.stringify({ repair, status: failed.status, retryStatus: retry.status, readWasInBatch, initial, baseline, insideRead, afterFailure, afterRetry, retryId: retried.id }));
  expect(failed.status).toBe(500); expect(baseline).toBeDefined(); expect(insideRead).toBeDefined();
  expect(afterFailure).toEqual(baseline); // Original first failure: requested draft/attachment/charge persisted.
  expect(readWasInBatch).toBe(true); expect(insideRead).not.toEqual(baseline);
  if (repair) expect(baseline).not.toEqual(initial); else expect(baseline).toEqual(initial);
  expect(retry.status).toBe(201);
  const assistantCharges = (state: ReturnType<typeof snapshot>) => (state.find(table => table.name === 'rate_counters')!.rows as { bucket: string; count: number }[])
    .filter(row => row.bucket === 'assistants:biz').reduce((total, row) => total + row.count, 0);
  expect(assistantCharges(afterRetry)).toBe(assistantCharges(baseline!) + 1);
  expect(query("SELECT id FROM assistants WHERE name='New draft'")).toEqual([{ id: retried.id }]);
  expect(query(`SELECT collection_id FROM assistant_knowledge_collections WHERE assistant_id='${retried.id}'`)).toEqual([{ collection_id: 'kc_default_biz' }]);
});

it('accepted create returns persisted defaults and has no post-batch response read', async () => {
  let inside = false, outsideResponseReads = 0;
  const batch = db.batch.bind(db);
  vi.spyOn(db, 'batch').mockImplementation(async statements => { inside = true; try { return await batch(statements); } finally { inside = false; } });
  db.hook = sql => { if (sql === responseSql && !inside) outsideResponseReads++; };
  const result = await create(); const row = await result.json() as { id: string };
  const persisted = db.database.prepare('SELECT * FROM assistants WHERE id=?').get(row.id);
  console.log('create-accepted-diagnostic', JSON.stringify({ status: result.status, outsideResponseReads, row, persisted }));
  expect(result.status).toBe(201); expect(row).toEqual(persisted);
  expect(row).toMatchObject({ business_id: 'biz', name: 'New draft', state: 'draft', engine: 'pipeline', persona: 'friendly and professional', language: 'en', take_messages: 1, activated_at: null });
  expect(row).toHaveProperty('created_at'); expect(row).toHaveProperty('updated_at'); expect(row).toHaveProperty('public_slug');
  expect(outsideResponseReads).toBe(0); // Original returns correct data through an avoidable separate read.
});

it('provider conflict retains first-result409 and gates attachment and response row', async () => {
  const sqls = new WeakMap<object, string>(); const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  let baseline: ReturnType<typeof snapshot> | undefined;
  vi.spyOn(db, 'prepare').mockImplementation(sql => { const statement = prepare(sql); sqls.set(statement, sql); return statement; });
  vi.spyOn(db, 'batch').mockImplementation(async statements => {
    if (statements.some(statement => isCreate(sqls.get(statement) || ''))) {
      db.exec("UPDATE provider_settings SET realtime_provider='custom' WHERE business_id='biz'"); baseline = snapshot();
    }
    return batch(statements);
  });
  const response = await create(); expect(response.status).toBe(409); expect(baseline).toBeDefined(); expect(snapshot()).toEqual(baseline);
});
it('late attachment execution failure rolls back requested row and quota', async () => {
  const before = snapshot(); let inserted = false;
  db.hook = sql => {
    if (sql.includes('INSERT OR IGNORE INTO assistant_knowledge_collections') && query("SELECT id FROM assistants WHERE name='New draft'").length) {
      inserted = true; db.database.prepare("SELECT json('SYNTHETIC_ATTACHMENT_FAILURE')").get();
    }
  };
  expect((await create()).status).toBe(500); expect(inserted).toBe(true); expect(snapshot()).toEqual(before);
});

it('batch rows retain one hook per statement order and trigger-inclusive changes', async () => {
  const calls: string[] = []; db.hook = sql => { calls.push(sql); };
  const statements = ["UPDATE assistants SET greeting='Hello' WHERE id='asst_biz'", "SELECT id,greeting FROM assistants WHERE id='asst_biz'"];
  const results = await db.batch(statements.map(sql => db.prepare(sql)));
  expect(calls).toEqual(statements); expect(results[0].meta.changes).toBe(2); expect(results[1].meta.changes).toBe(0);
  expect(results[1].results).toEqual([{ id: 'asst_biz', greeting: 'Hello' }]);
});
it('standalone run still discards result rows and invokes its hook once', async () => {
  const calls: string[] = []; db.hook = sql => { calls.push(sql); };
  const sql = 'SELECT 42 AS answer'; const result = await db.prepare(sql).run();
  expect(result.results).toEqual([]); expect(result.meta.changes).toBe(0); expect(calls).toEqual([sql]);
});
it('late batch SELECT execution failure rolls back preceding trigger charge', async () => {
  const before = snapshot(); let reached = false;
  db.hook = sql => { if (sql.includes('SYNTHETIC_LATE_SELECT')) { reached = true; expect(snapshot()).not.toEqual(before); } };
  await expect(db.batch([db.prepare("UPDATE assistants SET greeting='Rolled back' WHERE id='asst_biz'"), db.prepare("SELECT json('SYNTHETIC_LATE_SELECT') FROM assistants WHERE id='asst_biz'")])).rejects.toThrow(/malformed JSON/);
  expect(reached).toBe(true); expect(snapshot()).toEqual(before);
});
