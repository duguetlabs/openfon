// Node production handlers against workerd/D1. Synthetic DB boundaries, not
// full Worker concurrency or transport-loss exactly-once delivery.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
process.umask(0o077);
const evidence = process.env.OPENFON_PUT_EVIDENCE_DIR;
assert.ok(evidence, 'A unique restricted durable evidence directory is required');
await mkdir(evidence, { mode: 0o700 }); // Refuse to overwrite an existing run.
const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'openfon-put-response-'));
const captures = [], outcomes = [];
let mf, disposed = false;
try {
  await build({ stdin: { contents: "export { default } from './src/index';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'handler.mjs') });
  const { default: worker } = await import(pathToFileURL(join(temp, 'handler.mjs')).href);
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false, port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252),
    workers: [{ name: 'put-response', modules: true, script: 'export default {fetch(){return new Response("local D1")}}', compatibilityDate: '2026-05-01', d1Databases: { DB: 'put-response' }, outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready; const native = await mf.getD1Database('DB', 'put-response');
  const exec = sql => native.batch(unstable_splitSqlQuery(sql).map(s => native.prepare(s)));
  const query = async sql => (await native.prepare(sql).all()).results;
  const migrations = (await readdir(join(root, 'migrations'))).filter(n => /^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0, 4)) <= 22).sort(); assert.equal(migrations.length, 22);
  for (const file of migrations) await exec(await readFile(join(root, 'migrations', file), 'utf8'));
  const snapshot = async () => {
    const tables = await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name");
    const result = []; for (const { name } of tables) result.push({ name, rows: await query(`SELECT * FROM "${name}" ORDER BY rowid`) }); return result;
  };
  const id = target => target === 'primary' ? 'asst_biz' : target;
  const table = target => target === 'item' ? 'knowledge_items' : 'assistants';
  const responseSql = target => `SELECT * FROM ${table(target)} WHERE id = ?`;
  const isWrite = sql => sql.startsWith('UPDATE assistants SET name=') || sql.startsWith('UPDATE knowledge_items SET collection_id=');
  const bucket = target => `${target === 'item' ? 'knowledge' : 'assistants'}:biz`;
  const quota = target => target === 'item' ? 500 : 200;
  const count = (state, target) => state.find(t => t.name === 'rate_counters').rows.filter(r => r.bucket === bucket(target)).reduce((n, r) => n + r.count, 0);
  const row = target => native.prepare(`SELECT * FROM ${table(target)} WHERE id=?`).bind(id(target)).first();
  let failRead, late, peerWrite, baseline, chains = [], batchResults = [], errors = [], outsideReads = 0;
  async function beforeWrite() {
    if (peerWrite) { const sql = peerWrite; peerWrite = undefined; await exec(sql); }
    baseline = await snapshot();
  }
  function tracked(sql, args = []) {
    return { sql, raw: () => native.prepare(sql).bind(...args), bind: (...values) => tracked(sql, values),
      first: async (...values) => {
        if (sql.startsWith('SELECT *, CASE WHEN id IS NOT NULL')) outsideReads++;
        try { return await native.prepare(sql).bind(...args).first(...values); } catch (e) { errors.push(e.message); throw e; }
      },
      all: (...values) => native.prepare(sql).bind(...args).all(...values),
      run: async (...values) => { if (isWrite(sql)) await beforeWrite(); return native.prepare(sql).bind(...args).run(...values); } };
  }
  const db = {
    prepare(sql) {
      if (failRead && sql === responseSql(failRead)) {
        failRead = undefined;
        return tracked(sql.replace('SELECT *', "SELECT *, CASE WHEN id IS NOT NULL THEN json('SYNTHETIC_PUT_RESPONSE_FAILURE') END AS injected_failure"));
      }
      if (late && sql.startsWith(late === 'mirror' ? 'UPDATE agent_settings SET agent_name=' : 'UPDATE compatibility_sync_state SET agent_snapshot=')) {
        // Valid SQL; CASE executes only when the requested first UPDATE has
        // installed its greeting. Snapshot failure additionally requires mirror write.
        const condition = "(SELECT greeting FROM assistants WHERE id='asst_biz')='Saved 👋'" +
          (late === 'snapshot' ? " AND (SELECT greeting FROM agent_settings WHERE business_id='biz')='Saved 👋'" : '');
        sql += ` AND CASE WHEN ${condition} THEN json('SYNTHETIC_LATE_PUT') ELSE 1 END`;
        late = undefined;
      }
      return tracked(sql);
    },
    async batch(statements) {
      const requested = statements.some(s => isWrite(s.sql));
      if (requested) { await beforeWrite(); chains.push(statements.map(s => s.sql)); }
      try { const results = await native.batch(statements.map(s => s.raw())); if (requested) batchResults.push(results); return results; }
      catch (e) { errors.push(e.message); throw e; }
    },
  };
  const env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: '', DEFAULT_LLM_MODEL: 'instance', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: '', DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime', REALTIME_MODEL: 'kataleptic-realtime-hd' };
  const request = (path, body) => worker.fetch(new Request('https://openfon.test' + path, { method: body === undefined ? 'GET' : 'PUT', headers: { Cookie: 'ofs=session', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, { waitUntil() {}, passThroughOnException() {} });
  const save = target => request(`/api/me/${target === 'item' ? 'knowledge/items' : 'assistants'}/${id(target)}`, target === 'item' ? { title: '  Saved 👋  ' } : { greeting: 'Saved 👋' });
  async function reset() {
    failRead = late = peerWrite = baseline = undefined; chains = []; batchResults = []; errors = []; outsideReads = 0;
    await exec("DELETE FROM users; DELETE FROM rate_counters; INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'); INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01'); INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','owned','Owned'); INSERT INTO agent_settings(business_id) VALUES('biz'); INSERT INTO provider_settings(business_id) VALUES('biz');");
    assert.equal((await request('/api/me/bootstrap')).status, 200);
    await exec("INSERT INTO assistants(id,business_id,public_slug) VALUES('secondary','biz','secondary'); INSERT INTO calls(id,business_id) VALUES('source','biz'); INSERT INTO call_turns(id,call_id,role,text) VALUES(1,'source','caller','Source'); INSERT INTO knowledge_items(id,business_id,collection_id,kind,status,title,content,source_call_id,source_turn_id) VALUES('item','biz','kc_default_biz','note','draft','Original','Ready content','source',1);");
  }
  async function responseFault(target, finalUnit) {
    await reset(); if (finalUnit) await exec(`UPDATE rate_counters SET count=${quota(target) - 1} WHERE bucket='${bucket(target)}'`);
    const before = await snapshot(); failRead = target;
    const response = await save(target), body = await response.json(), afterFirst = await snapshot(), firstRow = await row(target);
    const firstBaseline = baseline, firstErrors = [...errors];
    const retry = await save(target), retryBody = await retry.json(), afterRetry = await snapshot();
    captures.push({ name: `${target}-${finalUnit ? 'final' : 'spare'}-response-fault`, before, baseline: firstBaseline, afterFirst, afterRetry, status: response.status, body, retryStatus: retry.status, retryBody, outsideReads, errors: firstErrors, chains, batchResults });
    console.log(JSON.stringify({ diagnostic: 'put-response', target, finalUnit, status: response.status, retryStatus: retry.status, outsideReads, charges: [count(before, target), count(afterFirst, target), count(afterRetry, target)] }));
    assert.equal(response.status, 200); // Original first assertion: 500 after persistence; retry already captured.
    assert.deepEqual(body, firstRow); assert.equal(outsideReads, 0); assert.equal(count(afterFirst, target), count(before, target) + 1);
    assert.equal(retry.status, finalUnit ? 429 : 200); assert.equal(count(afterRetry, target), count(before, target) + (finalUnit ? 1 : 2));
    if (finalUnit) assert.deepEqual(afterRetry, afterFirst);
  }
  const cases = {
    'primary-spare-response-fault': () => responseFault('primary', false),
    'item-final-response-fault': () => responseFault('item', true),
  };
  for (const target of ['primary', 'secondary', 'item']) {
    cases[`${target}-returning`] = async () => {
      await reset(); const before = await snapshot(), response = await save(target), body = await response.json(), after = await snapshot(), persisted = await row(target);
      captures.push({ name: `${target}-returning`, before, after, status: response.status, body, persisted, chains, batchResults });
      assert.equal(response.status, 200); assert.deepEqual(body, persisted); assert.equal(count(after, target), count(before, target) + 1);
      assert.equal(chains.length, 1); assert.equal(chains[0].length, target === 'primary' ? 3 : 1); assert.match(chains[0][0], /RETURNING \*/);
      assert.deepEqual(batchResults[0][0].results, [body]); assert.equal(batchResults[0][0].meta.changes, 2);
      if (target === 'primary') {
        assert.match(chains[0][1], /^UPDATE agent_settings/); assert.match(chains[0][2], /^UPDATE compatibility_sync_state/);
        assert.ok(chains[0].slice(1).every(sql => sql.includes('changes()>0'))); assert.deepEqual(batchResults[0].slice(1).map(r => r.meta.changes), [1, 1]);
        assert.deepEqual(await query("SELECT greeting FROM agent_settings WHERE business_id='biz'"), [{ greeting: 'Saved 👋' }]);
        assert.equal(JSON.parse((await query("SELECT agent_snapshot FROM compatibility_sync_state WHERE business_id='biz'"))[0].agent_snapshot).greeting, 'Saved 👋');
      } else if (target === 'item') { assert.equal(body.source_call_id, 'source'); assert.equal(body.source_turn_id, 1); assert.equal(body.activated_at, null); }
    };
    cases[`${target}-conflict`] = async () => {
      await reset(); peerWrite = target === 'item' ? "UPDATE knowledge_items SET content='Peer' WHERE id='item'" :
        target === 'primary' ? "UPDATE provider_settings SET realtime_provider='custom' WHERE business_id='biz'" : "UPDATE assistants SET voice='Peer' WHERE id='secondary'";
      const response = await save(target), after = await snapshot();
      captures.push({ name: `${target}-conflict`, baseline, after, status: response.status, chains, batchResults });
      assert.equal(response.status, 409); assert.deepEqual(after, baseline);
      assert.ok(batchResults[0].every(result => result.meta.changes === 0 && result.results.length === 0));
    };
  }
  for (const stage of ['mirror', 'snapshot']) cases[`${stage}-rollback`] = async () => {
    await reset(); const before = await snapshot(); late = stage;
    const response = await save('primary'), after = await snapshot();
    captures.push({ name: `${stage}-rollback`, before, baseline, after, status: response.status, errors, chains });
    assert.equal(response.status, 500); assert.ok(errors.some(error => /malformed JSON/.test(error)));
    assert.ok(chains[0][stage === 'mirror' ? 1 : 2].includes('SYNTHETIC_LATE_PUT')); assert.deepEqual(after, before);
  };
  const selected = process.env.OPENFON_PUT_NATIVE_CASE ? [process.env.OPENFON_PUT_NATIVE_CASE] : Object.keys(cases);
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
