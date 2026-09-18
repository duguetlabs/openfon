import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
beforeEach(async () => {
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES ('u1','one@example.test','hash'),('u2','two@example.test','hash');
    INSERT INTO sessions(token,user_id,expires_at) VALUES ('s1','u1','2099-01-01'),('s2','u2','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES ('b1','u1','one','One','Workshop'),('b2','u2','two','Two','Workshop');
    INSERT INTO agent_settings(business_id) VALUES ('b1'),('b2');
    INSERT INTO provider_settings(business_id) VALUES ('b1'),('b2');
    INSERT INTO assistants(id,business_id,public_slug) VALUES ('asst_b1','b1','one'),('asst_b2','b2','two');`);
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://api.kataleptic.com/v1', DEFAULT_LLM_API_KEY: 'instance-key',
    DEFAULT_LLM_MODEL: 'llama-3.3-70b', DEFAULT_STT_BASE_URL: 'https://api.kataleptic.com/v1', DEFAULT_STT_API_KEY: 'instance-stt',
    DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_MODEL: 'kataleptic-realtime', REALTIME_BASE_URL: 'wss://api.kataleptic.com/v1/realtime' } as unknown as Env;
  await request('/api/me');
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });


type Writer = 'legacy' | 'studio-update' | 'studio-create';
const writers: Writer[] = ['legacy', 'studio-update', 'studio-create'];
function save(writer: Writer, fields: Record<string, unknown>) {
  if (writer === 'legacy') return request('/api/me/business/b1/agent', fields);
  if (writer === 'studio-update') return request('/api/me/assistants/asst_b1', fields);
  return request('/api/me/assistants', { name: 'New draft', ...fields }, 's1', 'POST');
}
function snapshot() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}"`).all() }));
}
function selectProvider(provider: string) {
  // Existing/incomplete draft setup: no live realtime key or endpoint is needed.
  db.database.prepare("UPDATE provider_settings SET realtime_provider=?,realtime_api_key='',realtime_base_url='' WHERE business_id='b1'").run(provider);
  env.REALTIME_API_KEY = ''; env.DEFAULT_LLM_API_KEY = '';
}

it.each(writers)('%s refuses gateway models and invalid direct voices before any writes', async writer => {
  selectProvider('openai');
  for (const fields of [
    { realtime_model: 'kataleptic-realtime', realtime_voice: '' },
    { realtime_model: 'kataleptic-realtime-hd', realtime_voice: '' },
    { realtime_model: 'gpt-realtime-2', realtime_voice: '' },
    { realtime_model: 'gpt-realtime', realtime_voice: 'azure-voice' },
    { realtime_model: '', realtime_voice: 'azure-voice' },
  ]) {
    const before = snapshot();
    const res = await save(writer, { engine: 'realtime', ...fields });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('OpenAI');
    expect(snapshot()).toEqual(before);
  }
});

it.each(writers)('%s saves compatible direct drafts without live keys', async writer => {
  selectProvider('openai');
  for (const fields of [
    { realtime_model: 'gpt-realtime', realtime_voice: 'marin' },
    { realtime_model: 'gpt-4o-realtime-preview', realtime_voice: 'alloy' },
    { realtime_model: 'gpt-realtime-custom-version', realtime_voice: 'cedar' },
    { realtime_model: '', realtime_voice: '' },
    { engine: 'pipeline', realtime_model: 'kataleptic-realtime', realtime_voice: 'azure-voice' },
  ]) {
    const res = await save(writer, { engine: 'realtime', ...fields });
    expect(res.status).toBe(writer === 'studio-create' ? 201 : 200);
  }
});

it.each(writers)('%s preserves custom and gateway draft namespaces', async writer => {
  for (const provider of ['custom', 'kataleptic', 'instance']) {
    selectProvider(provider);
    const res = await save(writer, { engine: 'realtime', realtime_model: 'custom-model', realtime_voice: 'custom-voice' });
    expect(res.status).toBe(writer === 'studio-create' ? 201 : 200);
  }
});

it.each(writers)('%s checks instance OpenAI model/voice without requiring its key', async writer => {
  selectProvider('instance'); env.REALTIME_PROVIDER = 'openai';
  const before = snapshot();
  expect((await save(writer, { engine: 'realtime', realtime_model: 'kataleptic-realtime' })).status).toBe(400);
  expect(snapshot()).toEqual(before);
  expect((await save(writer, { engine: 'realtime', realtime_model: 'gpt-realtime', realtime_voice: 'marin' })).status)
    .toBe(writer === 'studio-create' ? 201 : 200);
});

it.each(['legacy', 'studio-update'] as Writer[])('%s validates effective retained fields and accepts an atomic correction', async writer => {
  selectProvider('openai');
  db.exec("UPDATE assistants SET engine='realtime',realtime_model='kataleptic-realtime',realtime_voice='azure-voice' WHERE id='asst_b1'; UPDATE agent_settings SET engine='realtime',realtime_model='kataleptic-realtime',realtime_voice='azure-voice' WHERE business_id='b1';");
  const before = snapshot();
  expect((await save(writer, { realtime_model: 'gpt-realtime' })).status).toBe(400);
  expect(snapshot()).toEqual(before);
  expect((await save(writer, { realtime_model: 'gpt-realtime', realtime_voice: 'marin' })).status).toBe(200);
});
