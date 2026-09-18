import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

// Exact SQL extracted from old main eb13a193; fixture stays usable in shallow CI.
const oldSql = JSON.parse(readFileSync(new URL('./fixtures/legacy-profile-sql.json', import.meta.url), 'utf8'));
const applySql = oldSql.apply;
const insertSql = oldSql.insert;
const updateSql = oldSql.update;
let db: SqliteD1;
let env: Env;
function migration() {
  db.exec('BEGIN');
  try {
    db.exec(readFileSync(new URL('../migrations/0016_engine_profile_credentials.sql', import.meta.url), 'utf8'));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function state() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return { schema: db.database.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),
    rows: tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() })) };
}
function credentials() {
  return ['agent_settings', 'provider_settings'].map(table => db.database.prepare(`SELECT llm_base_url,llm_api_key FROM ${table} WHERE business_id='b1'`).get());
}
async function request(path: string, body?: unknown) {
  return worker.fetch(new Request(`https://openfon.test${path}`, { method: body === undefined ? 'GET' : 'PUT',
    headers: { Cookie: 'ofs=s1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}
beforeEach(() => {
  db = new SqliteD1(); applyMigrations(db, 1, 15);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('u1','barrier@example.test','hash');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('s1','u1','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES('b1','u1','one','One','Workshop');
    INSERT INTO agent_settings(business_id,llm_base_url,llm_api_key) VALUES('b1','https://current.example/v1','current-key');
    INSERT INTO provider_settings(business_id,llm_base_url,llm_api_key) VALUES('b1','https://current.example/v1','current-key');
    INSERT INTO engine_profiles(id,business_id,name,engine,realtime_model,realtime_voice,language,voice,llm_base_url,llm_api_key,llm_model)
      VALUES('p1','b1','Old','pipeline','','','de','','https://historical.example/v1','historical-key','historical-model');`);
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: 'instance-key',
    DEFAULT_LLM_MODEL: 'model', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_MODEL: 'whisper-1',
    DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime' } as unknown as Env;
});
afterEach(() => db.close());

it.each(['missing', 'stale-blank', 'different-key'])('fails before scrub or schema changes on %s provider, even without profiles', kind => {
  db.exec('DELETE FROM engine_profiles');
  if (kind === 'missing') db.exec('DELETE FROM provider_settings');
  else if (kind === 'stale-blank') db.exec("UPDATE provider_settings SET llm_base_url='',llm_api_key=''");
  else db.exec("UPDATE provider_settings SET llm_api_key='other-key'");
  const before = state();
  expect(migration).toThrow();
  expect(state()).toEqual(before);
});

it('scrubs only historical fields and prevents old Apply from clearing current credentials', () => {
  const profile = db.database.prepare("SELECT * FROM engine_profiles WHERE id='p1'").get();
  const before = credentials();
  migration();
  expect(db.database.prepare("SELECT * FROM engine_profiles WHERE id='p1'").get()).toEqual({ ...profile, llm_base_url: '', llm_api_key: '' });
  expect(credentials()).toEqual(before);
  expect(() => db.database.prepare(applySql).run('pipeline', '', '', 'de', '', '', '', 'historical-model', 'b1'))
    .toThrow('OPENFON_PROVIDER_CREDENTIAL_WRITE_REQUIRES_CURRENT_WORKER');
  expect(credentials()).toEqual(before);
  // The full old statement is atomic, including its behavioral columns.
  expect(db.database.prepare("SELECT language FROM agent_settings WHERE business_id='b1'").get()).toEqual({ language: 'en' });
});

it('rejects in-flight old profile insert/update snapshots after the barrier', () => {
  migration(); const before = state();
  expect(() => db.database.prepare(insertSql).run('p2', 'b1', 'Late', 'pipeline', '', '', 'en', '', 'https://old.example/v1', 'old-key', 'model'))
    .toThrow('OPENFON_PROFILE_CREDENTIAL_SNAPSHOTS_DISABLED');
  expect(() => db.database.prepare(updateSql).run('Late', 'pipeline', '', '', 'en', '', 'https://old.example/v1', 'old-key', 'model', 'p1'))
    .toThrow('OPENFON_PROFILE_CREDENTIAL_SNAPSHOTS_DISABLED');
  expect(state()).toEqual(before);
});

it('allows unchanged legacy credential writes and credential-free profile writes', () => {
  migration(); const before = credentials();
  db.database.prepare(applySql).run('pipeline', '', '', 'de', '', 'https://current.example/v1', 'current-key', '', 'b1');
  db.database.prepare(insertSql).run('p2', 'b1', 'Blank', 'pipeline', '', '', 'en', '', '', '', '');
  expect(credentials()).toEqual(before);
});

it.each(['provider', 'legacy'])('allows new %s rotation and explicit clear batches', async route => {
  migration(); applyMigrations(db, 17, 17);
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  const path = route === 'provider' ? '/api/me/provider' : '/api/me/business/b1/agent';
  const rotation = route === 'provider' ? { baseUrl: 'https://rotated.example/v1', apiKey: 'rotated-key' }
    : { llm_base_url: 'https://rotated.example/v1', llm_api_key: 'rotated-key' };
  expect((await request(path, rotation)).status).toBe(200);
  expect(credentials()).toEqual(Array(2).fill({ llm_base_url: 'https://rotated.example/v1', llm_api_key: 'rotated-key' }));
  const clear = route === 'provider' ? { baseUrl: '', clearApiKey: true } : { llm_base_url: '', clearApiKey: true };
  expect((await request(path, clear)).status).toBe(200);
  expect(credentials()).toEqual(Array(2).fill({ llm_base_url: '', llm_api_key: '' }));
});

it('rolls back provider rotation when a later statement aborts', async () => {
  migration(); applyMigrations(db, 17, 17);
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  db.exec("CREATE TRIGGER test_refusal BEFORE UPDATE ON agent_settings BEGIN SELECT RAISE(ABORT,'synthetic refusal'); END");
  const before = state();
  expect((await request('/api/me/provider', { baseUrl: 'https://rotated.example/v1', apiKey: 'rotated-key' })).status).toBe(500);
  expect(state()).toEqual(before);
});
