import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

type Lane = 'create' | 'put' | 'delete';
let db: SqliteD1, env: Env;
const root = '/api/me/knowledge/collections';
const requested = (lane: Lane, sql: string) => lane === 'create'
  ? sql.startsWith('INSERT INTO knowledge_collections (id, business_id, name, description)')
  : lane === 'put' ? sql.startsWith('UPDATE knowledge_collections SET name=')
  : sql.startsWith('DELETE FROM knowledge_collections WHERE id');
const rows = (sql: string) => db.database.prepare(sql).all() as Record<string, unknown>[];
const snapshot = () => (rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as { name: string }[])
  .map(({ name }) => ({ name, rows: rows(`SELECT * FROM "${name}" ORDER BY rowid`) }));
const count = () => Number(rows("SELECT COALESCE(SUM(count),0) AS n FROM rate_counters WHERE bucket='knowledge-collections:biz'")[0].n);
const setCount = (n: number) => db.database.prepare("INSERT INTO rate_counters(bucket,window_start,count) VALUES('knowledge-collections:biz',CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400,?) ON CONFLICT(bucket,window_start) DO UPDATE SET count=excluded.count").run(n);
const row = (id: string) => db.database.prepare('SELECT * FROM knowledge_collections WHERE id=?').get(id) as Record<string, unknown> | undefined;
function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', token = 'session') {
  return worker.fetch(new Request(`https://openfon.test${path}`, { method, headers: { Cookie: `ofs=${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}
const create = (name = 'Wanted', description = '') => request(root, { name, description });
const put = (id: string, body: unknown) => request(`${root}/${id}`, body, 'PUT');
const remove = (id: string) => request(`${root}/${id}`, undefined, 'DELETE');

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  db = new SqliteD1(); applyMigrations(db, 1, 21);
  db.exec("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'); INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01'); INSERT INTO businesses(id,user_id,slug,name,description) VALUES('biz','owner','owned','Owned','Synthetic'); INSERT INTO agent_settings(business_id) VALUES('biz'); INSERT INTO provider_settings(business_id) VALUES('biz');");
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: '', DEFAULT_LLM_MODEL: 'instance', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: '', DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime', REALTIME_MODEL: 'kataleptic-realtime-hd' } as unknown as Env;
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  db.exec("INSERT INTO knowledge_collections(id,business_id,name,description) VALUES('one','biz','One','Original'),('two','biz','Two','Peer'); INSERT INTO knowledge_items(id,business_id,collection_id,kind,status,content) VALUES('custom','biz','one','note','active','Custom knowledge'); INSERT INTO assistant_knowledge_collections(assistant_id,collection_id) VALUES('asst_biz','one');");
});
afterEach(() => { vi.restoreAllMocks(); db.close(); vi.useRealTimers(); });

// Gate before real batch BEGIN, standalone run, or DELETE RETURNING first.
// Foundation INSERT OR IGNORE/promotion and peer requests cannot consume a gate
// that is already held. Adapter and its one-hook-per-statement stay unchanged.
function hold(lane: Lane) {
  let enter!: () => void, release!: () => void, fired = false;
  const reached = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db), sqls = new WeakMap<object, string>();
  const writes: { sql: string[]; result: unknown }[] = [];
  async function before() { if (!fired) { fired = true; enter(); await gate; } }
  const prep = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql); sqls.set(statement, sql);
    if (requested(lane, sql)) {
      const run = statement.run.bind(statement), first = statement.first.bind(statement);
      statement.run = async () => { await before(); const result = await run(); writes.push({ sql: [sql], result }); return result; };
      statement.first = async <T>() => { await before(); const result = await first<T>(); writes.push({ sql: [sql], result }); return result; };
    }
    return statement;
  });
  const batches = vi.spyOn(db, 'batch').mockImplementation(async statements => {
    const sql = statements.map(s => sqls.get(s) ?? ''), match = sql.some(s => requested(lane, s));
    if (match) await before();
    const result = await batch(statements); if (match) writes.push({ sql, result }); return result;
  });
  return { reached, release, writes, restore() { prep.mockRestore(); batches.mockRestore(); } };
}
function diagnostic(name: string, data: unknown) { console.log('collection-race-preassertion', JSON.stringify({ name, data })); }

it('[original-negative] delete refuses a foundation-promoted default and preserves post-repair custom knowledge', async () => {
  // Explicit recovery precondition, not an ordinary HTTP demotion producer.
  db.exec("UPDATE knowledge_collections SET is_default=0 WHERE id='kc_default_biz'; INSERT INTO knowledge_items(id,business_id,collection_id,kind,status,content) VALUES('recovery-custom','biz','kc_default_biz','note','active','Keep recovery knowledge');");
  const initial = snapshot(), h = hold('delete'), pending = remove('kc_default_biz');
  try {
    await h.reached; const repair = await request('/api/me/bootstrap'); expect(repair.status).toBe(200);
    expect(row('kc_default_biz')?.is_default).toBe(1);
    const baseline = snapshot(); h.release(); const response = await pending, body = await response.json(), after = snapshot();
    diagnostic('delete-promoted', { initial, baseline, status: response.status, body, after, writes: h.writes });
    expect(response.status).toBe(409); expect(body).toEqual({ error: 'Collection changed. Reload and retry.' }); expect(after).toEqual(baseline); expect(baseline).not.toEqual(initial);
  } finally { h.release(); await pending; h.restore(); }
});

it('[original-negative] delete reports conflict when another deletion already removed the target', async () => {
  const h = hold('delete'), pending = remove('one');
  try {
    await h.reached; expect((await remove('one')).status).toBe(200); const baseline = snapshot();
    h.release(); const response = await pending, after = snapshot(); diagnostic('delete-disappeared', { baseline, status: response.status, after, writes: h.writes });
    expect(response.status).toBe(409); expect(after).toEqual(baseline);
  } finally { h.release(); await pending; h.restore(); }
});

for (const lane of ['create', 'put'] as const) for (const peer of ['create', 'put'] as const) {
  it(`[original-negative] ${lane} conflicts when a peer ${peer} claims its desired name after precheck`, async () => {
    const h = hold(lane), pending = lane === 'create' ? create('  Wanted  ') : put('one', { name: '  Wanted  ' });
    try {
      await h.reached; const winner = peer === 'create' ? await create() : await put('two', { name: 'Wanted' });
      expect(winner.status).toBe(peer === 'create' ? 201 : 200); const winnerBody = await winner.json(), baseline = snapshot(), spent = count();
      h.release(); const response = await pending, body = await response.json(), after = snapshot();
      const retry = lane === 'create' ? await create() : await put('one', { name: 'Wanted' }); const afterRetry = snapshot();
      diagnostic(`${lane}-${peer}`, { winnerBody, baseline, status: response.status, body, after, retryStatus: retry.status, afterRetry, writes: h.writes });
      expect(response.status).toBe(409); expect(body).toEqual({ error: lane === 'create' ? 'A collection with this name already exists' : 'Collection changed. Reload and retry.' }); expect(after).toEqual(baseline); expect(retry.status).toBe(409); expect(afterRetry).toEqual(baseline); expect(count()).toBe(spent);
    } finally { h.release(); await pending; h.restore(); }
  });
}
for (const lane of ['create', 'put'] as const) {
  it(`[original-negative] ${lane} duplicate skip precedes trigger after peer spends final daily unit`, async () => {
    setCount(99); const h = hold(lane), pending = lane === 'create' ? create() : put('one', { name: 'Wanted' });
    try {
      await h.reached; expect((await create()).status).toBe(201); expect(count()).toBe(100); const baseline = snapshot();
      h.release(); const response = await pending, after = snapshot(); diagnostic(`${lane}-final-duplicate`, { baseline, status: response.status, after, writes: h.writes });
      expect(response.status).toBe(409); expect(after).toEqual(baseline); expect(count()).toBe(100);
    } finally { h.release(); await pending; h.restore(); }
  });
}

it('create returns actual defaults and trims once; stable retry has no new row or charge', async () => {
  const before = count(), response = await create('  Unicode 👋  ', '  Details é  '), body = await response.json() as Record<string, unknown>;
  expect(response.status).toBe(201); expect(body).toEqual(row(String(body.id))); expect(body).toMatchObject({ name: 'Unicode 👋', description: 'Details é', is_default: 0 });
  expect(body.created_at).toBeTruthy(); expect(count()).toBe(before + 1); const baseline = snapshot();
  expect((await create('Unicode 👋')).status).toBe(409); expect(snapshot()).toEqual(baseline);
});
it('create preserves earlier foundation repair and charges only requested insert after the repair baseline', async () => {
  db.exec("UPDATE knowledge_collections SET is_default=0 WHERE id='kc_default_biz'");
  const initial = snapshot(), h = hold('create'), pending = create();
  try {
    await h.reached; const baseline = snapshot(), spent = count(); expect(row('kc_default_biz')?.is_default).toBe(1);
    h.release(); const response = await pending, body = await response.json(), after = snapshot(); diagnostic('create-repair-baseline', { initial, baseline, status: response.status, body, after, writes: h.writes });
    expect(response.status).toBe(201); expect(baseline).not.toEqual(initial); expect(count()).toBe(spent + 1);
    for (const name of ['assistants','provider_settings','agent_settings','compatibility_sync_state','assistant_knowledge_collections','knowledge_items']) expect(after.find(t => t.name === name)).toEqual(baseline.find(t => t.name === name));
  } finally { h.release(); await pending; h.restore(); }
});
it('PUT preserves omission blank-name fallback and self-name no-op with one normal charge each', async () => {
  let spent = count(); const original = row('one');
  for (const body of [{}, { name: '   ' }, { name: 'One' }]) { expect((await put('one', body)).status).toBe(200); expect(row('one')).toEqual(original); expect(count()).toBe(++spent); }
  expect((await put('one', { description: 'New details' })).status).toBe(200); expect(row('one')).toMatchObject({ name: 'One', description: 'New details' }); expect(count()).toBe(++spent);
});
for (const field of ['name', 'description'] as const) {
  it(`PUT retains captured ${field} CAS independently of desired-name availability`, async () => {
    const h = hold('put'), pending = put('one', { name: 'Available' });
    try {
      await h.reached; expect((await put('one', { [field]: 'Newer' })).status).toBe(200); const baseline = snapshot();
      h.release(); expect((await pending).status).toBe(409); expect(snapshot()).toEqual(baseline);
    } finally { h.release(); await pending; h.restore(); }
  });
}
it('PUT retains zero-update conflict after target disappears', async () => {
  const h = hold('put'), pending = put('one', { name: 'Available' });
  try { await h.reached; expect((await remove('one')).status).toBe(200); const baseline = snapshot(); h.release(); expect((await pending).status).toBe(409); expect(snapshot()).toEqual(baseline); }
  finally { h.release(); await pending; h.restore(); }
});
it('PUT description edit tolerates role-only promotion without adding a default CAS', async () => {
  db.exec("UPDATE knowledge_collections SET is_default=0 WHERE id='kc_default_biz'");
  const h = hold('put'), pending = put('kc_default_biz', { description: 'Retained edit' });
  try { await h.reached; expect((await request('/api/me/bootstrap')).status).toBe(200); h.release(); expect((await pending).status).toBe(200); expect(row('kc_default_biz')).toMatchObject({ is_default: 1, description: 'Retained edit' }); }
  finally { h.release(); await pending; h.restore(); }
});
it('ordinary DELETE cascades items and attachments even at spent quota without refund', async () => {
  setCount(100); const before = count(); expect((await remove('one')).status).toBe(200);
  expect(row('one')).toBeUndefined(); expect(rows("SELECT * FROM knowledge_items WHERE id='custom'")).toEqual([]); expect(rows("SELECT * FROM assistant_knowledge_collections WHERE collection_id='one'")).toEqual([]); expect(count()).toBe(before);
});
it('DELETE known default missing and foreign ownership keep response precedence and no writes', async () => {
  db.exec("INSERT INTO users(id,email,password_hash) VALUES('other','other@example.invalid','unused'); INSERT INTO businesses(id,user_id,slug,name) VALUES('other','other','other','Other'); INSERT INTO knowledge_collections(id,business_id,name) VALUES('foreign','other','Foreign');");
  const before = snapshot(); expect((await remove('kc_default_biz')).status).toBe(409); expect((await remove('missing')).status).toBe(404); expect((await remove('foreign')).status).toBe(404); expect(snapshot()).toEqual(before);
});
it('names remain case-sensitive and scoped to business for POST and PUT', async () => {
  db.exec("INSERT INTO users(id,email,password_hash) VALUES('other','other@example.invalid','unused'); INSERT INTO businesses(id,user_id,slug,name) VALUES('other','other','other','Other'); INSERT INTO knowledge_collections(id,business_id,name) VALUES('foreign','other','Wanted');");
  const sameName = await create('Wanted'); expect(sameName.status).toBe(201); const created = await sameName.json() as { id: string }; expect((await remove(created.id)).status).toBe(200);
  expect((await put('one', { name: 'Wanted' })).status).toBe(200); expect((await create('wanted')).status).toBe(201);
});
for (const lane of ['create', 'put'] as const) {
  it(`${lane} unique-name write retains daily quota refusal`, async () => {
    setCount(100); const before = snapshot(); const response = lane === 'create' ? await create('Available') : await put('one', { name: 'Available' });
    expect(response.status).toBe(429); expect(snapshot()).toEqual(before);
  });
}
for (const lane of ['create', 'put', 'delete'] as const) {
  it(`${lane} late statement abort preserves full persisted rows and counters`, async () => {
    const event = lane === 'create' ? 'INSERT' : lane === 'put' ? 'UPDATE' : 'DELETE';
    db.exec(`CREATE TRIGGER synthetic_late AFTER ${event} ON knowledge_collections WHEN ${lane === 'delete' ? "OLD.id='one'" : "NEW.name='Fault'"} BEGIN INSERT INTO rate_counters(bucket,window_start,count) VALUES('synthetic-late',0,1); SELECT RAISE(ABORT,'SYNTHETIC_COLLECTION_LATE'); END;`);
    const before = snapshot(); const response = lane === 'create' ? await create('Fault') : lane === 'put' ? await put('one', { name: 'Fault' }) : await remove('one'); const after = snapshot();
    diagnostic(`${lane}-late-abort`, { status: response.status, before, after }); expect(response.status).toBe(500); expect(after).toEqual(before);
  });
}
