// Minimal novel collection write shapes: Node production handlers + workerd D1.
// Held DB calls are synthetic schedules, not whole-Worker HTTP concurrency.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
process.umask(0o077);
const evidence = process.env.OPENFON_COLLECTION_EVIDENCE_DIR;
assert.ok(evidence, 'Unique restricted durable evidence directory required');
await mkdir(evidence, { mode: 0o700 }); // Existing evidence is never overwritten.
const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'openfon-collection-races-'));
const outcomes = [], captures = [];
let mf, disposed = false, activeCase;
try {
  await build({ stdin: { contents: "export { default } from './src/index';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'handler.mjs') });
  const { default: worker } = await import(pathToFileURL(join(temp, 'handler.mjs')).href);
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false, port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252), workers: [{ name: 'collection-races', modules: true, script: 'export default {fetch(){return new Response("local D1")}}', compatibilityDate: '2026-05-01', d1Databases: { DB: 'collection-races' }, outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready; const native = await mf.getD1Database('DB', 'collection-races');
  const exec = sql => native.batch(unstable_splitSqlQuery(sql).map(s => native.prepare(s)));
  const query = async sql => (await native.prepare(sql).all()).results;
  const migrations = (await readdir(join(root, 'migrations'))).filter(n => /^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0, 4)) <= 22).sort(); assert.equal(migrations.length, 22);
  for (const file of migrations) await exec(await readFile(join(root, 'migrations', file), 'utf8'));
  const snapshot = async () => {
    const tables = await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name");
    const result = []; for (const { name } of tables) result.push({ name, rows: await query(`SELECT * FROM "${name}" ORDER BY rowid`) }); return result;
  };
  const count = async () => Number((await query("SELECT COALESCE(SUM(count),0) AS n FROM rate_counters WHERE bucket='knowledge-collections:biz'"))[0].n);
  const setCount = n => native.prepare("INSERT INTO rate_counters(bucket,window_start,count) VALUES('knowledge-collections:biz',CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400,?) ON CONFLICT(bucket,window_start) DO UPDATE SET count=excluded.count").bind(n).run();
  const requested = (lane, sql) => lane === 'create' ? sql.startsWith('INSERT INTO knowledge_collections (id, business_id, name, description)') : lane === 'put' ? sql.startsWith('UPDATE knowledge_collections SET name=') : sql.startsWith('DELETE FROM knowledge_collections WHERE id');
  let gate, writes = [], errors = [];
  function hold(lane) {
    let enter, release, fired = false;
    const reached = new Promise(resolve => { enter = resolve; }), blocked = new Promise(resolve => { release = resolve; });
    gate = { lane, async before() { if (!fired) { fired = true; enter(); await blocked; } } };
    return { reached, release, clear() { gate = undefined; } };
  }
  async function before(sqls) { if (gate && sqls.some(sql => requested(gate.lane, sql))) await gate.before(); }
  function statement(sql, args = []) {
    const raw = () => native.prepare(sql).bind(...args);
    return { sql, raw, bind: (...values) => statement(sql, values),
      async first(...values) { await before([sql]); try { const result = await raw().first(...values); if (requested('delete', sql)) writes.push({ kind: 'first', sql: [sql], result }); return result; } catch (e) { errors.push(e.message); throw e; } },
      all: (...values) => raw().all(...values),
      async run(...values) { await before([sql]); try { const result = await raw().run(...values); if (requested('put', sql) || requested('delete', sql)) writes.push({ kind: 'run', sql: [sql], result }); return result; } catch (e) { errors.push(e.message); throw e; } },
    };
  }
  const db = { prepare: statement, async batch(statements) {
    const sql = statements.map(s => s.sql); await before(sql); // Before native batch transaction.
    try { const result = await native.batch(statements.map(s => s.raw())); if (sql.some(s => requested('create', s))) writes.push({ kind: 'batch', sql, result }); return result; }
    catch (e) { errors.push(e.message); throw e; }
  } };
  const env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: '', DEFAULT_LLM_MODEL: 'instance', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: '', DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime', REALTIME_MODEL: 'kataleptic-realtime-hd' };
  const path = '/api/me/knowledge/collections';
  const request = (url, body, method = body === undefined ? 'GET' : 'POST') => worker.fetch(new Request('https://openfon.test' + url, { method, headers: { Cookie: 'ofs=session', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, { waitUntil() {}, passThroughOnException() {} });
  const create = (name = 'Wanted', description = '') => request(path, { name, description });
  const put = (id = 'one', body = { name: 'Wanted' }) => request(`${path}/${id}`, body, 'PUT');
  const remove = (id = 'one') => request(`${path}/${id}`, undefined, 'DELETE');
  async function reset() {
    gate = undefined; writes = []; errors = [];
    await exec("DROP TRIGGER IF EXISTS synthetic_late; DELETE FROM users; DELETE FROM rate_counters; INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'); INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01'); INSERT INTO businesses(id,user_id,slug,name,description) VALUES('biz','owner','owned','Owned','Synthetic'); INSERT INTO agent_settings(business_id) VALUES('biz'); INSERT INTO provider_settings(business_id) VALUES('biz');");
    assert.equal((await request('/api/me/bootstrap')).status, 200);
    await exec("INSERT INTO knowledge_collections(id,business_id,name,description) VALUES('one','biz','One','Original'),('two','biz','Two','Peer'); INSERT INTO knowledge_items(id,business_id,collection_id,kind,status,content) VALUES('custom','biz','one','note','active','Custom knowledge'); INSERT INTO assistant_knowledge_collections(assistant_id,collection_id) VALUES('asst_biz','one');");
    writes = []; errors = [];
  }
  function capture(name, data) { captures.push({ name, ...data, writes: [...writes], errors: [...errors] }); console.log(JSON.stringify({ diagnostic: name, status: data.status })); }
  async function duplicate(lane, final = false) {
    await reset(); if (final) await setCount(99);
    const h = hold(lane), pending = lane === 'create' ? create('  Wanted  ') : put();
    try {
      await h.reached; const peer = await create(), winner = await peer.json(); assert.equal(peer.status, 201);
      const baseline = await snapshot(), spent = await count(); h.release(); const response = await pending, body = await response.json(), after = await snapshot();
      const retry = lane === 'create' ? await create() : await put(), afterRetry = await snapshot();
      capture(`${lane}-duplicate${final ? '-final' : ''}`, { status: response.status, body, winner, baseline, after, retryStatus: retry.status, afterRetry });
      assert.equal(response.status, 409); // Original first failure follows full persisted/quota/retry captures.
      assert.deepEqual(body, { error: lane === 'create' ? 'A collection with this name already exists' : 'Collection changed. Reload and retry.' });
      assert.deepEqual(after, baseline); assert.equal(retry.status, 409); assert.deepEqual(afterRetry, baseline); assert.equal(await count(), spent);
      const last = writes.at(-1); assert.ok(last);
      if (lane === 'create') { assert.equal(last.sql.length, 1); assert.deepEqual(last.result[0].results, []); assert.equal(last.result[0].meta.changes, 0); }
      else { assert.equal(last.result.meta.changes, 0); assert.deepEqual(last.result.results, []); }
      if (final) assert.equal(spent, 100);
    } finally { h.release(); await pending; h.clear(); }
  }
  const cases = {
    'create-duplicate': () => duplicate('create'),
    'put-duplicate': () => duplicate('put'),
    async 'delete-promoted'() {
      await reset(); await exec("UPDATE knowledge_collections SET is_default=0 WHERE id='kc_default_biz'; INSERT INTO knowledge_items(id,business_id,collection_id,kind,status,content) VALUES('recovery-custom','biz','kc_default_biz','note','active','Keep recovery knowledge');");
      const initial = await snapshot(), h = hold('delete'), pending = remove('kc_default_biz');
      try {
        await h.reached; assert.equal((await request('/api/me/bootstrap')).status, 200);
        const baseline = await snapshot(); assert.equal((await query("SELECT is_default FROM knowledge_collections WHERE id='kc_default_biz'"))[0].is_default, 1);
        h.release(); const response = await pending, after = await snapshot(); capture('delete-promoted', { status: response.status, initial, baseline, after });
        assert.equal(response.status, 409); assert.deepEqual(after, baseline); assert.notDeepEqual(baseline, initial); assert.equal(writes.at(-1).kind, 'first'); assert.equal(writes.at(-1).result, null);
      } finally { h.release(); await pending; h.clear(); }
    },
    async 'delete-disappeared'() {
      await reset(); const h = hold('delete'), pending = remove();
      try { await h.reached; assert.equal((await remove()).status, 200); const baseline = await snapshot(); h.release(); const response = await pending, after = await snapshot(); capture('delete-disappeared', { status: response.status, baseline, after }); assert.equal(response.status, 409); assert.deepEqual(after, baseline); assert.equal(writes.at(-1).result, null); }
      finally { h.release(); await pending; h.clear(); }
    },
    async 'accepted-and-cascades'() {
      await reset(); const spent = await count(), response = await create('  Unicode 👋  ', '  Details é  '), body = await response.json();
      const persisted = await native.prepare('SELECT * FROM knowledge_collections WHERE id=?').bind(body.id).first();
      capture('accepted-create', { status: response.status, body, persisted, after: await snapshot() });
      assert.equal(response.status, 201); assert.deepEqual(body, persisted); assert.equal(body.name, 'Unicode 👋'); assert.equal(body.description, 'Details é'); assert.equal(body.is_default, 0); assert.equal(await count(), spent + 1); assert.deepEqual(writes.at(-1).result[0].results, [body]); assert.equal(writes.at(-1).result[0].meta.changes, 2);
      assert.equal((await put('one', {})).status, 200); assert.equal(writes.at(-1).result.meta.changes, 2); assert.equal(await count(), spent + 2);
      await setCount(100); const baseline = await snapshot(); assert.equal((await remove()).status, 200); const after = await snapshot(); capture('accepted-delete', { status: 200, baseline, after });
      assert.deepEqual(writes.at(-1).result, { id: 'one' }); assert.deepEqual(await query("SELECT * FROM knowledge_items WHERE collection_id='one'"), []); assert.deepEqual(await query("SELECT * FROM assistant_knowledge_collections WHERE collection_id='one'"), []); assert.equal(await count(), 100);
    },
    async 'quota-vs-duplicate'() {
      await duplicate('create', true); await duplicate('put', true);
      const baseline = await snapshot(); assert.equal((await create('Unique')).status, 429); assert.equal((await put('one', { name: 'Unique' })).status, 429); const after = await snapshot(); capture('unique-quota', { status: 429, baseline, after }); assert.deepEqual(after, baseline);
    },
    async 'post-repair-create'() {
      await reset(); await exec("UPDATE knowledge_collections SET is_default=0 WHERE id='kc_default_biz'");
      const initial = await snapshot(), h = hold('create'), pending = create();
      try {
        await h.reached; const baseline = await snapshot(), spent = await count(); h.release(); const response = await pending, after = await snapshot(); capture('post-repair-create', { status: response.status, initial, baseline, after });
        assert.equal(response.status, 201); assert.notDeepEqual(initial, baseline); assert.equal(await count(), spent + 1);
        for (const name of ['assistants','provider_settings','agent_settings','compatibility_sync_state','assistant_knowledge_collections','knowledge_items']) assert.deepEqual(after.find(t => t.name === name), baseline.find(t => t.name === name));
      } finally { h.release(); await pending; h.clear(); }
    },
    async 'late-abort'() {
      for (const lane of ['create','put','delete']) {
        await reset(); const event = lane === 'create' ? 'INSERT' : lane === 'put' ? 'UPDATE' : 'DELETE';
        await exec(`CREATE TRIGGER synthetic_late AFTER ${event} ON knowledge_collections WHEN ${lane === 'delete' ? "OLD.id='one'" : "NEW.name='Fault'"} BEGIN INSERT INTO rate_counters(bucket,window_start,count) VALUES('synthetic-late',0,1); SELECT RAISE(ABORT,'SYNTHETIC_COLLECTION_LATE'); END;`);
        const baseline = await snapshot(), response = lane === 'create' ? await create('Fault') : lane === 'put' ? await put('one', { name: 'Fault' }) : await remove(), after = await snapshot();
        capture(`${lane}-late-abort`, { status: response.status, baseline, after }); assert.equal(response.status, 500); assert.ok(errors.some(e => e.includes('SYNTHETIC_COLLECTION_LATE'))); assert.deepEqual(after, baseline);
      }
    },
  };
  const selected = process.env.OPENFON_COLLECTION_NATIVE_CASE ? [process.env.OPENFON_COLLECTION_NATIVE_CASE] : Object.keys(cases);
  for (const name of selected) {
    assert.ok(Object.hasOwn(cases, name)); activeCase = name;
    await cases[name](); outcomes.push({ name, status: 'PASS' }); console.log(JSON.stringify(outcomes.at(-1))); activeCase = undefined;
  }
} catch (e) {
  outcomes.push({ name: activeCase ?? 'setup-or-harness', status: 'FAIL', message: e.message }); console.error(JSON.stringify(outcomes.at(-1))); process.exitCode = 1;
} finally {
  try { await writeFile(join(evidence, 'native-result.json'), JSON.stringify({ outcomes, captures }, null, 2)); }
  catch (e) { console.error(JSON.stringify({ status: 'EVIDENCE_WRITE_FAILURE', message: e.message })); process.exitCode = 1; }
  try { if (mf) await mf.dispose(); disposed = true; }
  catch (e) { console.error(JSON.stringify({ status: 'DISPOSAL_FAILURE', message: e.message })); process.exitCode = 1; }
  if (disposed) {
    try { await rm(temp, { recursive: true, force: true }); }
    catch (e) { disposed = false; console.error(JSON.stringify({ status: 'TEMP_CLEANUP_FAILURE', message: e.message })); process.exitCode = 1; }
  }
  console.log(JSON.stringify({ disposal: disposed ? 'completed' : 'unconfirmed; owned temp retained' }));
}
