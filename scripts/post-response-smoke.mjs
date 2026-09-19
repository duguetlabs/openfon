// Node-bundled production handlers against workerd/D1. Synthetic DB boundaries;
// no whole-Worker concurrency or transport-loss idempotency claim.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
process.umask(0o077);
const evidence = process.env.OPENFON_POST_EVIDENCE_DIR;
assert.ok(evidence, 'Unique restricted durable evidence directory required');
await mkdir(evidence, { mode: 0o700 }); // Refuse to overwrite a previous run.
const root = resolve(import.meta.dirname, '..'), temp = await mkdtemp(join(tmpdir(), 'openfon-post-response-'));
const captures = [], outcomes = [];
let mf, disposed = false;
try {
  await build({ stdin: { contents: "export { default } from './src/index';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'handler.mjs') });
  const { default: worker } = await import(pathToFileURL(join(temp, 'handler.mjs')).href);
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false, port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252), workers: [{ name: 'post-response', modules: true, script: 'export default {fetch(){return new Response("local D1")}}', compatibilityDate: '2026-05-01', d1Databases: { DB: 'post-response' }, outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready; const native = await mf.getD1Database('DB', 'post-response');
  const exec = sql => native.batch(unstable_splitSqlQuery(sql).map(s => native.prepare(s)));
  const query = async sql => (await native.prepare(sql).all()).results;
  const migrations = (await readdir(join(root, 'migrations'))).filter(n => /^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0, 4)) <= 22).sort(); assert.equal(migrations.length, 22);
  for (const file of migrations) await exec(await readFile(join(root, 'migrations', file), 'utf8'));
  const snapshot = async () => {
    const tables = await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name");
    const result = []; for (const { name } of tables) result.push({ name, rows: await query(`SELECT * FROM "${name}" ORDER BY rowid`) }); return result;
  };
  const table = route => route === 'collection' ? 'knowledge_collections' : route === 'preset' ? 'engine_presets' : 'knowledge_items';
  const bucket = route => `${route === 'collection' ? 'knowledge-collections' : route === 'preset' ? 'presets' : 'knowledge'}:biz`;
  const limit = route => route === 'collection' ? 100 : route === 'preset' ? 400 : 500;
  const charge = route => route === 'preset' ? 2 : 1;
  const count = (state, route) => state.find(t => t.name === 'rate_counters').rows.filter(r => r.bucket === bucket(route)).reduce((n, r) => n + r.count, 0);
  const setCount = async (route, n) => native.prepare("INSERT INTO rate_counters(bucket,window_start,count) VALUES(?,CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400,?) ON CONFLICT(bucket,window_start) DO UPDATE SET count=excluded.count").bind(bucket(route), n).run();
  const responseSql = route => `SELECT * FROM ${table(route)} WHERE id = ?`;
  const isRequested = sql => /^INSERT INTO knowledge_collections \(id, business_id, name, description\)\s+(?:VALUES|SELECT)\b/.test(sql) ||
    (sql.startsWith('INSERT INTO knowledge_items (') && (sql.includes("CASE WHEN ? = 'active'") || sql.includes("VALUES (?, ?, ?, 'faq', 'draft'"))) ||
    (sql.startsWith('INSERT INTO engine_presets (') && sql.includes(') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'));
  let route, failRead = false, failMirror = false, quotaPeer = false, baseline, outsideReads = 0, batches = [], results = [], errors = [];
  async function beforeWrite() {
    if (quotaPeer) { quotaPeer = false; await setCount('preset', 399); }
    if (!baseline) baseline = await snapshot();
  }
  function tracked(sql, args = [], response = false) {
    return { sql, raw: () => native.prepare(sql).bind(...args), bind: (...values) => tracked(sql, values, response),
      first: async (...values) => { if (response) outsideReads++; try { return await native.prepare(sql).bind(...args).first(...values); } catch (e) { errors.push(e.message); throw e; } },
      all: (...values) => native.prepare(sql).bind(...args).all(...values),
      run: async (...values) => { if (isRequested(sql)) await beforeWrite(); return native.prepare(sql).bind(...args).run(...values); } };
  }
  const db = {
    prepare(sql) {
      const response = route && sql === responseSql(route);
      if (response && failRead) { failRead = false; sql = sql.replace('SELECT *', "SELECT *, CASE WHEN id IS NOT NULL THEN json('SYNTHETIC_POST_RESPONSE') END AS injected_failure"); }
      if (failMirror && sql.startsWith('INSERT INTO engine_profiles (')) {
        failMirror = false;
        // Keep all 11 bindings. This valid expression fails only while executing
        // the mirror, once the earlier requested preset row exists in this batch.
        const old = ') VALUES (?, ?, ?, ?,', next = ") VALUES (?, ?, CASE WHEN EXISTS(SELECT 1 FROM engine_presets WHERE business_id='biz' AND name='Saved preset') THEN json('SYNTHETIC_POST_MIRROR') ELSE ? END, ?,";
        assert.ok(sql.includes(old)); sql = sql.replace(old, next);
      }
      return tracked(sql, [], response);
    },
    async batch(statements) {
      const requested = statements.some(s => isRequested(s.sql));
      if (requested) { await beforeWrite(); batches.push(statements.map(s => s.sql)); }
      try { const returned = await native.batch(statements.map(s => s.raw())); if (requested) results.push(returned); return returned; }
      catch (e) { errors.push(e.message); throw e; }
    },
  };
  const env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: '', DEFAULT_LLM_MODEL: 'instance', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: '', DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime', REALTIME_MODEL: 'kataleptic-realtime' };
  const request = (path, body) => worker.fetch(new Request('https://openfon.test' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: 'ofs=session', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, { waitUntil() {}, passThroughOnException() {} });
  const path = kind => ({ collection: '/api/me/knowledge/collections', item: '/api/me/knowledge/collections/kc_default_biz/items', draft: '/api/me/knowledge/drafts/from-turn', preset: '/api/me/engine-presets' })[kind];
  const payload = kind => ({ collection: { name: '  Saved collection  ', description: '  Description 👋  ' }, item: { kind: 'note', status: 'active', title: '  Saved item  ', content: '  Ready 👋  ', source_call_id: 'ignored' }, draft: { callId: 'source', turnId: 1 }, preset: { name: '  Saved preset  ', llm_base_url: 'https://ignored.example/v1', llm_api_key: 'synthetic-ignored' } })[kind];
  const create = () => request(path(route), payload(route));
  async function reset(kind) {
    route = undefined; failRead = failMirror = quotaPeer = false; baseline = undefined; outsideReads = 0; batches = []; results = []; errors = [];
    await exec("DELETE FROM users; DELETE FROM rate_counters; INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'); INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01'); INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','owned','Owned'); INSERT INTO agent_settings(business_id) VALUES('biz'); INSERT INTO provider_settings(business_id) VALUES('biz');");
    assert.equal((await request('/api/me/bootstrap')).status, 200);
    await exec("INSERT INTO calls(id,business_id,assistant_id,environment) VALUES('source','biz','asst_biz','test'); INSERT INTO call_turns(id,call_id,role,text) VALUES(1,'source','caller','  A caller question?  ');");
    route = kind; baseline = undefined; batches = []; results = [];
  }
  async function responseFault(kind, final = false, repair = false) {
    await reset(kind);
    if (final) await setCount(kind, limit(kind) - charge(kind));
    if (repair) await exec("DELETE FROM agent_settings WHERE business_id='biz'");
    const initial = await snapshot(); failRead = true;
    const response = await create(), body = await response.json(), afterFirst = await snapshot();
    const firstBaseline = baseline, firstBatch = batches[0], firstResults = results[0], persisted = body.id ? await native.prepare(`SELECT * FROM ${table(kind)} WHERE id=?`).bind(body.id).first() : undefined;
    const retry = await create(), retryBody = await retry.json(), afterRetry = await snapshot();
    captures.push({ name: `${kind}-${repair ? 'repair' : final ? 'final' : 'response-fault'}`, status: response.status, body, retryStatus: retry.status, retryBody, initial, baseline: firstBaseline, afterFirst, afterRetry, persisted, outsideReads, batches, results, errors });
    console.log(JSON.stringify({ diagnostic: 'post-response', kind, final, repair, status: response.status, retryStatus: retry.status, outsideReads, charges: [count(initial, kind), count(afterFirst, kind), count(afterRetry, kind)] }));
    assert.equal(response.status, 201); // Original first failure; persisted/retry captures already retained.
    assert.equal(outsideReads, 0); assert.deepEqual(body, persisted); assert.equal(count(afterFirst, kind), count(firstBaseline, kind) + charge(kind));
    assert.equal(retry.status, kind === 'collection' ? 409 : final ? 429 : 201);
    assert.equal(count(afterRetry, kind), count(afterFirst, kind) + (kind !== 'collection' && !final ? charge(kind) : 0));
    if (kind === 'collection' || final) assert.deepEqual(afterRetry, afterFirst); else assert.notEqual(body.id, retryBody.id);
    assert.equal(firstBatch.length, kind === 'preset' ? 2 : 1); assert.match(firstBatch[0], /RETURNING \*/); assert.deepEqual(firstResults[0].results, [body]); assert.deepEqual(firstResults.map(r => r.meta.changes), kind === 'preset' ? [2, 2] : [2]);
    assert.ok(body.created_at); assert.ok(body.updated_at);
    if (kind === 'collection') { assert.equal(body.name, 'Saved collection'); assert.equal(body.description, 'Description 👋'); assert.equal(body.is_default, 0); }
    if (kind === 'item') { assert.equal(body.status, 'active'); assert.ok(body.activated_at); assert.equal(body.source_call_id, null); assert.equal(body.source_turn_id, null); assert.equal(body.content, 'Ready 👋'); }
    if (kind === 'draft') { assert.equal(body.status, 'draft'); assert.equal(body.kind, 'faq'); assert.equal(body.activated_at, null); assert.equal(body.question, 'A caller question?'); assert.equal(body.answer, ''); assert.equal(body.source_call_id, 'source'); assert.equal(body.source_turn_id, 1); }
    if (kind === 'preset') {
      const profile = await native.prepare('SELECT id,name,llm_base_url,llm_api_key FROM engine_profiles WHERE id=?').bind(body.id).first();
      assert.deepEqual(profile, { id: body.id, name: 'Saved preset', llm_base_url: '', llm_api_key: '' }); assert.equal(body.engine, 'pipeline'); assert.equal(body.language, 'en');
    }
    if (repair) {
      assert.notDeepEqual(firstBaseline, initial);
      for (const state of [afterFirst, afterRetry]) for (const name of ['assistants', 'provider_settings', 'agent_settings', 'compatibility_sync_state', 'assistant_knowledge_collections']) assert.deepEqual(state.find(t => t.name === name), firstBaseline.find(t => t.name === name));
    } else assert.deepEqual(firstBaseline, initial);
  }
  const cases = {};
  for (const kind of ['collection', 'item', 'draft', 'preset']) cases[`${kind}-response-fault`] = () => responseFault(kind);
  for (const kind of ['collection', 'draft', 'preset']) cases[`${kind}-final`] = () => responseFault(kind, true);
  cases['draft-repair'] = () => responseFault('draft', false, true);
  cases['preset399-preflight'] = async () => {
    await reset('preset'); await setCount('preset', 399); const before = await snapshot();
    const response = await create(), after = await snapshot(); captures.push({ name: 'preset399-preflight', status: response.status, before, after, baseline, batches });
    assert.equal(response.status, 429); assert.deepEqual(after, before); assert.equal(baseline, undefined); assert.deepEqual(batches, []);
  };
  cases['preset-mirror-rollback'] = async () => {
    await reset('preset'); const before = await snapshot(); failMirror = true;
    const response = await create(), after = await snapshot(); captures.push({ name: 'preset-mirror-rollback', status: response.status, before, after, baseline, batches, errors });
    assert.equal(response.status, 500); assert.ok(errors.some(error => /malformed JSON/.test(error))); assert.match(batches[0][1], /SYNTHETIC_POST_MIRROR/); assert.deepEqual(after, before);
  };
  cases['preset-quota-peer-rollback'] = async () => {
    await reset('preset'); const initial = await snapshot(); quotaPeer = true;
    const response = await create(), after = await snapshot(); captures.push({ name: 'preset-quota-peer-rollback', status: response.status, initial, baseline, after, batches, errors });
    assert.equal(response.status, 429); assert.ok(errors.some(error => /OPENFON_PRESET_WRITE_LIMIT/.test(error))); assert.notDeepEqual(baseline, initial); assert.deepEqual(after, baseline); assert.equal(count(after, 'preset'), 399);
    assert.deepEqual(await query('SELECT * FROM engine_presets'), []); assert.deepEqual(await query('SELECT * FROM engine_profiles'), []);
  };
  const selected = process.env.OPENFON_POST_NATIVE_CASE ? [process.env.OPENFON_POST_NATIVE_CASE] : Object.keys(cases);
  for (const name of selected) {
    assert.ok(Object.hasOwn(cases, name));
    try { await cases[name](); outcomes.push({ name, status: 'PASS' }); }
    catch (e) { outcomes.push({ name, status: 'FAIL', message: e.message }); process.exitCode = 1; }
    console.log(JSON.stringify(outcomes.at(-1)));
  }
} catch (e) { console.error(JSON.stringify({ status: 'SETUP_OR_HARNESS_FAILURE', message: e.message })); process.exitCode = 1; }
finally {
  try { await writeFile(join(evidence, 'native-result.json'), JSON.stringify({ outcomes, captures }, null, 2)); }
  catch (e) { console.error(JSON.stringify({ status: 'EVIDENCE_WRITE_FAILURE', message: e.message })); process.exitCode = 1; }
  try { if (mf) await mf.dispose(); disposed = true; } catch (e) { console.error(JSON.stringify({ status: 'DISPOSAL_FAILURE', message: e.message })); process.exitCode = 1; }
  if (disposed) await rm(temp, { recursive: true, force: true });
  console.log(JSON.stringify({ disposal: disposed ? 'completed' : 'unconfirmed; owned temp retained' }));
}
