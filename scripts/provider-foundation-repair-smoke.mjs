// Production handlers bundled in Node with native local workerd/D1 storage.
// Provider changes at the held repair INSERT are synthetic DB interleavings.
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
const temp = await mkdtemp(join(tmpdir(), 'openfon-foundation-repair-'));
let mf;
try {
  console.log('Studio SHA256', createHash('sha256').update(await readFile(join(root, 'src/studio-api.ts'))).digest('hex'));
  await build({ entryPoints: [join(root, 'src/index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'worker.mjs') });
  const { default: worker } = await import(pathToFileURL(join(temp, 'worker.mjs')).href);
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false,
    port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252),
    workers: [{ name: 'repair', modules: true, script: 'export default {fetch(){return new Response("local D1")}}',
      compatibilityDate: '2026-05-01', d1Databases: { DB: 'repair' },
      outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready;
  const db = await mf.getD1Database('DB', 'repair');
  const exec = sql => db.batch(unstable_splitSqlQuery(sql).map(s => db.prepare(s)));
  const files = (await readdir(join(root, 'migrations'))).filter(x => /^\d{4}_.*\.sql$/.test(x)).sort();
  assert.ok(files.some(x => x.startsWith('0020_')));
  for (const file of files) await exec(await readFile(join(root, 'migrations', file), 'utf8'));
  let beforeLegacyInsert = null;
  const originals = new WeakMap();
  function wrap(statement, sql) {
    const proxy = new Proxy(statement, { get(target, prop) {
      if (prop === 'bind') return (...args) => wrap(target.bind(...args), sql);
      if (prop === 'run') return async (...args) => {
        if (beforeLegacyInsert && sql.includes('INSERT OR IGNORE INTO agent_settings')) {
          const hook = beforeLegacyInsert; beforeLegacyInsert = null; await hook();
        }
        return target.run(...args);
      };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    originals.set(proxy, statement); return proxy;
  }
  const proxyDb = { prepare: sql => wrap(db.prepare(sql), sql), batch: statements => db.batch(statements.map(s => originals.get(s) || s)) };
  const env = { DB: proxyDb, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: 'synthetic-instance',
    DEFAULT_LLM_MODEL: 'instance-model', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: 'synthetic-instance-stt',
    DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime' };
  const request = (path = '/api/me/bootstrap') => worker.fetch(new Request('https://openfon.test' + path, { headers: { Cookie: 'ofs=s1' } }),
    env, { waitUntil() {}, passThroughOnException() {} });
  const ok = async promise => { const r = await promise; assert.equal(r.status, 200, await r.text()); };
  const seedProvider = () => exec(`INSERT INTO provider_settings(business_id,llm_base_url,llm_api_key,llm_model,realtime_provider,realtime_base_url,
    realtime_api_key,stt_provider,stt_base_url,stt_api_key,stt_model,updated_at)
    VALUES('b1','https://text.example/v1','synthetic-text','custom-text','custom','wss://speech.example/realtime','synthetic-realtime',
      'custom','https://stt.example/v1','synthetic-stt','custom-stt','2001-01-01');`);
  const provider = () => db.prepare("SELECT * FROM provider_settings WHERE business_id='b1'").first();
  const snapshot = async () => {
    const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all();
    return Promise.all(tables.map(async ({ name }) => ({ name, rows: (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results })));
  };
  const cases = process.env.OPENFON_REPAIR_CASE ? [process.env.OPENFON_REPAIR_CASE] : ['surviving', 'absent', 'rotation', 'created', 'winning', 'oldblank'];
  for (const scenario of cases) {
    assert.ok(['surviving', 'absent', 'rotation', 'created', 'winning', 'oldblank'].includes(scenario));
    await exec(`DELETE FROM users; DELETE FROM rate_counters;
      INSERT INTO users(id,email,password_hash) VALUES('u1','repair@example.invalid','unused');
      INSERT INTO sessions(token,user_id,expires_at) VALUES('s1','u1','2099-01-01');
      INSERT INTO businesses(id,user_id,slug,name) VALUES('b1','u1','one','One');`);
    if (['surviving', 'rotation', 'winning'].includes(scenario)) await seedProvider();
    let expectedProvider = await provider(), winningLegacy = null;
    if (scenario === 'rotation' || scenario === 'created') beforeLegacyInsert = async () => {
      if (scenario === 'created') await seedProvider();
      await exec("UPDATE provider_settings SET llm_base_url='https://rotated.example/v1',llm_api_key='synthetic-rotated' WHERE business_id='b1'");
      expectedProvider = await provider();
    };
    if (scenario === 'winning') beforeLegacyInsert = async () => {
      await exec(`INSERT INTO agent_settings(business_id,agent_name,persona,language,greeting,llm_base_url,llm_api_key)
        VALUES('b1','','','','Winning repair','https://text.example/v1','synthetic-text');`);
      winningLegacy = await db.prepare("SELECT * FROM agent_settings WHERE business_id='b1'").first();
    };
    if (scenario === 'oldblank') {
      // Exact old eb13a193 SQL, after all migrations; no credential payload accepted.
      await db.prepare('INSERT INTO agent_settings (business_id) VALUES (?)').bind('b1').run();
      const beforeChange = await snapshot();
      await assert.rejects(exec("UPDATE agent_settings SET llm_api_key='synthetic-old-change' WHERE business_id='b1'"),
        /OPENFON_PROVIDER_CREDENTIAL_WRITE_REQUIRES_CURRENT_WORKER/);
      assert.deepEqual(await snapshot(), beforeChange);
    }
    const before = await snapshot(); await ok(request()); const after = await snapshot();
    if (process.env.OPENFON_EVIDENCE_PREFIX) await writeFile(process.env.OPENFON_EVIDENCE_PREFIX + '-' + scenario + '.json', JSON.stringify({ scenario, before, after }, null, 2));
    const actualProvider = await provider();
    if (expectedProvider) {
      // Stale initial provider read can cause existing reconciliation to stamp time.
      assert.deepEqual(actualProvider, { ...expectedProvider, ...(['rotation', 'created'].includes(scenario) ? { updated_at: actualProvider.updated_at } : {}) });
    } else {
      assert.equal(actualProvider.llm_base_url, ''); assert.equal(actualProvider.llm_api_key, '');
      assert.equal(actualProvider.realtime_provider, 'instance'); assert.equal(actualProvider.stt_provider, 'instance');
    }
    const legacy = await db.prepare("SELECT * FROM agent_settings WHERE business_id='b1'").first();
    assert.equal(legacy.llm_base_url, actualProvider.llm_base_url); assert.equal(legacy.llm_api_key, actualProvider.llm_api_key);
    if (winningLegacy) assert.deepEqual(legacy, winningLegacy);
    const assistant = await db.prepare("SELECT state,activated_at,name,persona,language,greeting FROM assistants WHERE id='asst_b1'").first();
    if (scenario !== 'oldblank') {
      assert.equal(assistant.state, 'draft'); assert.equal(assistant.activated_at, null);
      for (const key of ['name', 'persona', 'language']) assert.equal(assistant[key], '');
      assert.equal((await request('/api/public/agent/one')).status, 404);
    } else {
      assert.equal(legacy.agent_name, 'Alex'); assert.equal(legacy.persona, 'friendly and professional'); assert.equal(legacy.language, 'en');
    }
    if (winningLegacy) assert.equal(assistant.greeting, 'Winning repair');
    const repaired = await snapshot(); await ok(request()); assert.deepEqual(await snapshot(), repaired);
    console.log('PASS native repair/whole provider preservation/repeated stability:', scenario);
  }
} finally { if (mf) await mf.dispose(); await rm(temp, { recursive: true, force: true }); }
