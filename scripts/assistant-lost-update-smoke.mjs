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
const temp = await mkdtemp(join(tmpdir(), 'openfon-assistant-lost-update-'));
let mf;
try {
  for (const name of ['src/index.ts', 'src/studio-api.ts', 'src/assistant-write-snapshot.ts']) console.log(name, createHash('sha256').update(await readFile(join(root, name))).digest('hex'));
  await build({ entryPoints: [join(root, 'src/index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'worker.mjs') });
  const { default: worker } = await import(pathToFileURL(join(temp, 'worker.mjs')).href);
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false,
    port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252),
    workers: [{ name: 'assistant-lost-update', modules: true, script: 'export default {fetch(){return new Response("local D1")}}',
      compatibilityDate: '2026-05-01', d1Databases: { DB: 'assistant-lost-update' },
      outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready;
  const db = await mf.getD1Database('DB', 'assistant-lost-update');
  const exec = sql => db.batch(unstable_splitSqlQuery(sql).map(s => db.prepare(s)));
  for (const file of (await readdir(join(root, 'migrations'))).filter(x => /^\d{4}_.*\.sql$/.test(x)).sort()) await exec(await readFile(join(root, 'migrations', file), 'utf8'));
  await exec(`INSERT INTO users(id,email,password_hash) VALUES('u1','synthetic@example.invalid','unused');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('s1','u1','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES('b1','u1','one','One','Workshop');
    INSERT INTO agent_settings(business_id) VALUES('b1');
    INSERT INTO provider_settings(business_id) VALUES('b1');
    INSERT INTO assistants(id,business_id,public_slug) VALUES('asst_b1','b1','one');`);
  const sqlByStatement = new WeakMap();
  let beforeBatch = null, lastResults = [];
  function wrap(statement, sql) {
    const proxy = new Proxy(statement, { get(target, prop) {
      if (prop === 'bind') return (...args) => wrap(target.bind(...args), sql);
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    sqlByStatement.set(proxy, { sql, statement }); return proxy;
  }
  const proxyDb = { prepare: sql => wrap(db.prepare(sql), sql), batch: async statements => {
    const sql = statements.map(s => sqlByStatement.get(s)?.sql || '');
    const update = sql[0].includes('UPDATE assistants SET name=?');
    const raw = statements.map(s => sqlByStatement.get(s)?.statement || s);
    if (beforeBatch) await beforeBatch({ update, raw });
    const result = await db.batch(raw);
    if (update) lastResults = result;
    return result;
  } };
  const env = { DB: proxyDb, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: 'synthetic-instance',
    DEFAULT_LLM_MODEL: 'model', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: 'synthetic-stt',
    DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime' };
  const request = (path, body, method = body === undefined ? 'GET' : 'PUT') => worker.fetch(new Request('https://openfon.test' + path, {
    method, headers: { Cookie: 'ofs=s1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  const save = (route, body, id = 'asst_b1') => request(route === 'legacy' ? '/api/me/business/b1/agent' : `/api/me/assistants/${id}`, body);
  const ok = async promise => { const r = await promise; assert.equal(r.status, 200, await r.text()); };
  const snapshot = async () => {
    const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all();
    return Promise.all(tables.map(async ({ name }) => ({ name, rows: (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results })));
  };
  const count = async () => (await db.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:b1'").first()).count;
  await ok(request('/api/me/bootstrap'));
  await exec("INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language) VALUES('secondary','b1','secondary','draft','Secondary','Helpful','en')");
  function hold() {
    let entered, release, held = false;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    beforeBatch = async ({ update }) => { if (update && !held) { held = true; entered(); await gate; } };
    return { reached, release, restore() { beforeBatch = null; } };
  }
  const cases = [
    ['studio-primary', 'studio', 'studio', 'asst_b1'], ['legacy-primary', 'legacy', 'legacy', 'asst_b1'],
    ['studio-legacy', 'studio', 'legacy', 'asst_b1'], ['legacy-studio', 'legacy', 'studio', 'asst_b1'],
    ['secondary', 'studio', 'studio', 'secondary'], ['same-next', 'studio', 'studio', 'asst_b1'],
    ['state-change', 'legacy', 'studio', 'asst_b1'],
  ];
  for (const [name, first, second, id] of cases) {
    await ok(save('studio', { greeting: 'Initial', voice: '' }, id));
    const gate = hold(); const pending = save(first, { greeting: 'A greeting' }, id);
    try {
      await gate.reached;
      if (name === 'state-change') await ok(request(`/api/me/assistants/${id}/pause`, {}, 'POST'));
      else await ok(save(second, name === 'same-next' ? { greeting: 'A greeting' } : { voice: 'B voice' }, id));
      const before = await snapshot(), beforeCount = await count(); gate.release();
      const response = await pending, after = await snapshot();
      if (process.env.OPENFON_EVIDENCE_PREFIX) await writeFile(process.env.OPENFON_EVIDENCE_PREFIX + '-' + name + '.json', JSON.stringify({ name, status: response.status, statementChanges: lastResults.map(r => r.meta.changes), before, after }, null, 2));
      assert.equal(response.status, 409, await response.text());
      assert.ok(lastResults.every(r => r.meta.changes === 0), 'Every refused chain statement is unchanged');
      assert.deepEqual(after, before, 'Refused mutation preserves full state and counters');
      gate.restore(); await ok(save(first, { greeting: 'A greeting' }, id));
      assert.equal(await count(), beforeCount + 1);
      const row = await db.prepare('SELECT greeting,voice FROM assistants WHERE id=?').bind(id).first();
      assert.equal(row.greeting, 'A greeting');
      if (!['same-next', 'state-change'].includes(name)) assert.equal(row.voice, 'B voice');
      console.log('PASS native conflict/all statements0/full snapshot/fresh retry one charge:', name);
    } finally { gate.release(); await pending; gate.restore(); }
  }
  for (const route of ['studio', 'legacy']) {
    for (const failure of ['quota', 'late']) {
      await exec(`UPDATE rate_counters SET count=${failure === 'quota' ? 200 : 10} WHERE bucket='assistants:b1'`);
      if (failure === 'late') beforeBatch = async ({ update, raw }) => { if (update) raw.push(db.prepare("SELECT json('SYNTHETIC_LATE_FAILURE')")); };
      const before = await snapshot();
      try { const response = await save(route, { greeting: 'Refused' }); assert.equal(response.status, failure === 'quota' ? 429 : 500); }
      finally { beforeBatch = null; }
      assert.deepEqual(await snapshot(), before);
      console.log('PASS native rollback:', route, failure);
    }
  }
} finally { if (mf) await mf.dispose(); await rm(temp, { recursive: true, force: true }); }
