import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

let db: SqliteD1;
let env: Env;
async function save(body: Record<string, unknown>, token = 's1', id = 'preset') {
  return worker.fetch(new Request(`https://openfon.test/api/me/profiles/${id}`, {
    method: 'PUT', headers: { Cookie: `ofs=${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}
beforeEach(() => {
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES ('u1','one@example.test','hash'),('u2','two@example.test','hash');
    INSERT INTO sessions(token,user_id,expires_at) VALUES ('s1','u1','2099-01-01'),('s2','u2','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES ('b1','u1','one','One','Workshop');
    INSERT INTO agent_settings(business_id) VALUES ('b1');
    INSERT INTO provider_settings(business_id) VALUES ('b1');
    INSERT INTO assistants(id,business_id,public_slug) VALUES ('asst_b1','b1','one');
    INSERT INTO engine_profiles(id,business_id,name,engine,language) VALUES ('preset','b1','Original','realtime','en');
    INSERT INTO engine_presets(id,business_id,name,engine,language) VALUES ('preset','b1','Original','realtime','en');`);
  env = { DB: db } as unknown as Env;
});
afterEach(() => db.close());

function snapshot() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
function profiles() {
  return ['engine_profiles', 'engine_presets'].map(table => db.database.prepare(`SELECT * FROM ${table} WHERE id='preset'`).get() as Record<string, unknown>);
}
const count = () => (db.database.prepare("SELECT count FROM rate_counters WHERE bucket='presets:b1'").get() as { count: number }).count;

it.each(['invalid', '', 'Pipeline', ' realtime '])('rejects unsupported engine %j without any persisted changes', async engine => {
  const before = snapshot();
  const response = await save({ engine, name: 'Must not persist', language: 'de', llm_api_key: 'ignored-fixture-key' });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Profile engine must be pipeline or realtime' });
  expect(snapshot()).toEqual(before);
});

it.each(['pipeline', 'realtime'])('accepts exact engine %s with mirrored fields and existing two-row quota charge', async engine => {
  const before = snapshot(), beforeCount = count();
  expect((await save({ engine, name: '  Grüß dich 👋  ', language: 'de', voice: 'voice-custom',
    llm_base_url: 'https://ignored.example/v1', llm_api_key: 'ignored-fixture-key' })).status).toBe(200);
  for (const row of profiles()) expect(row).toMatchObject({ engine, name: 'Grüß dich 👋', language: 'de', voice: 'voice-custom' });
  expect(profiles()[0]).toMatchObject({ llm_base_url: '', llm_api_key: '' });
  expect(count()).toBe(beforeCount + 2);
  const stable = (state: ReturnType<typeof snapshot>) => state.filter(t => !['engine_profiles', 'engine_presets', 'rate_counters'].includes(t.name));
  expect(stable(snapshot())).toEqual(stable(before));
});

it.each(['pipeline', 'realtime', 'historical-unknown'])('preserves omitted current engine %s without normalizing it', async engine => {
  // Existing rows are not rewritten by this supplied-field validation change.
  db.database.prepare("UPDATE engine_profiles SET engine=? WHERE id='preset'").run(engine);
  db.database.prepare("UPDATE engine_presets SET engine=? WHERE id='preset'").run(engine);
  const beforeCount = count();
  expect((await save({ name: 'Renamed' })).status).toBe(200);
  for (const row of profiles()) expect(row).toMatchObject({ name: 'Renamed', engine });
  expect(count()).toBe(beforeCount + 2);
});

it('retains malformed-type and language validation errors without writes', async () => {
  const before = snapshot();
  const malformed = await save({ engine: null });
  expect(malformed.status).toBe(400); expect(await malformed.json()).toEqual({ error: 'engine must be text.' });
  const language = await save({ engine: 'invalid', language: ' ' });
  expect(language.status).toBe(400); expect(await language.json()).toEqual({ error: 'Profile language is required' });
  expect(snapshot()).toEqual(before);
});

it('retains authentication and ownership precedence for invalid engine input', async () => {
  const before = snapshot();
  expect((await save({ engine: 'invalid' }, '')).status).toBe(401);
  expect((await save({ engine: 'invalid' }, 's2')).status).toBe(404);
  expect((await save({ engine: 'invalid' }, 's1', 'missing')).status).toBe(404);
  expect(snapshot()).toEqual(before);
});

it('keeps valid-update quota refusal and late mirror rollback atomic', async () => {
  db.exec("UPDATE rate_counters SET count=400 WHERE bucket='presets:b1'");
  const full = snapshot();
  expect((await save({ engine: 'pipeline' })).status).toBe(429); expect(snapshot()).toEqual(full);
  db.exec("UPDATE rate_counters SET count=10 WHERE bucket='presets:b1'");
  const before = snapshot();
  db.hook = sql => { if (sql.includes('UPDATE engine_presets SET name=')) throw new Error('synthetic late preset mirror failure'); };
  try { expect((await save({ engine: 'pipeline', name: 'Rolled back' })).status).toBe(500); }
  finally { db.hook = null; }
  expect(snapshot()).toEqual(before);
});
