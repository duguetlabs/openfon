import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

let db: SqliteD1, env: Env;
type Route = 'collection' | 'item' | 'draft' | 'preset';
const routes: Route[] = ['collection', 'item', 'draft', 'preset'];
const table = (route: Route) => route === 'collection' ? 'knowledge_collections' : route === 'preset' ? 'engine_presets' : 'knowledge_items';
const bucket = (route: Route) => `${route === 'collection' ? 'knowledge-collections' : route === 'preset' ? 'presets' : 'knowledge'}:biz`;
const limit = (route: Route) => route === 'collection' ? 100 : route === 'preset' ? 400 : 500;
const charge = (route: Route) => route === 'preset' ? 2 : 1;
const path = (route: Route) => ({ collection: '/api/me/knowledge/collections', item: '/api/me/knowledge/collections/kc_default_biz/items', draft: '/api/me/knowledge/drafts/from-turn', preset: '/api/me/engine-presets' })[route];
const payload = (route: Route) => ({ collection: { name: '  Saved collection  ', description: '  Description 👋  ' }, item: { kind: 'note', status: 'active', title: '  Saved item  ', content: '  Ready 👋  ', source_call_id: 'ignored' }, draft: { callId: 'source', turnId: 1 }, preset: { name: '  Saved preset  ', llm_base_url: 'https://ignored.example/v1', llm_api_key: 'synthetic-ignored' } })[route];
const responseSql = (route: Route) => `SELECT * FROM ${table(route)} WHERE id = ?`;
const isRequested = (sql: string) => /^INSERT INTO knowledge_collections \(id, business_id, name, description\)\s+(?:VALUES|SELECT)\b/.test(sql) ||
  (sql.startsWith('INSERT INTO knowledge_items (') && (sql.includes("CASE WHEN ? = 'active'") || sql.includes("VALUES (?, ?, ?, 'faq', 'draft'"))) || (sql.startsWith('INSERT INTO engine_presets (') && sql.includes(') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'));
const query = (sql: string) => db.database.prepare(sql).all() as Record<string, unknown>[];
const snapshot = () => (query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as { name: string }[])
  .map(({ name }) => ({ name, rows: query(`SELECT * FROM "${name}" ORDER BY rowid`) }));
