// Execute source-extracted write batches against actual local workerd/D1.
// This checks D1 transaction/changes() semantics, not live provider acceptance.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = resolve(import.meta.dirname, '..');
const source = await readFile(join(root, 'src/studio-api.ts'), 'utf8');
const providerSource = await readFile(join(root, 'src/provider-settings.ts'), 'utf8');
const indexSource = await readFile(join(root, 'src/index.ts'), 'utf8');
const constant = name => {
  const match = (name === 'CHECKED_REALTIME_PROVIDER_SQL' ? providerSource : source).match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  assert.ok(match, `Missing source constant ${name}`); return match[1];
};
const providerSql = constant('CHECKED_REALTIME_PROVIDER_SQL');
const snapshotSql = source.match(/`(UPDATE compatibility_sync_state SET agent_snapshot=[\s\S]*?)`/)[1]
  .replace('${AGENT_SNAPSHOT_SQL}', constant('AGENT_SNAPSHOT_SQL'))
  .replace("${afterMutation ? ' AND changes()>0' : ''}", ' AND changes()>0');
function routeSql(start, end, text = source) {
  const route = text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
  const statements = [...route.matchAll(/`(UPDATE (?:assistants|agent_settings) SET[\s\S]*?)`/g)].map(x => x[1].replace('${CHECKED_REALTIME_PROVIDER_SQL}', providerSql));
  assert.equal(statements.length, 2); assert.ok(statements.find(sql => sql.startsWith('UPDATE agent_settings')).includes('changes()>0'));
  return statements;
}
const routes = {
  update: routeSql("app.put('/api/me/assistants/:assistantId'", "app.delete('/api/me/assistants/:assistantId'"),
  apply: routeSql("app.post('/api/me/engine-presets/:presetId/apply'", "app.put('/api/me/engine-presets/:presetId'"),
  legacy: routeSql("app.put('/api/me/business/:id/agent'", "app.get('/api/me/business/:id/calls'", indexSource),
  legacyApply: routeSql("app.post('/api/me/profiles/:pid/apply'", '// ---------- voice catalogs', indexSource).reverse(),
};
const legacyProviderSql = indexSource.slice(indexSource.indexOf("app.put('/api/me/business/:id/agent'"))
  .match(/`(INSERT INTO provider_settings[\s\S]*?)`/)[1];
const legacySnapshotSql = indexSource.match(/`(UPDATE compatibility_sync_state SET agent_snapshot=[\s\S]*?)`/)[1]
  .replace("${afterMutation ? ' AND changes()>0' : ''}", ' AND changes()>0');
