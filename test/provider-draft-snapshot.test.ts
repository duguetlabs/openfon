import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
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

async function privatePrimary() {
  db.exec("UPDATE agent_settings SET engine='realtime',realtime_model='kataleptic-realtime',realtime_voice='azure-voice' WHERE business_id='b1'");
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  db.exec("UPDATE assistants SET state='draft',activated_at=NULL WHERE business_id='b1'");
  expect((await request('/api/public/agent/one', undefined, '')).status).toBe(404);
}
async function switchProvider(selection = 'openai') {
  return request('/api/me/provider', { realtime_provider: selection, realtime_api_key: selection === 'instance' ? '' : 'synthetic-key' });
}
function primary() {
  return db.database.prepare("SELECT state,activated_at,realtime_model,realtime_voice FROM assistants WHERE business_id='b1'").get();
}
function snapshot() {
  return ['assistants','agent_settings','provider_settings','compatibility_sync_state','rate_counters'].map(table =>
    db.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

it.each([{ bootstrapFirst: true, selection: 'openai' }, { bootstrapFirst: false, selection: 'openai' },
  { bootstrapFirst: true, selection: 'instance' }, { bootstrapFirst: false, selection: 'instance' }])
('OpenAI cleanup keeps primary draft private (%j)', async ({ bootstrapFirst, selection }) => {
  await privatePrimary();
  if (selection === 'instance') {
    env.REALTIME_PROVIDER = 'openai';
    db.exec("UPDATE provider_settings SET realtime_provider='kataleptic' WHERE business_id='b1'");
  }
  expect((await switchProvider(selection)).status).toBe(200);
  expect(primary()).toEqual({ state: 'draft', activated_at: null, realtime_model: '', realtime_voice: '' });
  if (bootstrapFirst) expect((await request('/api/me/bootstrap')).status).toBe(200);
  expect((await request('/api/public/agent/one', undefined, '')).status).toBe(404);
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  expect(primary()).toEqual({ state: 'draft', activated_at: null, realtime_model: '', realtime_voice: '' });
  const row = db.database.prepare("SELECT agent_snapshot FROM compatibility_sync_state WHERE business_id='b1'").get() as { agent_snapshot: string };
  expect(JSON.parse(row.agent_snapshot)).toMatchObject({ realtime_model: '', realtime_voice: '' });
});

it('still reconciles a genuine later legacy-worker edit', async () => {
  await privatePrimary();
  expect((await switchProvider()).status).toBe(200);
  db.exec("UPDATE agent_settings SET greeting='Changed by legacy worker' WHERE business_id='b1'");
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  expect(db.database.prepare("SELECT state,greeting FROM assistants WHERE business_id='b1'").get())
    .toEqual({ state: 'active', greeting: 'Changed by legacy worker' });
  expect((await request('/api/public/agent/one', undefined, '')).status).toBe(200);
});

it('rolls back provider cleanup and snapshot when assistant quota refuses', async () => {
  await privatePrimary();
  db.exec("UPDATE rate_counters SET count=200 WHERE bucket='assistants:b1'");
  const before = snapshot();
  expect((await switchProvider()).status).toBe(429);
  expect(snapshot()).toEqual(before);
  expect((await request('/api/public/agent/one', undefined, '')).status).toBe(404);
});
