// Native local workerd/D1 migration and persistence, with production handlers
// bundled in Node for the bounded API/helper cases. Not full-Worker concurrency.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { unstable_splitSqlQuery } from 'wrangler';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = resolve(import.meta.dirname, '..');
const original = process.env.OPENFON_TENANT_ORIGINAL === '1';
const guardNames = ['knowledge_item_tenant_insert', 'knowledge_item_tenant_update', 'knowledge_attachment_tenant_insert', 'knowledge_attachment_tenant_update'];
const temp = await mkdtemp(join(tmpdir(), 'openfon-tenant-native-'));
let mf, disposed = false;
try {
  const migration = await readFile(join(root, 'migrations/0021_knowledge_tenant_guards.sql'), 'utf8');
  console.log(JSON.stringify({ schema: original ? 'exact49df-through20' : 'candidate-through21', migration_sha256: createHash('sha256').update(migration).digest('hex') }));
  await build({ stdin: { contents: "export { default } from './src/index'; export { syncLegacyKnowledge } from './src/studio-api';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'handler.mjs') });
  const { default: worker, syncLegacyKnowledge } = await import(pathToFileURL(join(temp, 'handler.mjs')).href);
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false,
    port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252),
    workers: [{ name: 'tenant', modules: true, script: 'export default {fetch(){return new Response("local D1")}}', compatibilityDate: '2026-05-01',
      d1Databases: { DB: 'tenant' }, outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready;
  const db = await mf.getD1Database('DB', 'tenant');
  const exec = sql => db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
  const migrations = (await readdir(join(root, 'migrations'))).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 20).sort();
  assert.equal(migrations.length, 20);
  for (const file of migrations) await exec(await readFile(join(root, 'migrations', file), 'utf8'));
  const env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: '', DEFAULT_LLM_MODEL: 'instance',
    DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: '', DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser',
    REALTIME_BASE_URL: 'wss://instance.example/realtime', REALTIME_MODEL: 'kataleptic-realtime' };
  const request = (path, body, method = body === undefined ? 'GET' : 'POST') => worker.fetch(new Request('https://openfon.test' + path, {
    method, headers: { Cookie: 'ofs=s1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  const drop = () => exec(guardNames.map(name => `DROP TRIGGER IF EXISTS ${name};`).join('\n'));
  const snapshot = async () => {
    const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all();
    const rows = [];
    for (const { name } of tables) rows.push({ name, rows: (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results });
    return rows;
  };
  const schema = async () => (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY type,name").all()).results;
  async function reset(install = !original) {
    await drop(); await exec(`DELETE FROM users; DELETE FROM rate_counters;
      INSERT INTO users(id,email,password_hash) VALUES('u1','one@example.invalid','unused'),('u2','two@example.invalid','unused');
      INSERT INTO sessions(token,user_id,expires_at) VALUES('s1','u1','2099-01-01');
      INSERT INTO businesses(id,user_id,slug,name) VALUES('b1','u1','one','One'),('b2','u2','two','Two');
      INSERT INTO agent_settings(business_id) VALUES('b1'),('b2');
      INSERT INTO provider_settings(business_id) VALUES('b1'),('b2');`);
    assert.equal((await request('/api/me/bootstrap')).status, 200);
    await exec(`INSERT INTO assistants(id,business_id,public_slug) VALUES('a1','b1','extra-one'),('a2','b2','extra-two');
      INSERT INTO knowledge_collections(id,business_id,name) VALUES('c1','b1','One'),('cnext','b1','Next'),('c2','b2','Two');
      INSERT INTO knowledge_items(id,business_id,collection_id,kind,title) VALUES('i1','b1','c1','note','Original');
      INSERT INTO assistant_knowledge_collections(assistant_id,collection_id) VALUES('a1','c1');`);
    if (install) await exec(migration);
  }
  const captures = [];
  async function refuses(name, statement) {
    const before = await snapshot(); let error = '';
    try { await db.prepare(statement).run(); } catch (e) { error = e.message; }
    const after = await snapshot(); captures.push({ name, before, after, error });
    console.log(JSON.stringify({ diagnostic: name, error, unchanged: JSON.stringify(after) === JSON.stringify(before) }));
    assert.match(error, /OPENFON_KNOWLEDGE_TENANT_MISMATCH/);
    assert.deepEqual(after, before);
  }
  const badItem = "INSERT OR IGNORE INTO knowledge_items(id,business_id,collection_id,kind) VALUES('bad','b1','c2','note')";
  const badAttachment = "INSERT OR IGNORE INTO assistant_knowledge_collections(assistant_id,collection_id) VALUES('a1','c2')";
  const cases = {
    'clean-upgrade': async () => {
      await reset(false); const before = await snapshot(); await exec(migration); const after = await snapshot();
      captures.push({ name: 'clean-upgrade', before, after }); assert.deepEqual(after, before);
      const names = (await schema()).map(row => row.name); assert.deepEqual(guardNames.filter(name => names.includes(name)), guardNames);
    },
    'item-refusal': async () => { await reset(); await refuses('item-OR-IGNORE', badItem); },
    'item-update': async () => { await reset(); await refuses('item-update', "UPDATE knowledge_items SET collection_id='c2',title='Rejected' WHERE id='i1'"); },
    'attachment-refusal': async () => {
      await reset(); await refuses('attachment-OR-IGNORE', badAttachment);
      await refuses('attachment-assistant-update', "UPDATE assistant_knowledge_collections SET assistant_id='a2' WHERE assistant_id='a1' AND collection_id='c1'");
      await refuses('attachment-collection-update', "UPDATE assistant_knowledge_collections SET collection_id='c2' WHERE assistant_id='a1' AND collection_id='c1'");
    },
    'missing-parents': async () => {
      await reset();
      await refuses('missing-item-collection', "INSERT INTO knowledge_items(id,business_id,collection_id,kind) VALUES('bad','b1','missing','note')");
      await refuses('missing-attachment-assistant', "INSERT INTO assistant_knowledge_collections(assistant_id,collection_id) VALUES('missing','c1')");
      await refuses('missing-attachment-collection', "INSERT INTO assistant_knowledge_collections(assistant_id,collection_id) VALUES('a1','missing')");
    },
    'corrupt-upgrade': async () => {
      for (const [name, corrupt] of [['item', badItem], ['attachment', badAttachment]]) {
        await reset(false); await exec(corrupt); const before = await snapshot(), beforeSchema = await schema();
        await assert.rejects(exec(migration), /malformed JSON/);
        const after = await snapshot(); captures.push({ name: 'corrupt-upgrade-' + name, before, after });
        assert.deepEqual(after, before); assert.deepEqual(await schema(), beforeSchema);
      }
    },
    'migration-rollback': async () => {
      await reset(false); const before = await snapshot(), beforeSchema = await schema();
      await assert.rejects(exec(migration + "\nSELECT json('SYNTHETIC_LATE_FAILURE');"), /malformed JSON/);
      assert.deepEqual(await schema(), beforeSchema); const after = await snapshot(); captures.push({ name: 'migration-rollback', before, after }); assert.deepEqual(after, before);
    },
    'statement-and-batch': async () => {
      await reset(); await exec("UPDATE businesses SET name='Earlier committed write' WHERE id='b1'");
      // Earlier commit survives statement ABORT. Explicit open-transaction ABORT
      // is covered separately in SQLite; D1 exposes batch, not BEGIN/COMMIT here.
      await refuses('statement-preserves-earlier-commit', badItem);
      assert.equal((await db.prepare("SELECT name FROM businesses WHERE id='b1'").first()).name, 'Earlier committed write');
      const before = await snapshot(); await assert.rejects(exec("UPDATE knowledge_items SET title='Earlier batch write' WHERE id='i1';\n" + badAttachment), /OPENFON_KNOWLEDGE_TENANT_MISMATCH/);
      const after = await snapshot(); captures.push({ name: 'batch-rollback', before, after }); assert.deepEqual(after, before);
    },
    'changes-and-quota': async () => {
      await reset(); const before = await snapshot();
      const zero = await exec("UPDATE assistants SET name='No match' WHERE id='missing'; INSERT OR IGNORE INTO assistant_knowledge_collections SELECT 'a1','cnext',datetime('now') WHERE changes()>0;");
      assert.equal(Boolean(zero[0].meta.changes), false); assert.equal(Boolean(zero[1].meta.changes), false); assert.deepEqual(await snapshot(), before);
      const spent = (await db.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:b1'").first()).count;
      const accepted = await exec("UPDATE assistants SET name='Accepted' WHERE id='a1'; INSERT OR IGNORE INTO assistant_knowledge_collections SELECT 'a1','cnext',datetime('now') WHERE changes()>0;");
      assert.equal(Boolean(accepted[0].meta.changes), true); assert.equal(Boolean(accepted[1].meta.changes), true);
      assert.ok(await db.prepare("SELECT 1 FROM assistant_knowledge_collections WHERE assistant_id='a1' AND collection_id='cnext'").first());
      assert.equal((await db.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:b1'").first()).count, spent + 1);
      // Recreate the original budget trigger after the guard to exercise the
      // alternative registration order without rewriting its implementation.
      const budget = await db.prepare("SELECT sql FROM sqlite_master WHERE name='knowledge_insert_budget'").first();
      await exec('DROP TRIGGER knowledge_insert_budget;\n' + budget.sql);
      await refuses('reordered-budget-no-retained-charge', badItem);
    },
    'source-cleanup': async () => {
      for (const target of ['call', 'turn']) {
        await reset(); await exec("INSERT INTO calls(id,business_id,status) VALUES('call','b1','completed'); INSERT INTO call_turns(id,call_id,role,text) VALUES(1,'call','caller','Question'); UPDATE knowledge_items SET source_call_id='call',source_turn_id=1 WHERE id='i1'; UPDATE rate_counters SET count=500 WHERE bucket='knowledge:b1';");
        await exec(target === 'call' ? "DELETE FROM calls WHERE id='call'" : 'DELETE FROM call_turns WHERE id=1');
        assert.deepEqual(await db.prepare("SELECT source_call_id,source_turn_id FROM knowledge_items WHERE id='i1'").first(), { source_call_id: target === 'call' ? null : 'call', source_turn_id: null });
        assert.equal((await db.prepare("SELECT count FROM rate_counters WHERE bucket='knowledge:b1'").first()).count, 500);
      }
    },
    'production-legacy-foundation': async () => {
      await reset(); assert.equal((await request('/api/me/business/b1', { faqs_json: '[{"q":"Hours?","a":"Weekdays"}]' }, 'PUT')).status, 200);
      await exec("DELETE FROM knowledge_collections WHERE id='kc_default_b1'"); assert.equal((await request('/api/me/bootstrap')).status, 200);
      assert.deepEqual((await db.prepare("SELECT business_id,collection_id,question FROM knowledge_items WHERE kind='faq'").all()).results, [{ business_id: 'b1', collection_id: 'kc_default_b1', question: 'Hours?' }]);
      const before = await snapshot();
      await assert.rejects(syncLegacyKnowledge(env, { id: 'b1', services_json: '[]', faqs_json: '[{"q":"Injected","a":"Invalid destination"}]' }, 'c2', { services: false, faqs: true }, [db.prepare("UPDATE businesses SET name='Earlier source write' WHERE id='b1'")]), /OPENFON_KNOWLEDGE_TENANT_MISMATCH/);
      const after = await snapshot(); captures.push({ name: 'legacy-batch-rollback', before, after }); assert.deepEqual(after, before);
    },
  };
  const selected = process.env.OPENFON_TENANT_NATIVE_CASE ? [process.env.OPENFON_TENANT_NATIVE_CASE] : Object.keys(cases);
  if (original) assert.deepEqual(selected, ['item-refusal'], 'Original native scope is exactly one item refusal negative');
  const outcomes = [];
  for (const name of selected) {
    assert.ok(Object.hasOwn(cases, name), 'Unknown native case');
    try { await cases[name](); outcomes.push({ name, status: 'PASS' }); }
    catch (e) { outcomes.push({ name, status: 'FAIL', message: e.message }); process.exitCode = 1; }
    console.log(JSON.stringify(outcomes.at(-1)));
  }
  if (process.env.OPENFON_TENANT_EVIDENCE_DIR) {
    await mkdir(process.env.OPENFON_TENANT_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.OPENFON_TENANT_EVIDENCE_DIR, 'native-result.json'), JSON.stringify({ original, outcomes, captures }, null, 2));
  }
} catch (e) { console.error(JSON.stringify({ status: 'SETUP_OR_HARNESS_FAILURE', message: e.message })); process.exitCode = 1; }
finally {
  try { if (mf) await mf.dispose(); disposed = true; }
  catch (e) { console.error(JSON.stringify({ status: 'DISPOSAL_FAILURE', message: e.message })); process.exitCode = 1; }
  if (disposed) await rm(temp, { recursive: true, force: true });
  console.log(JSON.stringify({ disposal: disposed ? 'completed' : 'unconfirmed; owned temp retained' }));
}
