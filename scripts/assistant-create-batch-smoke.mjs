// Exact-source assistant INSERT/attachment batch against native local workerd/D1.
// Foundation and HTTP interleavings are covered separately by API regressions.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { unstable_splitSqlQuery } from 'wrangler';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const root = resolve(import.meta.dirname, '..');
const source = await readFile(join(root, 'src/studio-api.ts'), 'utf8');
const providerSource = await readFile(join(root, 'src/provider-settings.ts'), 'utf8');
console.log('Studio source SHA256', createHash('sha256').update(source).digest('hex'));
const predicate = providerSource.match(/const CHECKED_REALTIME_PROVIDER_SQL = `([\s\S]*?)`;/)[1]
  .replaceAll('assistants.business_id', 'create_workspace.id');
const start = source.indexOf("app.post('/api/me/assistants',");
const route = source.slice(start, source.indexOf("app.get('/api/me/assistants/:assistantId',", start));
const insertSql = route.match(/`(INSERT INTO assistants[\s\S]*?)`/)[1].replace('${createProviderSql}', predicate);
const attachSql = route.match(/`(INSERT OR IGNORE INTO assistant_knowledge_collections[\s\S]*?)`/)[1];
assert.ok(insertSql.includes('FROM businesses AS create_workspace'));
assert.ok(attachSql.includes('changes()>0'));
const temp = await mkdtemp(join(tmpdir(), 'openfon-create-batch-'));
let mf;
try {
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false,
    port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252),
    workers: [{ name: 'create-batch', modules: true, script: 'export default {fetch(){return new Response("local D1 batch")}}',
      compatibilityDate: '2026-05-01', d1Databases: { DB: 'create-batch' },
      outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready;
  const db = await mf.getD1Database('DB', 'create-batch');
  const exec = sql => db.batch(unstable_splitSqlQuery(sql).map(s => db.prepare(s)));
  const migrations = (await readdir(join(root, 'migrations'))).filter(x => /^\d{4}_.*\.sql$/.test(x)).sort();
  assert.ok(migrations.some(x => x.startsWith('0020_')));
  for (const file of migrations) await exec(await readFile(join(root, 'migrations', file), 'utf8'));
  await exec(`INSERT INTO users(id,email,password_hash) VALUES('u1','synthetic@example.invalid','unused');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('b1','u1','one','One');
    INSERT INTO agent_settings(business_id) VALUES('b1');
    INSERT INTO provider_settings(business_id,realtime_provider,realtime_base_url,realtime_api_key) VALUES('b1','custom','wss://custom.example/realtime','synthetic-key');
    INSERT INTO assistants(id,business_id,public_slug,state) VALUES('asst_b1','b1','one','draft');
    INSERT INTO knowledge_collections(id,business_id,name,is_default) VALUES('kc_b1','b1','Default',1);`);
  const snapshot = async () => {
    const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all();
    return Promise.all(tables.map(async ({ name }) => ({ name, rows: (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results })));
  };
  const checked = [1, 'custom', 'wss://custom.example/realtime', 'synthetic-key'];
  const batch = (id, pin = checked) => [db.prepare(insertSql).bind(id, 'b1', id, 'Requested draft', '', 'Helpful', 'de', '', 0, '', 'realtime', 'custom-model', 'custom-voice', '', 'b1', ...pin), db.prepare(attachSql).bind(id, 'b1')];
  const count = async () => (await db.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:b1'").first()).count;
  for (const [name, mutation] of [
    ['selection', "UPDATE provider_settings SET realtime_provider='openai' WHERE business_id='b1'"],
    ['URL', "UPDATE provider_settings SET realtime_base_url='wss://changed.example/realtime' WHERE business_id='b1'"],
    ['key', "UPDATE provider_settings SET realtime_api_key='synthetic-rotated' WHERE business_id='b1'"],
    ['deleted', "DELETE FROM provider_settings WHERE business_id='b1'"],
  ]) {
    await exec(mutation);
    const before = await snapshot(); const results = await db.batch(batch('refused'));
    assert.equal(results[0].meta.changes, 0); assert.equal(results[1].meta.changes, 0);
    assert.deepEqual(await snapshot(), before);
    await exec("INSERT INTO provider_settings(business_id,realtime_provider,realtime_base_url,realtime_api_key) VALUES('b1','custom','wss://custom.example/realtime','synthetic-key') ON CONFLICT(business_id) DO UPDATE SET realtime_provider=excluded.realtime_provider,realtime_base_url=excluded.realtime_base_url,realtime_api_key=excluded.realtime_api_key");
    console.log('PASS conflict all statements0/full snapshot:', name);
  }
  let before = await snapshot();
  const missingConflict = await db.batch(batch('missing-refused', [0, null, null, null]));
  assert.ok(missingConflict.every(r => r.meta.changes === 0)); assert.deepEqual(await snapshot(), before);
  console.log('PASS captured absence versus created provider conflict');
  const beforeCount = await count();
  const accepted = await db.batch(batch('accepted'));
  assert.ok(accepted[0].meta.changes > 0); assert.equal(accepted[1].meta.changes, 1);
  assert.equal(await count(), beforeCount + 1);
  assert.deepEqual(await db.prepare("SELECT state,realtime_model,realtime_voice,take_messages FROM assistants WHERE id='accepted'").first(), { state: 'draft', realtime_model: 'custom-model', realtime_voice: 'custom-voice', take_messages: 0 });
  console.log('PASS accepted private draft/default attachment/one insert charge');
  await exec("UPDATE knowledge_collections SET is_default=0 WHERE id='kc_b1'");
  const noDefault = await db.batch(batch('no-default'));
  assert.ok(noDefault[0].meta.changes > 0); assert.equal(noDefault[1].meta.changes, 0);
  console.log('PASS zero default attachments does not mean refused create');
  await exec("UPDATE knowledge_collections SET is_default=1 WHERE id='kc_b1'; UPDATE rate_counters SET count=200 WHERE bucket='assistants:b1'");
  before = await snapshot(); await assert.rejects(db.batch(batch('quota-refused'))); assert.deepEqual(await snapshot(), before);
  await exec("UPDATE rate_counters SET count=10 WHERE bucket='assistants:b1'; CREATE TRIGGER synthetic_attachment_failure BEFORE INSERT ON assistant_knowledge_collections BEGIN SELECT RAISE(ABORT,'SYNTHETIC_ATTACHMENT_FAILURE'); END");
  before = await snapshot(); await assert.rejects(db.batch(batch('attachment-refused'))); assert.deepEqual(await snapshot(), before);
  console.log('PASS quota and actual attachment-statement failure roll back requested draft/counter');
} finally { if (mf) await mf.dispose(); await rm(temp, { recursive: true, force: true }); }