const count = (route: Route) => Number(query(`SELECT COALESCE(SUM(count),0) AS n FROM rate_counters WHERE bucket='${bucket(route)}'`)[0].n);
const setCount = (route: Route, n: number) => db.database.prepare("INSERT INTO rate_counters(bucket,window_start,count) VALUES(?,CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400,?) ON CONFLICT(bucket,window_start) DO UPDATE SET count=excluded.count").run(bucket(route), n);
const request = (url: string, body?: unknown) => worker.fetch(new Request(`https://openfon.test${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: 'ofs=session', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
const create = (route: Route, body: unknown = payload(route)) => request(path(route), body);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  db = new SqliteD1(); applyMigrations(db, 1, 21);
  db.exec("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'); INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01'); INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','owned','Owned'); INSERT INTO agent_settings(business_id) VALUES('biz'); INSERT INTO provider_settings(business_id) VALUES('biz');");
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: '', DEFAULT_LLM_MODEL: 'instance', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: '', DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime', REALTIME_MODEL: 'kataleptic-realtime' } as unknown as Env;
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  db.exec("INSERT INTO calls(id,business_id,assistant_id,environment) VALUES('source','biz','asst_biz','test'); INSERT INTO call_turns(id,call_id,role,text) VALUES(1,'source','caller','  A caller question?  '),(2,'source','agent','An answer');");
});
afterEach(() => { vi.restoreAllMocks(); db.close(); vi.useRealTimers(); });

function observe(route: Route, options: { failRead?: boolean; beforeWrite?: () => void; lateMirror?: boolean } = {}) {
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db), sqls = new WeakMap<object, string>();
  const batches: { sql: string[]; results: unknown }[] = [];
  let before: ReturnType<typeof snapshot> | undefined, insideMirror: ReturnType<typeof snapshot> | undefined, outsideReads = 0, fired = false;
  const enter = () => { if (!fired) { fired = true; options.beforeWrite?.(); before = snapshot(); } };
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const response = sql === responseSql(route);
    if (response && options.failRead) { options.failRead = false; sql = sql.replace('SELECT *', "SELECT *, CASE WHEN id IS NOT NULL THEN json('SYNTHETIC_POST_RESPONSE') END AS injected_failure"); }
    const statement = prepare(sql); sqls.set(statement, sql);
    if (response) { const first = statement.first.bind(statement); vi.spyOn(statement, 'first').mockImplementation(async () => { outsideReads++; return first(); }); }
    if (isRequested(sql)) { const run = statement.run.bind(statement); vi.spyOn(statement, 'run').mockImplementation(async () => { enter(); return run(); }); }
    return statement;
  });
  vi.spyOn(db, 'batch').mockImplementation(async statements => {
    const sql = statements.map(statement => sqls.get(statement) || ''), requested = sql.some(isRequested);
    if (requested) enter(); // Before real batch BEGIN; foundation has already completed.
    const results = await batch(statements); if (requested) batches.push({ sql, results }); return results;
  });
  db.hook = sql => {
    if (options.lateMirror && sql.startsWith('INSERT INTO engine_profiles (')) {
      insideMirror = snapshot();
      db.database.prepare("SELECT CASE WHEN name='Saved preset' THEN json('SYNTHETIC_POST_MIRROR') END FROM engine_presets WHERE business_id='biz'").all();
    }
  };
  return { batches, baseline: () => before, insideMirror: () => insideMirror, outsideReads: () => outsideReads };
}

for (const route of routes) {
  it.each([false, true])(`${route} response fault captures persisted retry before first assertion (final capacity=%s)`, async final => {
    if (final) setCount(route, limit(route) - charge(route));
    const initial = snapshot(), initialCount = count(route), observed = observe(route, { failRead: true });
    const response = await create(route), body = await response.json(), afterFirst = snapshot(), firstCount = count(route), baseline = observed.baseline();
    const retry = await create(route), retryBody = await retry.json(), afterRetry = snapshot(), retryCount = count(route);
    console.log('post-response-preassertion', JSON.stringify({ route, final, status: response.status, body, retryStatus: retry.status, retryBody, outsideReads: observed.outsideReads(), initial, baseline, afterFirst, afterRetry, initialCount, firstCount, retryCount }));
    expect(response.status).toBe(201); // Original first failure: committed create followed by read500.
    expect(observed.outsideReads()).toBe(0); expect(firstCount).toBe(initialCount + charge(route));
    expect(retry.status).toBe(route === 'collection' ? 409 : final ? 429 : 201);
    expect(retryCount).toBe(firstCount + (route !== 'collection' && !final ? charge(route) : 0));
    if (route === 'collection' || final) expect(afterRetry).toEqual(afterFirst);
    else expect((retryBody as { id: string }).id).not.toBe((body as { id: string }).id);
  });
  it(`${route} returns inserted defaults and preserves requested batch shape`, async () => {
    const observed = observe(route), before = count(route), response = await create(route), body = await response.json() as { id: string };
    const persisted = db.database.prepare(`SELECT * FROM ${table(route)} WHERE id=?`).get(body.id);
    expect(response.status).toBe(201); expect(body).toEqual(persisted); expect(observed.outsideReads()).toBe(0);
    expect(count(route)).toBe(before + charge(route)); expect(observed.batches).toHaveLength(1);
    const batch = observed.batches[0], results = batch.results as { results: unknown[]; meta: { changes: number } }[];
    expect(batch.sql).toHaveLength(route === 'preset' ? 2 : 1); expect(batch.sql[0]).toContain('RETURNING *'); expect(results[0].results).toEqual([body]);
    expect(results.map(result => result.meta.changes)).toEqual(route === 'preset' ? [2, 2] : [2]);
    expect(body).toHaveProperty('created_at'); expect(body).toHaveProperty('updated_at');
    if (route === 'collection') expect(body).toMatchObject({ name: 'Saved collection', description: 'Description 👋', is_default: 0 });
    if (route === 'item') { expect(body).toMatchObject({ title: 'Saved item', content: 'Ready 👋', status: 'active', source_call_id: null, source_turn_id: null }); expect(body).toHaveProperty('activated_at', '2026-09-15 12:00:00'); }
    if (route === 'draft') expect(body).toMatchObject({ collection_id: 'kc_default_biz', kind: 'faq', status: 'draft', question: 'A caller question?', answer: '', source_call_id: 'source', source_turn_id: 1, activated_at: null });
    if (route === 'preset') {
      expect(body).toMatchObject({ name: 'Saved preset', engine: 'pipeline', language: 'en' });
      expect(query('SELECT id,name,llm_base_url,llm_api_key FROM engine_profiles')).toEqual([{ id: body.id, name: 'Saved preset', llm_base_url: '', llm_api_key: '' }]);
    }
  });
}

it.each(['collection', 'draft'] as const)('%s repaired foundation response fault preserves earlier baseline', async route => {
  db.exec("DELETE FROM agent_settings WHERE business_id='biz'");
  const initial = snapshot(), observed = observe(route, { failRead: true });
  const response = await create(route), body = await response.json(), baseline = observed.baseline(), afterFirst = snapshot();
  const retry = await create(route), retryBody = await retry.json(), afterRetry = snapshot();
  console.log('post-foundation-preassertion', JSON.stringify({ route, status: response.status, body, retryStatus: retry.status, retryBody, initial, baseline, afterFirst, afterRetry }));
  expect(response.status).toBe(201); // Original first failure after all diagnostics.
  expect(baseline).toBeDefined(); expect(baseline).not.toEqual(initial); expect(query("SELECT business_id FROM agent_settings WHERE business_id='biz'")).toEqual([{ business_id: 'biz' }]);
  for (const state of [afterFirst, afterRetry]) for (const preserved of ['assistants', 'provider_settings', 'agent_settings', 'compatibility_sync_state', 'assistant_knowledge_collections']) {
    expect(state.find(table => table.name === preserved)).toEqual(baseline!.find(table => table.name === preserved));
  }
  expect(retry.status).toBe(route === 'collection' ? 409 : 201); expect(observed.outsideReads()).toBe(0);
});
it('preset399 preflight refuses read-only before requested writes', async () => {
  setCount('preset', 399); const before = snapshot(), observed = observe('preset');
  expect((await create('preset')).status).toBe(429); expect(snapshot()).toEqual(before); expect(observed.baseline()).toBeUndefined(); expect(observed.batches).toEqual([]);
});
it('late preset mirror execution failure rolls back row and both counter effects', async () => {
  const before = snapshot(), observed = observe('preset', { lateMirror: true });
  const response = await create('preset'), after = snapshot();
  console.log('post-mirror-preassertion', JSON.stringify({ status: response.status, before, insideMirror: observed.insideMirror(), after }));
  expect(response.status).toBe(500); expect(observed.insideMirror()).toBeDefined(); expect(observed.insideMirror()).not.toEqual(before); expect(after).toEqual(before);
});
it('quota peer before preset batch causes second insert refusal and whole rollback', async () => {
  const observed = observe('preset', { beforeWrite: () => setCount('preset', 399) });
  const response = await create('preset'), after = snapshot();
  console.log('post-quota-preassertion', JSON.stringify({ status: response.status, baseline: observed.baseline(), after }));
  expect(response.status).toBe(429); expect(observed.baseline()).toBeDefined(); expect(after).toEqual(observed.baseline()); expect(query('SELECT * FROM engine_presets')).toEqual([]); expect(query('SELECT * FROM engine_profiles')).toEqual([]); expect(count('preset')).toBe(399);
});
it('invalid ownership readiness and caller role retain refusal precedence without requested writes', async () => {
  const before = snapshot();
  expect((await create('collection', { name: ' ' })).status).toBe(400);
  expect((await request('/api/me/knowledge/collections/missing/items', { kind: 'invalid' })).status).toBe(404);
  expect((await create('item', { kind: 'note', status: 'active', content: '' })).status).toBe(400);
  expect((await create('draft', { callId: 'source', turnId: 2 })).status).toBe(404);
  expect((await create('draft', { callId: 'source', turnId: 1, collectionId: 'missing' })).status).toBe(404);
  expect((await create('preset', { name: ' ' })).status).toBe(400); expect(snapshot()).toEqual(before);
});
