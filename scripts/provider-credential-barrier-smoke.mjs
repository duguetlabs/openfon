// Local D1 transaction evidence only. No deployed bindings or outbound calls.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'openfon-credential-barrier-'));
const names = ['fresh', 'repair', 'quota', 'late', 'mismatch16', 'missing16', 'mismatch18', 'large', 'multi'];
const files = (await readdir(join(root, 'migrations'))).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
const oldSql = JSON.parse(await readFile(join(root, 'test/fixtures/legacy-profile-sql.json'), 'utf8'));
const installSql = await readFile(join(root, 'scripts/install-profile-compatibility.sql'), 'utf8');
const repairSql = await readFile(join(root, 'scripts/recover-profile-snapshots.sql'), 'utf8');
const migration18 = await readFile(join(root, 'migrations/0018_engine_profile_compatibility.sql'), 'utf8');
assert.equal(installSql, migration18.split('-- Preserve profile IDs, behavioral fields, timestamps and current credentials.')[0], 'guards-only prefix drift');
assert.deepEqual(unstable_splitSqlQuery(installSql), unstable_splitSqlQuery(migration18).slice(0, -1), 'guard statement drift');
let mf;
async function run(db, sql, extra = []) {
  // One D1 batch containing every statement, including complete trigger bodies.
  return db.batch([...unstable_splitSqlQuery(sql), ...extra].map(statement => db.prepare(statement)));
}
async function migrate(db, number, extra = []) {
  const filename = files.find(name => name.startsWith(String(number).padStart(4, '0') + '_'));
  assert.ok(filename, `Missing migration ${number}`);
  return run(db, await readFile(join(root, 'migrations', filename), 'utf8'), extra);
}
async function snapshot(db) {
  const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all();
  return { schema: (await db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()).results,
    rows: await Promise.all(tables.map(async ({ name }) => ({ name, rows: (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results }))) };
}
async function credentials(db) {
  return Promise.all(['agent_settings', 'provider_settings'].map(table =>
    db.prepare(`SELECT llm_base_url,llm_api_key FROM ${table} WHERE business_id='b1'`).first()));
}
async function prepare(db) {
  for (let n = 1; n <= 15; n++) await migrate(db, n);
  await run(db, `INSERT INTO users(id,email,password_hash) VALUES('u1','synthetic@example.invalid','unused');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES('b1','u1','one','One','Workshop');
    INSERT INTO agent_settings(business_id,llm_base_url,llm_api_key) VALUES('b1','https://current.example/v1','synthetic-current');
    INSERT INTO provider_settings(business_id,llm_base_url,llm_api_key) VALUES('b1','https://current.example/v1','synthetic-current');
    INSERT INTO engine_profiles(id,business_id,name,llm_base_url,llm_api_key) VALUES('p1','b1','Historical','https://old.example/v1','synthetic-old');`);
}
const original16 = "UPDATE engine_profiles SET llm_api_key = '', llm_base_url = '';";
try {
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false,
    port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252),
    workers: [{ name: 'barrier', modules: true, script: 'export default {fetch(){return new Response("local transaction test")}}',
      compatibilityDate: '2026-05-01', d1Databases: Object.fromEntries(names.map(name => [name, `barrier-${name}`])),
      outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready;
  for (const name of names) {
    const db = await mf.getD1Database(name, 'barrier');
    await prepare(db);
    if (name === 'fresh') {
      const before = await snapshot(db);
      await assert.rejects(migrate(db, 16, ["SELECT json('INJECTED_LATER_FAILURE')"]));
      assert.deepEqual(await snapshot(db), before, '16 later failure rolls back guards and scrub');
      const keys = await credentials(db);
      await migrate(db, 16); await migrate(db, 17);
      const after17 = await snapshot(db);
      await migrate(db, 18); await migrate(db, 18);
      assert.deepEqual(await snapshot(db), after17, 'fresh18/idempotent18 do not charge blank profiles');
      assert.deepEqual(await credentials(db), keys);
      await assert.rejects(db.prepare(oldSql.apply).bind('pipeline', '', '', 'de', '', '', '', '', 'b1').run(), /OPENFON_PROVIDER_CREDENTIAL_WRITE/);
      assert.deepEqual(await credentials(db), keys);
    } else if (name.startsWith('mismatch') || name === 'missing16') {
      if (name === 'mismatch18') { await run(db, original16); await migrate(db, 17); }
      await db.prepare('DELETE FROM engine_profiles').run();
      if (name === 'missing16') await db.prepare('DELETE FROM provider_settings').run();
      else await db.prepare("UPDATE provider_settings SET llm_base_url='',llm_api_key=''").run();
      const before = await snapshot(db);
      await assert.rejects(migrate(db, name === 'mismatch18' ? 18 : 16));
      assert.deepEqual(await snapshot(db), before, 'no-profile consistency failure has no effects');
    } else {
      await run(db, original16);
      if (name === 'large') {
        await db.batch(Array.from({ length: 401 }, (_, i) => db.prepare(
          "INSERT INTO engine_profiles(id,business_id,name,llm_base_url,llm_api_key) VALUES(?,'b1','Historical','https://old.example/v1','synthetic-old')"
        ).bind(`historical-${i}`)));
      }
      if (name === 'multi') {
        await run(db, "INSERT INTO users(id,email,password_hash) VALUES('u2','two@example.invalid','unused'); INSERT INTO businesses(id,user_id,slug,name) VALUES('b2','u2','two','Two'); INSERT INTO agent_settings(business_id) VALUES('b2'); INSERT INTO provider_settings(business_id) VALUES('b2');");
        await db.batch(['b1','b2'].flatMap(business => Array.from({length:3}, (_,i) => db.prepare(
          "INSERT INTO engine_profiles(id,business_id,name,llm_base_url,llm_api_key) VALUES(?,?,'History','https://old.example/v1','synthetic-old')"
        ).bind(`${business}-${i}`,business))));
      }
      await migrate(db, 17);
      if (name === 'multi') {
        await run(db, "INSERT INTO rate_counters(bucket,window_start,count) VALUES('presets:b1',CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400,399),('presets:b2',CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400,398);");
        await run(db, installSql); await run(db, repairSql);
        assert.equal((await db.prepare("SELECT COUNT(*) n FROM engine_profiles WHERE llm_api_key<>''").first()).n,3);
        const after = await snapshot(db); await run(db, repairSql); assert.deepEqual(await snapshot(db),after,'used budgets stop further cleanup');
        console.log('PASS multi'); continue;
      }
      // An old in-flight writer reintroduced a snapshot after original16.
      if (name !== 'large') await db.prepare(oldSql.update).bind('Historical', 'pipeline', '', '', 'en', '', 'https://old.example/v1', 'synthetic-old', '', 'p1').run();
      if (name === 'quota') await db.prepare("UPDATE rate_counters SET count=400 WHERE bucket='presets:b1'").run();
      const before = await snapshot(db);
      if (name === 'quota' || name === 'late' || name === 'large') {
        await assert.rejects(migrate(db, 18, name === 'late' ? ["SELECT json('INJECTED_LATER_FAILURE')"] : []));
        assert.deepEqual(await snapshot(db), before, '18 failure rolls back scrub/guards/quota writes');
        if (name === 'large') {
          await assert.rejects(run(db, installSql, ["SELECT json('INJECTED_INSTALL_FAILURE')"]));
          assert.deepEqual(await snapshot(db), before, 'failed guards-only install rolls back DDL');
          await run(db, installSql);
          await assert.rejects(db.prepare(oldSql.update).bind('Late','pipeline','','','en','','https://old.example/v1','synthetic-old','','p1').run(), /OPENFON_PROFILE_CREDENTIAL/);
          await run(db, repairSql);
          assert.equal((await db.prepare("SELECT COUNT(*) n FROM engine_profiles WHERE llm_api_key<>''").first()).n,1);
          const dayOne = await snapshot(db); await run(db, repairSql);
          assert.deepEqual(await snapshot(db),dayOne,'same-day exhausted cleanup makes no progress');
          // Test-only clock-window simulation: retain the400 count in yesterday's bucket.
          await db.prepare("UPDATE rate_counters SET window_start=window_start-86400 WHERE bucket='presets:b1'").run();
          await run(db, repairSql);
          assert.equal((await db.prepare("SELECT COUNT(*) n FROM engine_profiles WHERE llm_api_key<>''").first()).n,0);
          assert.equal((await db.prepare("SELECT SUM(count) n FROM rate_counters WHERE bucket='presets:b1'").first()).n,401);
          const cleaned = await snapshot(db); await migrate(db,18);
          assert.deepEqual(await snapshot(db),cleaned,'18 finishes without extra quota after bounded recovery');
        }
      } else {
        const keys = await credentials(db);
        await migrate(db, 18);
        assert.deepEqual(await credentials(db), keys);
        assert.deepEqual(await db.prepare("SELECT llm_base_url,llm_api_key FROM engine_profiles WHERE id='p1'").first(), { llm_base_url: '', llm_api_key: '' });
        const repaired = await snapshot(db);
        await assert.rejects(db.prepare(oldSql.update).bind('Late', 'pipeline', '', '', 'en', '', 'https://old.example/v1', 'synthetic-old', '', 'p1').run(), /OPENFON_PROFILE_CREDENTIAL/);
        assert.deepEqual(await snapshot(db), repaired);
        await migrate(db, 18);
        assert.deepEqual(await snapshot(db), repaired);
      }
    }
    console.log(`PASS ${name}`);
  }
} finally {
  if (mf) await mf.dispose();
  await rm(temp, { recursive: true, force: true });
}
