import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resolveRealtime } from '../src/realtime-providers';
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


function rows() {
  return ['assistants', 'agent_settings', 'provider_settings', 'compatibility_sync_state', 'rate_counters'].map(table =>
    db.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
async function customPrimary() {
  db.exec("UPDATE agent_settings SET engine='realtime',realtime_model='my-custom-model',realtime_voice='marin' WHERE business_id='b1'");
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  db.exec("UPDATE provider_settings SET realtime_provider='custom',realtime_base_url='wss://custom.example/realtime',realtime_api_key='synthetic-old' WHERE business_id='b1'");
}
const openai = { realtime_provider: 'openai', realtime_base_url: 'wss://api.openai.com/v1/realtime', realtime_api_key: 'synthetic-new' };

it.each(['openai', 'instance'])('normalizes active custom models on effective OpenAI switch (%s)', async selection => {
  await customPrimary();
  env.REALTIME_PROVIDER = 'openai'; env.REALTIME_MODEL = 'gpt-realtime'; env.REALTIME_BASE_URL = openai.realtime_base_url; env.REALTIME_API_KEY = 'synthetic-instance';
  db.exec(`INSERT INTO assistants(id,business_id,public_slug,state,engine,realtime_model) VALUES
    ('draft','b1','private','draft','realtime','my-custom-model'),
    ('paused','b1','paused','paused','realtime','my-custom-model'),
    ('pipeline','b1','pipeline','active','pipeline','my-custom-model'),
    ('valid','b1','valid','active','realtime','gpt-4o-realtime-preview'),
    ('upper','b1','upper','active','realtime','GPT-realtime'),
    ('other','b2','other','active','realtime','my-custom-model');
    INSERT INTO engine_profiles(id,business_id,name,engine,realtime_model) VALUES ('saved','b1','Saved','realtime','my-custom-model');`);
  expect((await request('/api/me/provider', { ...openai, realtime_provider: selection, realtime_api_key: selection === 'instance' ? '' : openai.realtime_api_key })).status).toBe(200);
  const provider = db.database.prepare("SELECT * FROM provider_settings WHERE business_id='b1'").get() as any;
  for (const table of ['assistants', 'agent_settings']) {
    const current = db.database.prepare(`SELECT * FROM ${table} WHERE business_id='b1' ${table === 'assistants' ? "AND public_slug='one'" : ''}`).get() as any;
    expect(current.realtime_model).toBe('');
    expect(resolveRealtime(env, { ...current, ...provider }).model).toBe('gpt-realtime');
  }
  expect(db.database.prepare("SELECT realtime_model FROM assistants WHERE id='upper'").get()).toEqual({ realtime_model: '' });
  for (const id of ['draft', 'paused', 'pipeline', 'other']) expect(db.database.prepare('SELECT realtime_model FROM assistants WHERE id=?').get(id)).toEqual({ realtime_model: 'my-custom-model' });
  expect(db.database.prepare("SELECT realtime_model FROM assistants WHERE id='valid'").get()).toEqual({ realtime_model: 'gpt-4o-realtime-preview' });
  expect(db.database.prepare("SELECT realtime_model FROM engine_profiles WHERE id='saved'").get()).toEqual({ realtime_model: 'my-custom-model' });
  const sync = db.database.prepare("SELECT agent_snapshot FROM compatibility_sync_state WHERE business_id='b1'").get() as any;
  expect(JSON.parse(sync.agent_snapshot).realtime_model).toBe('');
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  expect((await request('/api/public/agent/private', undefined, '')).status).toBe(404);
});

it('refuses active cleanup atomically at quota', async () => {
  await customPrimary();
  db.exec("UPDATE rate_counters SET count=200 WHERE bucket='assistants:b1'");
  const before = rows();
  expect((await request('/api/me/provider', openai)).status).toBe(429);
  expect(rows()).toEqual(before);
});

it('keeps a custom primary draft private through switch and reconciliation', async () => {
  await customPrimary();
  db.exec("UPDATE assistants SET state='draft',activated_at=NULL WHERE business_id='b1'");
  expect((await request('/api/me/provider', openai)).status).toBe(200);
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  expect((await request('/api/public/agent/one', undefined, '')).status).toBe(404);
  for (const table of ['assistants', 'agent_settings']) expect(db.database.prepare(`SELECT realtime_model FROM ${table} WHERE business_id='b1'`).get()).toEqual({ realtime_model: 'my-custom-model' });
});

it.each([undefined, 'false', 'true'])('honors realtime insecure-local opt-in=%s without weakening URL checks', async flag => {
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  env.ALLOW_INSECURE_LLM_URL = flag;
  const local = { realtime_provider: 'custom', realtime_base_url: 'ws://localhost:9000/realtime', realtime_api_key: 'synthetic-local' };
  const before = rows();
  expect((await request('/api/me/provider', local)).status).toBe(flag === 'true' ? 200 : 400);
  if (flag !== 'true') { expect(rows()).toEqual(before); return; }
  const provider = db.database.prepare("SELECT * FROM provider_settings WHERE business_id='b1'").get() as any;
  expect(resolveRealtime(env, provider).baseUrl).toBe(local.realtime_base_url);
  const saved = rows();
  for (const url of ['ws://localhost:9000/realtime?model=x', 'ws://localhost:9000/realtime#fragment', 'ws://user:pass@localhost/realtime', 'http://localhost:9000/realtime']) {
    expect((await request('/api/me/provider', { ...local, realtime_base_url: url })).status).toBe(400);
    expect(rows()).toEqual(saved);
  }
  expect((await request('/api/me/provider', { ...local, realtime_provider: 'openai' })).status).toBe(400);
  expect(rows()).toEqual(saved);
});


it.each(['\n', '\r', '\u2028', '\u2029'])('matches runtime line-terminator handling without wiping inactive models (%j)', async separator => {
  await customPrimary();
  const invalid = `gpt-4o${separator}realtime`;
  db.database.prepare("UPDATE agent_settings SET realtime_model=? WHERE business_id='b1'").run(invalid);
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  for (const [id, state, model] of [
    ['draft-break', 'draft', invalid],
    ['trailing-break', 'active', `gpt-4o-realtime${separator}preview`],
    ['direct-break', 'active', `gpt-realtime${separator}preview`],
  ]) db.database.prepare("INSERT INTO assistants(id,business_id,public_slug,state,engine,realtime_model) VALUES (?,'b1',?,?,'realtime',?)")
    .run(id, id, state, model);
  db.database.prepare("INSERT INTO engine_profiles(id,business_id,name,engine,realtime_model) VALUES ('break-profile','b1','Saved','realtime',?)").run(invalid);
  expect(() => resolveRealtime(env, { ...openai, realtime_model: invalid } as any)).toThrow('Choose an OpenAI realtime model');
  expect((await request('/api/me/provider', openai)).status).toBe(200);
  for (const table of ['assistants', 'agent_settings']) {
    const row = db.database.prepare(`SELECT realtime_model FROM ${table} WHERE business_id='b1' ${table === 'assistants' ? "AND public_slug='one'" : ''}`).get() as any;
    expect(row.realtime_model).toBe('');
    expect(resolveRealtime(env, { ...openai, ...row } as any).model).toBe('gpt-realtime');
  }
  for (const id of ['trailing-break', 'direct-break']) {
    const row = db.database.prepare('SELECT realtime_model FROM assistants WHERE id=?').get(id) as any;
    expect(row.realtime_model).toContain(separator);
    expect(resolveRealtime(env, { ...openai, ...row } as any).model).toBe(row.realtime_model);
  }
  expect(db.database.prepare("SELECT realtime_model FROM assistants WHERE id='draft-break'").get()).toEqual({ realtime_model: invalid });
  expect(db.database.prepare("SELECT realtime_model FROM engine_profiles WHERE id='break-profile'").get()).toEqual({ realtime_model: invalid });
  const snapshot = db.database.prepare("SELECT agent_snapshot FROM compatibility_sync_state WHERE business_id='b1'").get() as any;
  expect(JSON.parse(snapshot.agent_snapshot).realtime_model).toBe('');
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  expect((await request('/api/public/agent/draft-break', undefined, '')).status).toBe(404);
});


it.each([
  [' gpt-4o-realtime', ''],
  ['gpt-4o-realtime ', 'gpt-4o-realtime '],
  ['gpt-4o\trealtime', 'gpt-4o\trealtime'],
])('matches runtime without trimming persisted model %j', async (model, expected) => {
  await customPrimary();
  db.database.prepare("UPDATE agent_settings SET realtime_model=? WHERE business_id='b1'").run(model);
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  if (expected) expect(resolveRealtime(env, { ...openai, realtime_model: model } as any).model).toBe(model);
  else expect(() => resolveRealtime(env, { ...openai, realtime_model: model } as any)).toThrow('Choose an OpenAI realtime model');
  expect((await request('/api/me/provider', openai)).status).toBe(200);
  for (const table of ['assistants', 'agent_settings']) {
    expect(db.database.prepare(`SELECT realtime_model FROM ${table} WHERE business_id='b1'`).get()).toEqual({ realtime_model: expected });
  }
});
