import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { transcribe } from '../src/providers';
import { providerUpdate, OPENAI_REALTIME_VOICES } from '../src/provider-settings';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

let db: SqliteD1;
let env: Env;
async function request(path: string, body?: unknown, token = 's1') {
  return worker.fetch(new Request(`https://openfon.test${path}`, {
    method: body === undefined ? 'GET' : 'PUT', headers: { Cookie: `ofs=${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}
beforeEach(() => {
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES ('u1','one@example.test','hash'),('u2','two@example.test','hash');
    INSERT INTO sessions(token,user_id,expires_at) VALUES ('s1','u1','2099-01-01'),('s2','u2','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES ('b1','u1','one','One','Workshop'),('b2','u2','two','Two','Workshop');
    INSERT INTO agent_settings(business_id) VALUES ('b1'),('b2');
    INSERT INTO provider_settings(business_id) VALUES ('b1'),('b2');`);
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://api.kataleptic.com/v1', DEFAULT_LLM_API_KEY: 'instance-key',
    DEFAULT_LLM_MODEL: 'llama-3.3-70b', DEFAULT_STT_BASE_URL: 'https://api.kataleptic.com/v1', DEFAULT_STT_API_KEY: 'instance-stt',
    DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://api.kataleptic.com/v1/realtime' } as unknown as Env;
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });

it('upgrades 0009 preserving credentials, custom models, and default routing', () => {
  const upgrade = new SqliteD1();
  try {
    applyMigrations(upgrade, 1, 9);
    upgrade.exec(`INSERT INTO users(id,email,password_hash) VALUES ('u','old@example.test','h');
      INSERT INTO businesses(id,user_id,slug,name) VALUES ('b','u','old','Old');
      INSERT INTO provider_settings(business_id,llm_base_url,llm_api_key) VALUES ('b','https://custom.example/v1','old-key');`);
    applyMigrations(upgrade, 10, 10);
    expect(upgrade.database.prepare('SELECT llm_base_url,llm_api_key,llm_model,realtime_provider,stt_provider FROM provider_settings').get())
      .toEqual({ llm_base_url: 'https://custom.example/v1', llm_api_key: 'old-key', llm_model: '', realtime_provider: 'instance', stt_provider: 'instance' });
    expect(upgrade.database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  } finally { upgrade.close(); }
});
it('persists separate capabilities and never returns credentials or crosses workspaces', async () => {
  const fields = { baseUrl: 'https://openrouter.ai/api/v1', model: 'custom/model:route', apiKey: 'text-private',
    stt_provider: 'openai', stt_base_url: 'https://api.openai.com/v1', stt_api_key: 'stt-private', stt_model: 'whisper-1',
    realtime_provider: 'openai', realtime_base_url: 'wss://api.openai.com/v1/realtime', realtime_api_key: 'realtime-private' };
  const res = await request('/api/me/provider', fields);
  expect(res.status).toBe(200);
  expect(await res.text()).not.toContain('private');
  const view = await (await request('/api/me/provider')).json() as any;
  expect(view).toMatchObject({ model: 'custom/model:route', stt_provider: 'openai', realtime_provider: 'openai', stt_api_key_configured: true, realtime_api_key_configured: true });
  expect(JSON.stringify(view)).not.toContain('private');
  const other = await (await request('/api/me/provider', undefined, 's2')).json() as any;
  expect(other).toMatchObject({ usesInstanceDefault: true, workspaceApiKeyConfigured: false, realtime_api_key_configured: true });
  expect((await request('/api/me/provider', {}, '')).status).toBe(401);
  const exportResponse = await request('/api/me/account/export');
  expect(exportResponse.status).toBe(200);
  const exported = await exportResponse.text();
  expect(exported).not.toContain('private');
});
it('keeps a key on equivalent endpoint and rejects silently forwarding it to a changed URL', async () => {
  expect((await request('/api/me/provider', { baseUrl: 'https://first.example/v1', apiKey: 'private' })).status).toBe(200);
  expect((await request('/api/me/provider', { baseUrl: 'https://FIRST.example/v1/', apiKey: '' })).status).toBe(200);
  const rejected = await request('/api/me/provider', { baseUrl: 'https://second.example/v1' });
  expect(rejected.status).toBe(400); expect(await rejected.text()).toContain('Endpoint changed');
  expect((await request('/api/me/provider', { baseUrl: '', clearApiKey: true })).status).toBe(200);
  expect((await request('/api/me/provider', { baseUrl: 'https://second.example/v1', apiKey: 'new-private' })).status).toBe(200);
});
it.each([
  { realtime_provider: 'openai' },
  { realtime_provider: 'custom', realtime_base_url: 'wss://127.0.0.1/realtime', realtime_api_key: 'x' },
  { realtime_provider: 'openai', realtime_base_url: 'wss://evil.example/realtime', realtime_api_key: 'x' },
  { stt_provider: 'openai', stt_model: 'whisper-1' },
  { stt_provider: 'custom', stt_base_url: 'https://user:pass@host.example', stt_api_key: 'x', stt_model: 'x' },
  { stt_provider: 'openrouter' }, { realtime_provider: 'huggingface' }, { stt_api_key: 7 }, { realtime_clear_api_key: 'yes' },
])('rejects unsafe or incomplete capability configuration: %j', async body => {
  expect((await request('/api/me/provider', body)).status).toBe(400);
  expect(db.database.prepare("SELECT stt_api_key,realtime_api_key FROM provider_settings WHERE business_id='b1'").get()).toEqual({ stt_api_key: '', realtime_api_key: '' });
});
it('binds retained realtime keys to protocol as well as endpoint', () => {
  const current = providerUpdate(env, null, { realtime_provider: 'custom', realtime_base_url: 'wss://rt.example/v1', realtime_api_key: 'private' });
  expect(() => providerUpdate(env, current, { realtime_provider: 'kataleptic' })).toThrow('Endpoint changed');
});
it('direct realtime catalog never contacts Kataleptic or inherits a cached catalog', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await request('/api/me/provider', { realtime_provider: 'openai', realtime_api_key: 'private' });
  const response = await request('/api/me/voices');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ native: expect.arrayContaining([{ id: 'marin', label: 'marin' }]) });
  expect(fetch).not.toHaveBeenCalled();
});
it('sends transcription only to its workspace provider with redirects disabled', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'hello' }))); vi.stubGlobal('fetch', fetch);
  await transcribe(env, new ArrayBuffer(2), 'audio/wav', undefined, { stt_provider: 'openai', stt_base_url: 'https://api.openai.com/v1', stt_api_key: 'workspace-stt', stt_model: 'whisper-1' });
  expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/audio/transcriptions', expect.objectContaining({ redirect: 'manual', headers: { Authorization: 'Bearer workspace-stt' } }));
  expect(fetch.mock.calls[0][1].body.get('model')).toBe('whisper-1');
});
it('clears incompatible gateway models and voices for OpenAI while preserving custom model IDs', async () => {
  db.exec(`INSERT INTO assistants(id,business_id,public_slug,realtime_model,realtime_voice) VALUES
    ('a1','b1','gateway','kataleptic-realtime-hd','azure-voice'),
    ('a2','b1','custom','my-custom-model','my-custom-voice');`);
  expect((await request('/api/me/provider', { realtime_provider: 'openai', realtime_api_key: 'private' })).status).toBe(200);
  expect(db.database.prepare('SELECT realtime_model,realtime_voice FROM assistants WHERE id=?').get('a1'))
    .toEqual({ realtime_model: '', realtime_voice: '' });
  expect(db.database.prepare('SELECT realtime_model,realtime_voice FROM assistants WHERE id=?').get('a2'))
    .toEqual({ realtime_model: 'my-custom-model', realtime_voice: '' });
});

