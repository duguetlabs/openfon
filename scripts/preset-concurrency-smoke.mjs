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
const temp = await mkdtemp(join(tmpdir(), 'openfon-preset-concurrency-'));
let mf;
try {
  for (const name of ['src/index.ts', 'src/studio-api.ts', 'src/preset-write-snapshot.ts']) console.log(name, createHash('sha256').update(await readFile(join(root, name))).digest('hex'));
  await build({ entryPoints: [join(root, 'src/index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'worker.mjs') });
  const { default: worker } = await import(pathToFileURL(join(temp, 'worker.mjs')).href);
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false,
    port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252),
    workers: [{ name: 'preset-concurrency', modules: true, script: 'export default {fetch(){return new Response("local D1")}}',
      compatibilityDate: '2026-05-01', d1Databases: { DB: 'preset-concurrency' },
      outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready;
  const db = await mf.getD1Database('DB', 'preset-concurrency');
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
    const update = /UPDATE engine_(presets|profiles) SET name=/.test(sql[0]) || sql[0].includes('UPDATE assistants SET engine=?');
    const raw = statements.map(s => sqlByStatement.get(s)?.statement || s);
    if (beforeBatch) await beforeBatch({ update, raw, sql: sql[0] });
    const result = await db.batch(raw);
    if (update) lastResults = result;
    return result;
  } };
  const env = { DB: proxyDb, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: 'synthetic-instance',
    DEFAULT_LLM_MODEL: 'model', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: 'synthetic-stt',
    DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime',
    REALTIME_MODEL: 'kataleptic-realtime', REALTIME_API_KEY: 'synthetic-realtime' };
  const request = (path, body, method = body === undefined ? 'GET' : 'PUT') => worker.fetch(new Request('https://openfon.test' + path, {
    method, headers: { Cookie: 'ofs=s1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  const path = route => route === 'studio' ? '/api/me/engine-presets/preset' : '/api/me/profiles/preset';
  const save = (route, body) => request(path(route), body);
  const apply = route => request(path(route) + '/apply', { assistantId: 'asst_b1' }, 'POST');
  const remove = route => request(path(route), undefined, 'DELETE');
  const ok = async promise => { const r = await promise; assert.equal(r.status, 200, await r.text()); };
  const snapshot = async () => {
    const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all();
    return Promise.all(tables.map(async ({ name }) => ({ name, rows: (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results })));
  };
  const count = async (bucket = 'presets') => (await db.prepare("SELECT count FROM rate_counters WHERE bucket=?").bind(bucket + ':b1').first()).count;
  await ok(request('/api/me/bootstrap'));
  function hold(kind) {
    let entered, release, held = false;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    beforeBatch = async ({ sql }) => { const selected = kind === 'save' ? /UPDATE engine_(presets|profiles) SET name=/.test(sql) : sql.includes('UPDATE assistants SET engine=?'); if (selected && !held) { held = true; entered(); await gate; } };
    return { reached, release, restore() { beforeBatch = null; } };
  }
  async function resetPreset() {
    await exec("DELETE FROM engine_profiles WHERE id='preset'; DELETE FROM engine_presets WHERE id='preset';");
    await exec(`INSERT INTO engine_profiles(id,business_id,name,engine,language) VALUES('preset','b1','Original','realtime','en');
      INSERT INTO engine_presets(id,business_id,name,engine,language) VALUES('preset','b1','Original','realtime','en');`);
  }
  async function evidence(name, response, before, after) {
    if (process.env.OPENFON_EVIDENCE_PREFIX) await writeFile(process.env.OPENFON_EVIDENCE_PREFIX + '-' + name + '.json',
      JSON.stringify({ name, status: response.status, statementChanges: lastResults.map(r => r.meta.changes), before, after }, null, 2));
  }
  for (const route of ['studio', 'legacy']) {
    const other = route === 'studio' ? 'legacy' : 'studio';
    for (const kind of ['save', 'apply']) {
      await resetPreset();
      const gate = hold(kind), pending = kind === 'save' ? save(route, { name: 'A name' }) : apply(route);
      try {
        await gate.reached;
        if (kind === 'save') await ok(save(other, { voice: 'B voice' }));
        else await ok(remove(other));
        const before = await snapshot(); gate.release();
        const response = await pending, after = await snapshot();
        await evidence(route + '-' + kind + '-conflict', response, before, after);
        assert.equal(response.status, 409, await response.text());
        assert.ok(lastResults.every(r => r.meta.changes === 0)); assert.deepEqual(after, before);
        console.log('PASS native conflict/all statements0/full state:', route, kind);
      } finally { gate.release(); await pending; gate.restore(); }
    }
    await resetPreset();
    const beforeSave = await count(); await ok(save(route, { name: 'Grüß dich 👋' }));
    assert.equal(await count(), beforeSave + 2);
    for (const table of ['engine_profiles', 'engine_presets']) {
      assert.deepEqual(await db.prepare(`SELECT name,engine,language FROM ${table} WHERE id='preset'`).first(),
        { name: 'Grüß dich 👋', engine: 'realtime', language: 'en' });
    }
    const gate = hold('apply'), pending = apply(route);
    try {
      await gate.reached; await ok(save(other, { name: 'Renamed while applying' }));
      await ok(request('/api/me/assistants/asst_b1', { greeting: 'Preserved greeting', voice: 'Replaced target voice' }));
      const beforeApply = await count('assistants'); gate.release(); await ok(pending);
      assert.equal(await count('assistants'), beforeApply + 1);
      const target = await db.prepare("SELECT greeting,voice FROM assistants WHERE id='asst_b1'").first();
      assert.deepEqual(target, { greeting: 'Preserved greeting', voice: '' });
      assert.deepEqual(await db.prepare("SELECT greeting,voice FROM agent_settings WHERE business_id='b1'").first(), target);
      const sync = await db.prepare("SELECT agent_snapshot FROM compatibility_sync_state WHERE business_id='b1'").first();
      const saved = JSON.parse(sync.agent_snapshot); assert.equal(saved.greeting, target.greeting); assert.equal(saved.voice, target.voice);
      console.log('PASS native accepted mirrored save2/Apply1 charges, rename and explicit target replacement:', route);
    } finally { gate.release(); await pending; gate.restore(); }
    await resetPreset();
    const mirror = route === 'studio' ? 'engine_profiles' : 'engine_presets';
    await exec(`DELETE FROM ${mirror} WHERE id='preset'`); const beforeMissing = await count();
    await ok(save(route, { name: 'One row' })); assert.equal(await count(), beforeMissing + 1);
    assert.equal(await db.prepare(`SELECT id FROM ${mirror} WHERE id='preset'`).first(), null);
    console.log('PASS native missing mirror success/one charge/no recreation:', route);
    for (const kind of ['save', 'apply']) {
      for (const failure of ['quota', 'late']) {
        await resetPreset();
        const bucket = kind === 'save' ? 'presets' : 'assistants';
        await exec(`UPDATE rate_counters SET count=${failure === 'quota' ? (kind === 'save' ? 400 : 200) : 10} WHERE bucket='${bucket}:b1'`);
        if (failure === 'late') beforeBatch = async ({ update, raw }) => { if (update) raw.push(db.prepare("SELECT json('SYNTHETIC_LATE_FAILURE')")); };
        const before = await snapshot();
        try { const response = await (kind === 'save' ? save(route, { name: 'Refused' }) : apply(route)); assert.equal(response.status, failure === 'quota' ? 429 : 500); }
        finally { beforeBatch = null; }
        assert.deepEqual(await snapshot(), before);
        // Reset only synthetic counters after the asserted rollback, for later cases.
        await exec("UPDATE rate_counters SET count=10 WHERE bucket IN ('presets:b1','assistants:b1')");
        console.log('PASS native full rollback:', route, kind, failure);
      }
    }
  }
} finally { if (mf) await mf.dispose(); await rm(temp, { recursive: true, force: true }); }
