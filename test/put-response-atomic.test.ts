import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

let db: SqliteD1, env: Env;
type Target = 'primary' | 'secondary' | 'item';
const targets: Target[] = ['primary', 'secondary', 'item'];
const id = (target: Target) => target === 'primary' ? 'asst_biz' : target;
const table = (target: Target) => target === 'item' ? 'knowledge_items' : 'assistants';
const responseSql = (target: Target) => `SELECT * FROM ${table(target)} WHERE id = ?`;
const isWrite = (sql: string) => sql.startsWith('UPDATE assistants SET name=') || sql.startsWith('UPDATE knowledge_items SET collection_id=');
const query = (sql: string) => db.database.prepare(sql).all() as Record<string, unknown>[];
const row = (target: Target) => db.database.prepare(`SELECT * FROM ${table(target)} WHERE id=?`).get(id(target));
const snapshot = () => (query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as { name: string }[])
  .map(({ name }) => ({ name, rows: query(`SELECT * FROM "${name}" ORDER BY rowid`) }));
const bucket = (target: Target) => `${target === 'item' ? 'knowledge' : 'assistants'}:biz`;
const quota = (target: Target) => target === 'item' ? 500 : 200;
const count = (target: Target) => Number(query(`SELECT count FROM rate_counters WHERE bucket='${bucket(target)}'`)[0].count);
const payload = (target: Target) => target === 'item' ? { title: '  Saved 👋  ' } : { greeting: 'Saved 👋' };
const request = (path: string, body?: unknown) => worker.fetch(new Request(`https://openfon.test${path}`, {
  method: body === undefined ? 'GET' : 'PUT', headers: { Cookie: 'ofs=session', 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
const save = (target: Target, body: unknown = payload(target)) => request(`/api/me/${target === 'item' ? 'knowledge/items' : 'assistants'}/${id(target)}`, body);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  db = new SqliteD1(); applyMigrations(db, 1, 21);
  db.exec("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'); INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01'); INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','owned','Owned'); INSERT INTO agent_settings(business_id) VALUES('biz'); INSERT INTO provider_settings(business_id) VALUES('biz');");
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: '', DEFAULT_LLM_MODEL: 'instance', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: '', DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime', REALTIME_MODEL: 'kataleptic-realtime-hd' } as unknown as Env;
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  db.exec("INSERT INTO assistants(id,business_id,public_slug) VALUES('secondary','biz','secondary'); INSERT INTO calls(id,business_id) VALUES('source','biz'); INSERT INTO call_turns(id,call_id,role,text) VALUES(1,'source','caller','Source'); INSERT INTO knowledge_items(id,business_id,collection_id,kind,status,title,content,source_call_id,source_turn_id) VALUES('item','biz','kc_default_biz','note','draft','Original','Ready content','source',1);");
});
afterEach(() => { vi.restoreAllMocks(); db.close(); vi.useRealTimers(); });

// All beforeWrite callbacks run before db.batch BEGIN or the original item run.
function instrument(options: { failRead?: Target; beforeWrite?: () => void; late?: 'mirror' | 'snapshot' } = {}) {
  const sqls = new WeakMap<object, string>(), prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  const batches: { sql: string[]; results: unknown }[] = [];
  let once = false, outsideReads = 0, lateReached = false;
  const before = () => { if (!once) { once = true; options.beforeWrite?.(); } };
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const originalSql = sql;
    if (options.failRead && sql === responseSql(options.failRead)) {
      outsideReads++; sql = sql.replace('SELECT *', "SELECT *, json('SYNTHETIC_PUT_RESPONSE_FAILURE') AS injected_failure");
      options.failRead = undefined;
    }
    const statement = prepare(sql); sqls.set(statement, sql);
    if (isWrite(originalSql)) {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, 'run').mockImplementation(async () => { before(); return run(); });
    }
    return statement;
  });
  vi.spyOn(db, 'batch').mockImplementation(async statements => {
    const sql = statements.map(statement => sqls.get(statement) || '');
    if (sql.some(isWrite)) before();
    const results = await batch(statements); batches.push({ sql, results }); return results;
  });
  db.hook = sql => {
    if (options.late && sql.startsWith(options.late === 'mirror' ? 'UPDATE agent_settings SET agent_name=' : 'UPDATE compatibility_sync_state SET agent_snapshot=')) {
      lateReached = true;
      // Valid SQL executes only after the first requested UPDATE; this is not a prepare fault.
      db.database.prepare("SELECT CASE WHEN greeting='Saved 👋' THEN json('SYNTHETIC_LATE_PUT') END FROM assistants WHERE id='asst_biz'").get();
    }
  };
  return { batches, reads: () => outsideReads, lateReached: () => lateReached };
}