const temp = await mkdtemp(join(tmpdir(), 'openfon-provider-batch-'));
let mf;
try {
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false,
    port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252),
    workers: [{ name: 'provider-batch', modules: true, script: 'export default {fetch(){return new Response("local D1 batch test")}}',
      compatibilityDate: '2026-05-01', d1Databases: { DB: 'provider-batch' },
      outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready;
  const db = await mf.getD1Database('DB', 'provider-batch');
  const exec = async sql => db.batch(unstable_splitSqlQuery(sql).map(s => db.prepare(s)));
  const files = (await readdir(join(root, 'migrations'))).filter(x => /^\d{4}_.*\.sql$/.test(x)).sort();
  assert.ok(files.some(x => x.startsWith('0020_')), 'Exact published schema must include0020');
  for (const file of files) await exec(await readFile(join(root, 'migrations', file), 'utf8'));
  await exec(`INSERT INTO users(id,email,password_hash) VALUES('u1','synthetic@example.invalid','unused');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('b1','u1','one','One');
    INSERT INTO agent_settings(business_id) VALUES('b1');
    INSERT INTO provider_settings(business_id,realtime_provider,realtime_base_url,realtime_api_key) VALUES('b1','custom','wss://custom.example/realtime','synthetic-key');
    INSERT INTO assistants(id,business_id,public_slug,state) VALUES('asst_b1','b1','one','active');
    INSERT INTO compatibility_sync_state(business_id,agent_snapshot) VALUES('b1','before');`);
  const snapshot = async () => {
    const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all();
    return Promise.all(tables.map(async ({ name }) => ({ name, rows: (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results })));
  };
  const checked = [1, 'custom', 'wss://custom.example/realtime', 'synthetic-key'];
  for (const [writer, sql] of Object.entries(routes)) {
    const firstValues = writer === 'update'
      ? ['Changed', '', 'Helpful', 'de', '', 1, '', 'realtime', 'custom-model', 'custom-voice', '', 'asst_b1', ...checked]
      : writer === 'legacy' ? ['Changed', '', 'Helpful', 'de', '', 1, '', 'realtime', 'custom-model', 'custom-voice', '', 'asst_b1', ...checked, '', '']
      : writer === 'legacyApply' ? ['realtime', 'custom-model', 'custom-voice', 'de', '', '', 'b1', 'b1', ...checked]
      : ['realtime', 'custom-model', 'custom-voice', 'de', '', '', 'asst_b1', ...checked];
    const mirrorValues = writer === 'update'
      ? ['Changed', '', 'Helpful', 'de', '', 1, '', '', 'realtime', 'custom-model', 'custom-voice', 'b1']
      : writer === 'legacy' ? ['Changed', '', 'Helpful', 'de', '', 1, '', '', 'synthetic-text', '', 'realtime', 'custom-model', 'custom-voice', 'b1']
      : ['realtime', 'custom-model', 'custom-voice', 'de', '', '', 'b1'];
    const statements = () => [db.prepare(sql[0]).bind(...firstValues),
      ...(writer === 'legacy' ? [db.prepare(legacyProviderSql).bind('b1', '', 'synthetic-text')] : []),
      db.prepare(sql[1]).bind(...mirrorValues), db.prepare(writer.startsWith('legacy') ? legacySnapshotSql : snapshotSql).bind('b1', 'b1')];
    await exec("UPDATE provider_settings SET realtime_provider='openai' WHERE business_id='b1'; UPDATE rate_counters SET count=10 WHERE bucket='assistants:b1';");
    let before = await snapshot();
    const rejected = await db.batch(statements());
    for (const result of rejected) assert.equal(result.meta.changes, 0);
    assert.deepEqual(await snapshot(), before, `${writer}: stale provider leaves every table unchanged`);
    await exec("UPDATE provider_settings SET realtime_provider='custom' WHERE business_id='b1';");
    const accepted = await db.batch(statements());
    for (const result of accepted) assert.ok(result.meta.changes > 0);
    const assistant = await db.prepare("SELECT realtime_model,realtime_voice,language FROM assistants WHERE id='asst_b1'").first();
    assert.deepEqual(await db.prepare("SELECT realtime_model,realtime_voice,language FROM agent_settings WHERE business_id='b1'").first(), assistant);
    const saved = JSON.parse((await db.prepare("SELECT agent_snapshot FROM compatibility_sync_state WHERE business_id='b1'").first()).agent_snapshot);
    for (const key of Object.keys(assistant)) assert.equal(saved[key], assistant[key]);
    assert.equal((await db.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:b1'").first()).count, 11);
    await exec("UPDATE provider_settings SET llm_api_key='' WHERE business_id='b1'; UPDATE agent_settings SET llm_api_key='' WHERE business_id='b1'; UPDATE rate_counters SET count=200 WHERE bucket='assistants:b1';");
    before = await snapshot();
    await assert.rejects(db.batch(statements()));
    assert.deepEqual(await snapshot(), before, `${writer}: quota rollback`);
    await exec("UPDATE rate_counters SET count=10 WHERE bucket='assistants:b1';");
    before = await snapshot();
    await assert.rejects(db.batch([...statements(), db.prepare("SELECT json('SYNTHETIC_LATE_FAILURE')")]));
    assert.deepEqual(await snapshot(), before, `${writer}: late failure rolls back all writes and counters`);
    console.log(`PASS ${writer}: conflict zero writes, mirrored success, quota and late rollback`);
  }
} finally { if (mf) await mf.dispose(); await rm(temp, { recursive: true, force: true }); }
