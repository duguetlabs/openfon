// Local workerd/D1 persistence with Node-bundled production handlers.
// No full workerd-handler concurrency or transport-loss idempotency claim.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'openfon-create-response-'));
let mf, disposed = false;
const captures = [], outcomes = [];
try {
  await build({ stdin: { contents: "export { default } from './src/index';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'handler.mjs') });
  const { default: worker } = await import(pathToFileURL(join(temp, 'handler.mjs')).href);
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false, port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252),
    workers: [{ name: 'create-response', modules: true, script: 'export default {fetch(){return new Response("local D1")}}', compatibilityDate: '2026-05-01', d1Databases: { DB: 'create-response' }, outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready; const native = await mf.getD1Database('DB', 'create-response');
  const exec = sql => native.batch(unstable_splitSqlQuery(sql).map(s => native.prepare(s)));
  const migrations = (await readdir(join(root, 'migrations'))).filter(n => /^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0, 4)) <= 22).sort(); assert.equal(migrations.length, 22);
  for (const file of migrations) await exec(await readFile(join(root, 'migrations', file), 'utf8'));
  const snapshot = async () => {
    const tables = (await native.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all()).results;
    const rows = []; for (const { name } of tables) rows.push({ name, rows: (await native.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results }); return rows;
  };
  const responseSql = 'SELECT * FROM assistants WHERE id = ?';
  // The expression is valid SQL at prepare time and evaluated only for the
  // requested row: it can fail only after the first statement inserted that row.
  const failedReadSql = "SELECT *, CASE WHEN id IS NOT NULL THEN json('SYNTHETIC_RESPONSE_READ_FAILURE') END AS injected_failure FROM assistants WHERE id = ?";
  let failRead = false, failAttachment = false, changeProvider = false, baseline, finalBatch, responseOutside = 0, observedErrors = [];
  function tracked(sql, args = []) {
    return { sql, raw: () => native.prepare(sql).bind(...args), bind: (...values) => tracked(sql, values),
      first: async (...values) => { if (sql === responseSql || sql === failedReadSql) responseOutside++; try { return await native.prepare(sql).bind(...args).first(...values); } catch (e) { observedErrors.push(e.message); throw e; } },
      all: (...values) => native.prepare(sql).bind(...args).all(...values),
      run: (...values) => native.prepare(sql).bind(...args).run(...values) };
  }
  const db = {
    prepare(sql) {
      if (sql === responseSql && failRead) { failRead = false; return tracked(failedReadSql); }
      if (sql.includes('INSERT OR IGNORE INTO assistant_knowledge_collections') && sql.includes('changes()>0') && failAttachment) {
        failAttachment = false; return tracked(sql + " AND json('SYNTHETIC_ATTACHMENT_EXECUTION_FAILURE')");
      }
      return tracked(sql);
    },
    async batch(statements) {
      const requested = statements.some(s => s.sql.includes('INSERT INTO assistants ('));
      if (requested) {
        if (changeProvider) { changeProvider = false; await exec("UPDATE provider_settings SET realtime_provider='custom' WHERE business_id='biz'"); }
        baseline = await snapshot(); finalBatch = statements.map(s => s.sql);
      }
      try { return await native.batch(statements.map(s => s.raw())); }
      catch (e) { observedErrors.push(e.message); throw e; }
    },
  };
  const env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: '', DEFAULT_LLM_MODEL: 'instance', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: '', DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime', REALTIME_MODEL: 'kataleptic-realtime-hd' };
  const request = (path, body) => worker.fetch(new Request('https://openfon.test' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: 'ofs=session', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil() {}, passThroughOnException() {} });
  const create = () => request('/api/me/assistants', { name: '  New draft  ' });
  async function reset() {
    failRead = failAttachment = changeProvider = false; baseline = finalBatch = undefined; responseOutside = 0; observedErrors = [];
    await exec("DELETE FROM users; DELETE FROM rate_counters; INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'); INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01'); INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','owned','Owned'); INSERT INTO agent_settings(business_id) VALUES('biz'); INSERT INTO provider_settings(business_id) VALUES('biz');");
    assert.equal((await request('/api/me/bootstrap')).status, 200);
  }
  const budget = state => state.find(t => t.name === 'rate_counters').rows.filter(r => r.bucket === 'assistants:biz').reduce((n, r) => n + r.count, 0);
  async function failingRead(repair) {
    await reset(); if (repair) await exec('DELETE FROM assistants; DELETE FROM provider_settings;'); const initial = await snapshot();
    failRead = true; const failed = await create(); const afterFailure = await snapshot(); const savedBaseline = baseline;
    const errors = [...observedErrors], sqlChain = finalBatch, readOutside = responseOutside;
    const retry = await create(); const row = await retry.json(); const afterRetry = await snapshot();
    captures.push({ name: repair ? 'repair-response-failure' : 'response-failure', initial, baseline: savedBaseline, afterFailure, afterRetry, failedStatus: failed.status, retryStatus: retry.status, retryId: row.id, errors, sqlChain, readOutside });
    console.log(JSON.stringify({ diagnostic: 'response-failure', repair, failedStatus: failed.status, retryStatus: retry.status, readOutside, unchanged: JSON.stringify(savedBaseline) === JSON.stringify(afterFailure) }));
    assert.equal(failed.status, 500); assert.ok(errors.some(e => /malformed JSON/.test(e)));
    assert.deepEqual(afterFailure, savedBaseline); // Original first failure: committed duplicate state survives.
    assert.equal(readOutside, 0); assert.equal(sqlChain.length, 3); assert.ok(sqlChain[2].includes('SYNTHETIC_RESPONSE_READ_FAILURE'));
    if (repair) assert.notDeepEqual(savedBaseline, initial); else assert.deepEqual(savedBaseline, initial);
    assert.equal(retry.status, 201); assert.equal(budget(afterRetry), budget(savedBaseline) + 1);
    assert.deepEqual((await native.prepare("SELECT id FROM assistants WHERE name='New draft'").all()).results, [{ id: row.id }]);
    assert.deepEqual((await native.prepare('SELECT collection_id FROM assistant_knowledge_collections WHERE assistant_id=?').bind(row.id).all()).results, [{ collection_id: 'kc_default_biz' }]);
  }
  const cases = {
    'response-failure': () => failingRead(false),
    'repair-response-failure': () => failingRead(true),
    'accepted-result': async () => {
      await reset(); const response = await create(); const row = await response.json(); const persisted = await native.prepare('SELECT * FROM assistants WHERE id=?').bind(row.id).first();
      captures.push({ name: 'accepted-result', status: response.status, row, persisted, finalBatch, responseOutside });
      assert.equal(response.status, 201); assert.deepEqual(row, persisted); assert.equal(responseOutside, 0); assert.equal(finalBatch.length, 3);
      assert.equal(row.name, 'New draft'); assert.equal(row.state, 'draft'); assert.equal(row.language, 'en'); assert.ok(row.created_at); assert.ok(row.updated_at); assert.ok(row.public_slug);
      assert.deepEqual((await native.prepare('SELECT collection_id FROM assistant_knowledge_collections WHERE assistant_id=?').bind(row.id).all()).results, [{ collection_id: 'kc_default_biz' }]);
    },
    'provider-conflict': async () => {
      await reset(); changeProvider = true; const response = await create(); const after = await snapshot();
      captures.push({ name: 'provider-conflict', status: response.status, baseline, after }); assert.equal(response.status, 409); assert.deepEqual(after, baseline);
    },
    'attachment-rollback': async () => {
      await reset(); failAttachment = true; const response = await create(); const after = await snapshot();
      captures.push({ name: 'attachment-rollback', status: response.status, baseline, after, errors: observedErrors });
      assert.equal(response.status, 500); assert.ok(observedErrors.some(e => /malformed JSON/.test(e))); assert.deepEqual(after, baseline);
    },
  };
  const selected = process.env.OPENFON_CREATE_NATIVE_CASE ? [process.env.OPENFON_CREATE_NATIVE_CASE] : Object.keys(cases);
  for (const name of selected) {
    assert.ok(Object.hasOwn(cases, name));
    try { await cases[name](); outcomes.push({ name, status: 'PASS' }); }
    catch (e) { outcomes.push({ name, status: 'FAIL', message: e.message }); process.exitCode = 1; }
    console.log(JSON.stringify(outcomes.at(-1)));
  }
} catch (e) { console.error(JSON.stringify({ status: 'SETUP_OR_HARNESS_FAILURE', message: e.message })); process.exitCode = 1; }
finally {
  try {
    if (process.env.OPENFON_CREATE_EVIDENCE_DIR) {
      await mkdir(process.env.OPENFON_CREATE_EVIDENCE_DIR, { recursive: true });
      await writeFile(join(process.env.OPENFON_CREATE_EVIDENCE_DIR, 'native-result.json'), JSON.stringify({ outcomes, captures }, null, 2));
    }
  } catch (e) { console.error(JSON.stringify({ status: 'EVIDENCE_WRITE_FAILURE', message: e.message })); process.exitCode = 1; }
  try { if (mf) await mf.dispose(); disposed = true; } catch (e) { console.error(JSON.stringify({ status: 'DISPOSAL_FAILURE', message: e.message })); process.exitCode = 1; }
  if (disposed) await rm(temp, { recursive: true, force: true });
  console.log(JSON.stringify({ disposal: disposed ? 'completed' : 'unconfirmed; owned temp retained' }));
}