for (const target of targets) {
  it.each([false, true])(`${target} response fault records fresh retry and quota before first assertion (final unit=%s)`, async finalUnit => {
    if (finalUnit) db.database.prepare('UPDATE rate_counters SET count=? WHERE bucket=?').run(quota(target) - 1, bucket(target));
    const before = snapshot(), initialCount = count(target), fault = instrument({ failRead: target });
    const response = await save(target), firstBody = await response.json(), afterFirst = snapshot(), firstRow = row(target), firstCount = count(target);
    const retry = await save(target), retryBody = await retry.json(), afterRetry = snapshot(), retryCount = count(target);
    console.log('put-response-preassertion', JSON.stringify({ target, finalUnit, status: response.status, firstBody, retryStatus: retry.status, retryBody, reads: fault.reads(), before, afterFirst, afterRetry, initialCount, firstCount, retryCount }));
    expect(response.status).toBe(200); // Original first failure: 500 after committed requested state.
    expect(firstBody).toEqual(firstRow); expect(fault.reads()).toBe(0); expect(firstCount).toBe(initialCount + 1);
    expect(retry.status).toBe(finalUnit ? 429 : 200);
    expect(retryCount).toBe(initialCount + (finalUnit ? 1 : 2));
    if (finalUnit) expect(afterRetry).toEqual(afterFirst);
  });
  it(`${target} returns actual mutation row and preserves batch changes chain`, async () => {
    const observed = instrument(), before = count(target), response = await save(target), returned = await response.json();
    console.log('put-returning-preassertion', JSON.stringify({ target, status: response.status, returned, persisted: row(target), batches: observed.batches }));
    expect(response.status).toBe(200); expect(returned).toEqual(row(target)); expect(count(target)).toBe(before + 1);
    expect(observed.batches).toHaveLength(1);
    const batch = observed.batches[0], results = batch.results as { meta: { changes: number }; results: unknown[] }[];
    expect(batch.sql).toHaveLength(target === 'primary' ? 3 : 1); expect(batch.sql[0]).toContain('RETURNING *');
    expect(results[0].results).toEqual([returned]); expect(results[0].meta.changes).toBe(2);
    if (target === 'primary') {
      expect(batch.sql[1]).toMatch(/^UPDATE agent_settings/); expect(batch.sql[2]).toMatch(/^UPDATE compatibility_sync_state/);
      expect(batch.sql[1]).toContain('changes()>0'); expect(batch.sql[2]).toContain('changes()>0');
      expect(results.slice(1).map(result => result.meta.changes)).toEqual([1, 1]);
      expect(query("SELECT greeting FROM agent_settings WHERE business_id='biz'")).toEqual([{ greeting: 'Saved 👋' }]);
      expect(JSON.parse(String(query("SELECT agent_snapshot FROM compatibility_sync_state WHERE business_id='biz'")[0].agent_snapshot)).greeting).toBe('Saved 👋');
    }
  });
  it(`${target} identical same-second fresh saves still charge once each`, async () => {
    const before = count(target); expect((await save(target)).status).toBe(200); const first = row(target);
    expect((await save(target)).status).toBe(200); expect(row(target)).toEqual(first); expect(count(target)).toBe(before + 2);
  });
  it(`${target} captured row conflict returns409 without requested effects`, async () => {
    let peer: ReturnType<typeof snapshot> | undefined;
    const observed = instrument({ beforeWrite: () => {
      db.exec(target === 'item' ? "UPDATE knowledge_items SET content='Peer' WHERE id='item'" : `UPDATE assistants SET voice='Peer' WHERE id='${id(target)}'`); peer = snapshot();
    } });
    const response = await save(target); expect(response.status).toBe(409); expect(peer).toBeDefined(); expect(snapshot()).toEqual(peer);
    const batch = observed.batches[0]; expect(batch).toBeDefined();
    expect((batch.results as { meta: { changes: number }; results: unknown[] }[]).every(result => result.meta.changes === 0 && result.results.length === 0)).toBe(true);
  });
}
it('provider conflict keeps full primary batch zero and no charge', async () => {
  let peer: ReturnType<typeof snapshot> | undefined;
  const observed = instrument({ beforeWrite: () => { db.exec("UPDATE provider_settings SET realtime_provider='custom' WHERE business_id='biz'"); peer = snapshot(); } });
  expect((await save('primary')).status).toBe(409); expect(snapshot()).toEqual(peer);
  expect((observed.batches[0].results as { meta: { changes: number } }[]).map(result => result.meta.changes)).toEqual([0, 0, 0]);
});
it.each(['mirror', 'snapshot'] as const)('late primary %s execution failure rolls back returned row and counters', async late => {
  const before = snapshot(), observed = instrument({ late });
  const response = await save('primary'), after = snapshot();
  console.log('put-late-preassertion', JSON.stringify({ late, status: response.status, reached: observed.lateReached(), before, after }));
  expect(response.status).toBe(500); expect(observed.lateReached()).toBe(true); expect(after).toEqual(before);
});
it('item preserves activation metadata source refs readiness and tenant refusal', async () => {
  expect((await save('item', { status: 'active' })).status).toBe(200);
  const activated = (row('item') as { activated_at: string }).activated_at; expect(activated).toBeTruthy();
  vi.setSystemTime(new Date('2026-09-15T12:01:00Z'));
  const result = await save('item'), returned = await result.json(); expect(result.status).toBe(200); expect(returned).toEqual(row('item'));
  expect(returned).toMatchObject({ activated_at: activated, source_call_id: 'source', source_turn_id: 1 });
  const before = snapshot(); expect((await save('item', { content: '' })).status).toBe(400); expect(snapshot()).toEqual(before);
  expect((await save('item', { collection_id: 'missing' })).status).toBe(404); expect(snapshot()).toEqual(before);
  expect(() => db.exec("UPDATE knowledge_items SET collection_id='missing' WHERE id='item'")).toThrow(); expect(snapshot()).toEqual(before);
  const draft = await save('item', { status: 'draft' }); expect(draft.status).toBe(200); expect(await draft.json()).toMatchObject({ activated_at: null, source_call_id: 'source' });
});
it('missing primary mirror preserves existing zero downstream behavior', async () => {
  db.exec("DELETE FROM agent_settings WHERE business_id='biz'");
  const before = query('SELECT * FROM compatibility_sync_state'), countBefore = count('primary'), observed = instrument();
  const response = await save('primary'); expect(response.status).toBe(200); expect(await response.json()).toEqual(row('primary'));
  expect(query('SELECT * FROM agent_settings')).toEqual([]); expect(query('SELECT * FROM compatibility_sync_state')).toEqual(before);
  expect(count('primary')).toBe(countBefore + 1);
  expect((observed.batches[0].results as { meta: { changes: number } }[]).map(result => result.meta.changes)).toEqual([2, 0, 0]);
});