it.each([
  ['', 'en_US-lessac-medium', '', ''],
  ['my-custom-model', 'en-US-AvaMultilingualNeural', 'my-custom-model', ''],
  ['kataleptic-realtime-hd', 'marin', '', 'marin'],
  ['gpt-realtime-2', 'cedar', '', 'cedar'],
  ['', '', '', ''],
  ...OPENAI_REALTIME_VOICES.map(voice => ['my-custom-model', voice, 'my-custom-model', voice]),
])('validates voice independently on OpenAI switch: model=%s voice=%s', async (model, voice, expectedModel, expectedVoice) => {
  db.database.prepare('INSERT INTO assistants(id,business_id,public_slug,realtime_model,realtime_voice) VALUES (?,?,?,?,?)')
    .run('a1', 'b1', 'voice-check', model, voice);
  db.database.prepare('UPDATE agent_settings SET realtime_model=?,realtime_voice=?').run(model, voice);
  expect((await request('/api/me/provider', { realtime_provider: 'openai', realtime_api_key: 'synthetic-key' })).status).toBe(200);
  for (const table of ['assistants', 'agent_settings']) {
    expect(db.database.prepare(`SELECT realtime_model,realtime_voice FROM ${table} WHERE business_id=?`).get('b1'))
      .toEqual({ realtime_model: expectedModel, realtime_voice: expectedVoice });
  }
  // Compatibility settings for another workspace must remain untouched.
  expect(db.database.prepare('SELECT realtime_model,realtime_voice FROM agent_settings WHERE business_id=?').get('b2'))
    .toEqual({ realtime_model: model, realtime_voice: voice });
});

