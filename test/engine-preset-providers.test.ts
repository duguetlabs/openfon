import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

let db: SqliteD1;
let env: Env;
async function request(path: string, body?: unknown, token = 's1', method = body === undefined ? 'GET' : 'PUT') {
  return worker.fetch(new Request(`https://openfon.test${path}`, {
    method, headers: { Cookie: `ofs=${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}
beforeEach(({ task }) => {
  db = new SqliteD1();
  // Historical credential seeds must precede the compatibility barrier.
  const historical = task.name.startsWith('legacy editing scrubs') || task.name.startsWith('0016 removes');
  if (historical) applyMigrations(db, 1, 15); else applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES ('u1','one@example.test','hash'),('u2','two@example.test','hash');
    INSERT INTO sessions(token,user_id,expires_at) VALUES ('s1','u1','2099-01-01'),('s2','u2','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES ('b1','u1','one','One','Workshop'),('b2','u2','two','Two','Workshop');
    INSERT INTO agent_settings(business_id) VALUES ('b1'),('b2');
    INSERT INTO provider_settings(business_id) VALUES ('b1'),('b2');
    INSERT INTO assistants(id,business_id,public_slug) VALUES ('asst_b1','b1','one'),('asst_b2','b2','two');`);
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://api.kataleptic.com/v1', DEFAULT_LLM_API_KEY: 'instance-key',
    DEFAULT_LLM_MODEL: 'llama-3.3-70b', DEFAULT_STT_BASE_URL: 'https://api.kataleptic.com/v1', DEFAULT_STT_API_KEY: 'instance-stt',
    DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_MODEL: 'kataleptic-realtime', REALTIME_BASE_URL: 'wss://api.kataleptic.com/v1/realtime' } as unknown as Env;
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });


async function createPreset(fields: Record<string, unknown> = {}, legacy = false) {
  const res = await request(legacy ? '/api/me/business/b1/profiles' : '/api/me/engine-presets',
    { name: 'Saved behavior', engine: 'realtime', realtime_model: 'kataleptic-realtime-hd', realtime_voice: 'azure-voice', ...fields }, 's1', 'POST');
  expect(res.status).toBe(201);
  return await res.json() as { id: string };
}
async function applyPreset(id: string, legacy = false) {
  return request(legacy ? `/api/me/profiles/${id}/apply` : `/api/me/engine-presets/${id}/apply`, { assistantId: 'asst_b1' }, 's1', 'POST');
}

it.each([false, true])('new presets never snapshot workspace or submitted credentials (legacy=%s)', async legacy => {
  expect((await request('/api/me/provider', { apiKey: 'current-key' })).status).toBe(200);
  const preset = await createPreset({ llm_base_url: 'https://ignored.example/v1', llm_api_key: 'submitted-key' }, legacy);
  const before = db.database.prepare('SELECT * FROM engine_profiles WHERE id=?').get(preset.id) as Record<string, unknown>;
  expect(before).toMatchObject({ llm_base_url: '', llm_api_key: '', realtime_model: 'kataleptic-realtime-hd', realtime_voice: 'azure-voice' });
  expect((await request('/api/me/provider', { apiKey: 'rotated-key' })).status).toBe(200);
  expect((await request('/api/me/provider', { clearApiKey: true })).status).toBe(200);
  expect(db.database.prepare('SELECT * FROM engine_profiles WHERE id=?').get(preset.id)).toEqual(before);
});

it('legacy editing scrubs obsolete snapshots without changing behavioral fields', async () => {
  const preset = await createPreset();
  db.database.prepare('UPDATE engine_profiles SET llm_base_url=?,llm_api_key=? WHERE id=?').run('https://historical.example/v1', 'old-key', preset.id);
  expect((await request(`/api/me/profiles/${preset.id}`, { name: 'Renamed', llm_api_key: 'ignored-new-key' })).status).toBe(200);
  expect(db.database.prepare('SELECT name,realtime_model,realtime_voice,llm_base_url,llm_api_key FROM engine_profiles WHERE id=?').get(preset.id))
    .toEqual({ name: 'Renamed', realtime_model: 'kataleptic-realtime-hd', realtime_voice: 'azure-voice', llm_base_url: '', llm_api_key: '' });
});

it('0016 removes historical snapshots only, preserving profiles and current credentials', async () => {
  const preset = await createPreset();
  await request('/api/me/provider', { apiKey: 'current-key' });
  db.database.prepare('UPDATE engine_profiles SET llm_base_url=?,llm_api_key=? WHERE id=?').run('https://historical.example/v1', 'old-key', preset.id);
  const before = db.database.prepare('SELECT * FROM engine_profiles WHERE id=?').get(preset.id) as Record<string, unknown>;
  const providerBefore = db.database.prepare('SELECT * FROM provider_settings').all();
  const settingsBefore = db.database.prepare('SELECT * FROM agent_settings').all();
  const presetsBefore = db.database.prepare('SELECT * FROM engine_presets').all();
  db.exec(readFileSync(new URL('../migrations/0016_engine_profile_credentials.sql', import.meta.url), 'utf8'));
  expect(db.database.prepare('SELECT * FROM engine_profiles WHERE id=?').get(preset.id)).toEqual({ ...before, llm_base_url: '', llm_api_key: '' });
  expect(db.database.prepare('SELECT * FROM provider_settings').all()).toEqual(providerBefore);
  expect(db.database.prepare('SELECT * FROM agent_settings').all()).toEqual(settingsBefore);
  expect(db.database.prepare('SELECT * FROM engine_presets').all()).toEqual(presetsBefore);
});

it.each([false, true])('refuses gateway preset after OpenAI switch with no partial writes (legacy=%s)', async legacy => {
  const preset = await createPreset({}, legacy);
  await request('/api/me/provider', { realtime_provider: 'openai', realtime_api_key: 'current-realtime-key' });
  const before = ['assistants', 'agent_settings', 'provider_settings'].map(table => db.database.prepare(`SELECT * FROM ${table}`).all());
  const result = await applyPreset(preset.id, legacy);
  expect(result.status).toBe(400);
  expect(await result.text()).toContain('OpenAI');
  ['assistants', 'agent_settings', 'provider_settings'].forEach((table, i) => expect(db.database.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[i]));
});

it.each([false, true])('validates direct voices independently and accepts corrected preset (legacy=%s)', async legacy => {
  const preset = await createPreset({ realtime_model: 'gpt-realtime', realtime_voice: 'azure-voice' }, legacy);
  await request('/api/me/provider', { realtime_provider: 'openai', realtime_api_key: 'current-realtime-key' });
  expect((await applyPreset(preset.id, legacy)).status).toBe(400);
  expect((await request(`/api/me/engine-presets/${preset.id}`, { realtime_voice: 'marin' })).status).toBe(200);
  expect((await applyPreset(preset.id, legacy)).status).toBe(200);
  expect(db.database.prepare('SELECT realtime_model,realtime_voice FROM assistants WHERE id=?').get('asst_b1'))
    .toEqual({ realtime_model: 'gpt-realtime', realtime_voice: 'marin' });
});

it('checks instance OpenAI settings and permits blank defaults and pipeline presets', async () => {
  env.REALTIME_PROVIDER = 'openai'; env.REALTIME_BASE_URL = 'wss://api.openai.com/v1/realtime'; env.REALTIME_MODEL = 'gpt-realtime'; env.REALTIME_API_KEY = 'instance-realtime-key';
  const gateway = await createPreset({ realtime_model: 'gpt-realtime-2', realtime_voice: '' });
  expect((await applyPreset(gateway.id)).status).toBe(400);
  const defaults = await createPreset({ realtime_model: '', realtime_voice: '' });
  expect((await applyPreset(defaults.id)).status).toBe(200);
  const pipeline = await createPreset({ engine: 'pipeline' });
  expect((await applyPreset(pipeline.id)).status).toBe(200);
});

it('keeps custom realtime models and voices usable with a custom provider', async () => {
  const preset = await createPreset({ realtime_model: 'custom-model', realtime_voice: 'custom-voice' });
  await request('/api/me/provider', { realtime_provider: 'custom', realtime_base_url: 'wss://custom.example/realtime', realtime_api_key: 'custom-key' });
  expect((await applyPreset(preset.id)).status).toBe(200);
});
