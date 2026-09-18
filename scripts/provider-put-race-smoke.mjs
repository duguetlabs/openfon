// Actual production Hono handlers in Node with native local workerd/D1 storage.
// The D1 proxy holds a batch before its transaction; no provider/network calls.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { unstable_splitSqlQuery } from 'wrangler';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'openfon-provider-put-'));
let mf;
try {
  for (const name of ['src/index.ts', 'src/studio-api.ts']) console.log(name, createHash('sha256').update(await readFile(join(root, name))).digest('hex'));
  await build({ entryPoints: [join(root, 'src/index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'worker.mjs') });
  const { default: worker } = await import(pathToFileURL(join(temp, 'worker.mjs')).href);
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false,
    port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252),
    workers: [{ name: 'provider-put', modules: true, script: 'export default {fetch(){return new Response("local D1")}}',
      compatibilityDate: '2026-05-01', d1Databases: { DB: 'provider-put' },
      outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready;
  const db = await mf.getD1Database('DB', 'provider-put');
  const exec = sql => db.batch(unstable_splitSqlQuery(sql).map(s => db.prepare(s)));
  for (const file of (await readdir(join(root, 'migrations'))).filter(x => /^\d{4}_.*\.sql$/.test(x)).sort()) await exec(await readFile(join(root, 'migrations', file), 'utf8'));
  await exec(`INSERT INTO users(id,email,password_hash) VALUES('u1','synthetic@example.invalid','unused');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('s1','u1','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES('b1','u1','one','One','Workshop');
    INSERT INTO agent_settings(business_id) VALUES('b1');
    INSERT INTO provider_settings(business_id) VALUES('b1');
    INSERT INTO assistants(id,business_id,public_slug) VALUES('asst_b1','b1','one');`);
  const sqlByStatement = new WeakMap();
  let beforeBatch = null, missingRead = 0, lastProviderResults = [], lastError = '';
  function wrap(statement, sql) {
    const proxy = new Proxy(statement, { get(target, prop) {
      if (prop === 'bind') return (...args) => wrap(target.bind(...args), sql);
      if (prop === 'first' && missingRead && sql === 'SELECT * FROM provider_settings WHERE business_id = ?') return async (...args) => {
        if (--missingRead === 0) await exec("DELETE FROM provider_settings WHERE business_id='b1'");
        return target.first(...args);
      };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    sqlByStatement.set(proxy, { sql, statement }); return proxy;
  }
  const proxyDb = { prepare: sql => wrap(db.prepare(sql), sql), batch: async statements => {
    const sql = statements.map(s => sqlByStatement.get(s)?.sql || '');
    const provider = sql[0].includes('INSERT INTO provider_settings (business_id, llm_base_url, llm_api_key, llm_model,');
    const raw = statements.map(s => sqlByStatement.get(s)?.statement || s);
    if (beforeBatch) await beforeBatch({ provider, raw });
    try {
      const results = await db.batch(raw);
      if (provider) lastProviderResults = results.map((r, i) => ({ sql: sql[i], changes: r.meta.changes }));
      return results;
    } catch (error) {
      lastError = ''; let cause = error;
      for (let i = 0; i < 5 && cause instanceof Error; i++, cause = cause.cause) lastError += cause.message + '\n';
      throw error;
    }
  } };
  const env = { DB: proxyDb, DEFAULT_LLM_BASE_URL: 'https://api.kataleptic.com/v1', DEFAULT_LLM_API_KEY: 'synthetic-instance',
    DEFAULT_LLM_MODEL: 'llama-3.3-70b', DEFAULT_STT_BASE_URL: 'https://api.kataleptic.com/v1', DEFAULT_STT_API_KEY: 'synthetic-stt',
    DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_MODEL: 'kataleptic-realtime', REALTIME_BASE_URL: 'wss://api.kataleptic.com/v1/realtime' };
  const request = (path, body) => worker.fetch(new Request('https://openfon.test' + path, {
    method: body === undefined ? 'GET' : 'PUT', headers: { Cookie: 'ofs=s1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  const put = body => request('/api/me/provider', body);
  const ok = async promise => { const r = await promise; assert.equal(r.status, 200, await r.text()); };
  const snapshot = async () => {
    const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all();
    return Promise.all(tables.map(async ({ name }) => ({ name, rows: (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results })));
  };
  const count = async () => (await db.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:b1'").first()).count;
  const custom = { realtime_provider: 'custom', realtime_base_url: 'wss://custom.example/realtime', realtime_api_key: 'synthetic-custom' };
  const openai = { realtime_provider: 'openai', realtime_base_url: 'wss://api.openai.com/v1/realtime', realtime_api_key: 'synthetic-openai' };
  const fields = { engine: 'realtime', realtime_model: 'custom-model', realtime_voice: 'custom-voice', language: 'de' };
  await ok(request('/api/me/bootstrap'));
  async function setup() {
    await exec("UPDATE rate_counters SET count=10 WHERE bucket='assistants:b1'");
    await ok(put(custom)); await ok(request('/api/me/assistants/asst_b1', fields));
    await exec("UPDATE assistants SET state='active' WHERE id='asst_b1'");
    await ok(request('/api/me/bootstrap'));
  }
  function hold() {
    let enter, release, held = false;
    const reached = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    beforeBatch = async ({ provider }) => { if (provider && !held) { held = true; enter(); await gate; } };
    return { reached, release, restore() { beforeBatch = null; } };
  }
  for (const scenario of ['stale restore', 'same next', 'text rotation', 'STT rotation', 'missing row', 'deleted row']) {
    await setup();
    if (scenario === 'stale restore') await ok(put(openai));
    if (scenario === 'missing row') missingRead = 2;
    const gate = hold(); const pending = put(scenario === 'same next' || scenario === 'missing row' ? openai : { model: 'partial-' + scenario });
    try {
      await gate.reached;
      if (scenario === 'missing row') assert.equal(await db.prepare("SELECT * FROM provider_settings WHERE business_id='b1'").first(), null);
      if (scenario === 'stale restore') { await ok(put(custom)); await ok(request('/api/me/assistants/asst_b1', fields)); }
      else if (scenario === 'same next') await ok(put(openai));
      else if (scenario === 'text rotation') await ok(put({ apiKey: 'synthetic-rotated-text' }));
      else if (scenario === 'STT rotation') await ok(put({ stt_provider: 'openai', stt_model: 'whisper-1', stt_api_key: 'synthetic-rotated-stt' }));
      else if (scenario === 'missing row') await ok(put(custom));
      else await exec("DELETE FROM provider_settings WHERE business_id='b1'");
      const before = await snapshot(); gate.release();
      const response = await pending;
      const after = await snapshot();
      if (process.env.OPENFON_EVIDENCE_PREFIX) await writeFile(process.env.OPENFON_EVIDENCE_PREFIX + '-' + scenario.replaceAll(' ', '-') + '.json', JSON.stringify({ scenario, status: response.status, before, after }, null, 2));
      assert.equal(response.status, 409, await response.text());
      assert.match(lastError, /\[OPENFON_PROVIDER_WRITE_CONFLICT\]/);
      assert.deepEqual(await snapshot(), before, scenario + ': full persisted snapshot');
      console.log('PASS conflict HTTP409/full snapshot:', scenario, 'native marker:', lastError.trim());
    } finally { gate.release(); await pending; gate.restore(); }
  }
  await setup();
  await ok(request('/api/me/assistants/asst_b1', { realtime_model: 'gpt-realtime', realtime_voice: 'custom-voice' }));
  const beforeCount = await count();
  await ok(put(openai));
  assert.equal(lastProviderResults.find(r => r.sql.startsWith("UPDATE assistants SET realtime_model='' WHERE")).changes, 0);
  assert.equal((await db.prepare("SELECT realtime_voice FROM assistants WHERE id='asst_b1'").first()).realtime_voice, '');
  assert.equal((await db.prepare("SELECT realtime_voice FROM agent_settings WHERE business_id='b1'").first()).realtime_voice, '');
  const saved = JSON.parse((await db.prepare("SELECT agent_snapshot FROM compatibility_sync_state WHERE business_id='b1'").first()).agent_snapshot);
  assert.equal(saved.realtime_voice, ''); assert.equal(saved.realtime_model, 'gpt-realtime');
  assert.equal(await count(), beforeCount + 1);
  await ok(put({ model: 'unrelated-text' })); assert.equal(await count(), beforeCount + 1);
  console.log('PASS zero-row model cleanup continues voice/snapshot; one charge; text-only zero extra charge');
  for (const failure of ['quota', 'late']) {
    await setup();
    if (failure === 'quota') await exec("UPDATE rate_counters SET count=200 WHERE bucket='assistants:b1'");
    else beforeBatch = async ({ provider, raw }) => { if (provider) raw.push(db.prepare("SELECT json('SYNTHETIC_LATE_FAILURE')")); };
    const before = await snapshot();
    try { const response = await put(openai); assert.equal(response.status, failure === 'quota' ? 429 : 500); }
    finally { beforeBatch = null; }
    assert.deepEqual(await snapshot(), before, failure + ' rollback');
    console.log('PASS full rollback:', failure);
  }
} finally { if (mf) await mf.dispose(); await rm(temp, { recursive: true, force: true }); }