it('rejects custom STT WebSocket URLs without changing saved configuration, while allowing realtime WSS', async () => {
  const original = { stt_provider: 'custom', stt_base_url: 'https://speech.example/v1', stt_api_key: 'original-key', stt_model: 'whisper-custom' };
  expect((await request('/api/me/provider', original)).status).toBe(200);
  for (const protocol of ['wss', 'ws']) {
    const rejected = await request('/api/me/provider', { ...original, stt_base_url: `${protocol}://speech.example/v1`, stt_api_key: 'replacement-key' });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: 'stt URL must be an http(s) URL' });
    expect(db.database.prepare('SELECT stt_base_url,stt_api_key,stt_model FROM provider_settings WHERE business_id=?').get('b1'))
      .toEqual({ stt_base_url: original.stt_base_url, stt_api_key: original.stt_api_key, stt_model: original.stt_model });
  }
  expect((await request('/api/me/provider', { realtime_provider: 'custom', realtime_base_url: 'wss://speech.example/realtime', realtime_api_key: 'realtime-key' })).status).toBe(200);
  expect(db.database.prepare('SELECT realtime_base_url FROM provider_settings WHERE business_id=?').get('b1'))
    .toEqual({ realtime_base_url: 'wss://speech.example/realtime' });
});

it.each(['custom', 'kataleptic'])('rejects realtime query/fragment URLs atomically for %s', async provider => {
  const original = { realtime_provider: provider, realtime_base_url: 'wss://voice.example/realtime', realtime_api_key: 'original-realtime-key', model: 'original-text-model' };
  expect((await request('/api/me/provider', original)).status).toBe(200);
  for (const suffix of ['?route=other', '#fragment', '?route=other#fragment']) {
    const rejected = await request('/api/me/provider', { ...original,
      realtime_base_url: original.realtime_base_url + suffix,
      realtime_api_key: 'replacement-realtime-key', model: 'must-not-persist' });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: 'Realtime URL must not include query parameters or fragments.' });
    expect(db.database.prepare('SELECT realtime_provider,realtime_base_url,realtime_api_key,llm_model FROM provider_settings WHERE business_id=?').get('b1'))
      .toEqual({ realtime_provider: provider, realtime_base_url: original.realtime_base_url,
        realtime_api_key: original.realtime_api_key, llm_model: original.model });
  }
  // An ordinary path-only endpoint remains configurable with an explicit key.
  expect((await request('/api/me/provider', { realtime_base_url: 'wss://other.example/v1/realtime', realtime_api_key: 'replacement-realtime-key' })).status).toBe(200);
  expect(db.database.prepare('SELECT realtime_base_url FROM provider_settings WHERE business_id=?').get('b1'))
    .toEqual({ realtime_base_url: 'wss://other.example/v1/realtime' });
});

it.each([
  ['https://api.openai.com/v1', 'openai'], ['https://api.kataleptic.com/v1', 'kataleptic'],
  ['https://operator.example/v1', 'custom'],
])('classifies instance text suggestions without assuming Kataleptic: %s', async (url, preset) => {
  env.DEFAULT_LLM_BASE_URL = url; env.DEFAULT_LLM_MODEL = 'operator-model';
  const result = await request('/api/me/provider');
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ instance_text_preset: preset, instance_text_model: 'operator-model' });
});
