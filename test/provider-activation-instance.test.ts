import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resolveRealtime } from '../src/realtime-providers';
import { transcribe } from '../src/providers';
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
  // Establish compatibility/knowledge state before full refusal snapshots.
  expect((await request('/api/me/bootstrap')).status).toBe(200);
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });


function snapshot() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
function draft(state = 'draft', model = 'custom-retained-model', voice = 'marin', engine = 'realtime') {
  db.database.prepare(`INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language,engine,realtime_model,realtime_voice)
    VALUES ('candidate','b1','candidate',?,'Candidate','Helpful','en',?,?,?)`).run(state, engine, model, voice);
}
const direct = { realtime_provider: 'openai', realtime_base_url: 'wss://api.openai.com/v1/realtime', realtime_api_key: 'synthetic-direct' };

it.each(['draft', 'paused'])('refuses activation of preserved %s custom model after direct and instance OpenAI switches', async state => {
  draft(state);
  for (const selection of ['openai', 'instance']) {
    env.REALTIME_PROVIDER = 'openai'; env.REALTIME_API_KEY = 'synthetic-operator';
    expect((await request('/api/me/provider', { ...direct, realtime_provider: selection,
      realtime_api_key: selection === 'instance' ? '' : direct.realtime_api_key })).status).toBe(200);
    const before = snapshot();
    const rejected = await request('/api/me/assistants/candidate/activate', {}, 's1', 'POST');
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('OpenAI');
    expect(snapshot()).toEqual(before);
    expect((await request('/api/public/agent/candidate', undefined, '')).status).toBe(404);
    expect(db.database.prepare("SELECT state,realtime_model,activated_at FROM assistants WHERE id='candidate'").get())
      .toEqual({ state, realtime_model: 'custom-retained-model', activated_at: null });
  }
  expect((await request('/api/me/assistants/candidate', { realtime_model: 'gpt-realtime', realtime_voice: 'marin' })).status).toBe(200);
  expect((await request('/api/me/assistants/candidate/activate', {}, 's1', 'POST')).status).toBe(200);
  expect((await request('/api/public/agent/candidate', undefined, '')).status).toBe(200);
});

it('rejects a retained incompatible voice without requiring provider credentials for compatible activation', async () => {
  draft('paused', 'gpt-realtime', 'custom-voice');
  db.exec("UPDATE provider_settings SET realtime_provider='openai' WHERE business_id='b1'");
  env.REALTIME_API_KEY = ''; env.DEFAULT_LLM_API_KEY = '';
  const before = snapshot();
  expect((await request('/api/me/assistants/candidate/activate', {}, 's1', 'POST')).status).toBe(400);
  expect(snapshot()).toEqual(before);
  expect((await request('/api/me/assistants/candidate', { realtime_voice: '' })).status).toBe(200);
  expect((await request('/api/me/assistants/candidate/activate', {}, 's1', 'POST')).status).toBe(200);
});

it.each(['custom', 'kataleptic', 'instance', 'pipeline'])('keeps %s activation semantics and foreign-workspace privacy', async selection => {
  draft('draft', 'custom-retained-model', 'custom-voice', selection === 'pipeline' ? 'pipeline' : 'realtime');
  db.database.prepare("UPDATE provider_settings SET realtime_provider=? WHERE business_id='b1'").run(selection === 'pipeline' ? 'openai' : selection);
  const before = snapshot();
  expect((await request('/api/me/assistants/candidate/activate', {}, 's2', 'POST')).status).toBe(404);
  expect(snapshot()).toEqual(before);
  expect((await request('/api/me/assistants/candidate/activate', {}, 's1', 'POST')).status).toBe(200);
});

it('keeps activation quota refusal atomic for a compatible candidate', async () => {
  draft('draft', 'gpt-realtime', 'marin');
  db.exec("UPDATE provider_settings SET realtime_provider='openai' WHERE business_id='b1'; UPDATE rate_counters SET count=200 WHERE bucket='assistants:b1'");
  const before = snapshot();
  expect((await request('/api/me/assistants/candidate/activate', {}, 's1', 'POST')).status).toBe(429);
  expect(snapshot()).toEqual(before);
});

it.each(['realtime', 'stt'])('rejects a submitted %s instance secret without saving accompanying changes', async capability => {
  const before = snapshot();
  const res = await request('/api/me/provider', { model: 'must-not-save', [`${capability}_provider`]: 'instance', [`${capability}_api_key`]: 'synthetic-unused' });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain('operator key');
  expect(snapshot()).toEqual(before);
});

it('reports absent operator credentials despite historical unused instance keys, then clears those keys on save', async () => {
  db.exec("UPDATE provider_settings SET realtime_api_key='synthetic-stale-rt',stt_api_key='synthetic-stale-stt' WHERE business_id='b1'");
  env.REALTIME_API_KEY = ''; env.DEFAULT_LLM_API_KEY = ''; env.DEFAULT_STT_API_KEY = '';
  const view = await (await request('/api/me/provider')).json() as any;
  expect(view).toMatchObject({ realtime_api_key_configured: false, stt_api_key_configured: false });
  expect(JSON.stringify(view)).not.toContain('synthetic-stale');
  expect((await request('/api/me/provider', { model: 'retained-text-model' })).status).toBe(200);
  expect(db.database.prepare("SELECT realtime_api_key,stt_api_key,llm_model FROM provider_settings WHERE business_id='b1'").get())
    .toEqual({ realtime_api_key: '', stt_api_key: '', llm_model: 'retained-text-model' });
});

it.each(['kataleptic', 'openai', 'custom'])('reports actual %s instance key precedence and STT operator key', async provider => {
  env.REALTIME_PROVIDER = provider as Env['REALTIME_PROVIDER'];
  env.REALTIME_BASE_URL = provider === 'openai' ? direct.realtime_base_url : 'wss://custom.example/realtime';
  env.REALTIME_MODEL = 'gpt-realtime'; env.REALTIME_API_KEY = '';
  for (const realtimeKey of ['', 'synthetic-rt-operator']) {
    env.REALTIME_API_KEY = realtimeKey;
    const view = await (await request('/api/me/provider')).json() as any;
    const expectedKey = realtimeKey || (provider === 'kataleptic' ? env.DEFAULT_LLM_API_KEY : '');
    expect(view.realtime_api_key_configured).toBe(Boolean(expectedKey));
    expect(view.stt_api_key_configured).toBe(true);
    expect(JSON.stringify(view)).not.toContain('synthetic-rt-operator');
    if (expectedKey) expect(resolveRealtime(env, null).apiKey).toBe(expectedKey);
    else expect(() => resolveRealtime(env, null)).toThrow('API key');
  }
  // Synthetic fetch captures the actual STT credential source; no network call.
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${env.DEFAULT_STT_API_KEY}`);
    return Response.json({ text: 'Synthetic transcription' });
  });
  vi.stubGlobal('fetch', fetchMock);
  await transcribe(env, new ArrayBuffer(2), 'audio/wav', undefined, { stt_provider: 'instance', stt_api_key: 'ignored-stale-key' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each(['realtime', 'stt'])('never reuses historical instance %s keys for an explicit provider', async capability => {
  db.database.prepare(`UPDATE provider_settings SET ${capability}_api_key='synthetic-stale' WHERE business_id='b1'`).run();
  const before = snapshot();
  const fields = capability === 'realtime' ? { realtime_provider: 'openai', realtime_base_url: direct.realtime_base_url }
    : { stt_provider: 'openai', stt_base_url: 'https://api.openai.com/v1', stt_model: 'whisper-1' };
  expect((await request('/api/me/provider', fields)).status).toBe(400);
  expect(snapshot()).toEqual(before);
  expect((await request('/api/me/provider', { ...fields, [`${capability}_api_key`]: 'synthetic-replacement' })).status).toBe(200);
  // Same explicit endpoint keeps its own key, then selecting instance removes it.
  expect((await request('/api/me/provider', { model: 'changed-text' })).status).toBe(200);
  expect(db.database.prepare(`SELECT ${capability}_api_key AS key FROM provider_settings WHERE business_id='b1'`).get())
    .toEqual({ key: 'synthetic-replacement' });
  expect((await request('/api/me/provider', { [`${capability}_provider`]: 'instance' })).status).toBe(200);
  expect(db.database.prepare(`SELECT ${capability}_api_key AS key FROM provider_settings WHERE business_id='b1'`).get()).toEqual({ key: '' });
});

it('does not report or borrow operator keys for explicit providers without their own keys', async () => {
  env.REALTIME_API_KEY = 'synthetic-operator';
  db.exec("UPDATE provider_settings SET realtime_provider='openai',stt_provider='openai' WHERE business_id='b1'");
  const view = await (await request('/api/me/provider')).json() as any;
  expect(view).toMatchObject({ realtime_api_key_configured: false, stt_api_key_configured: false });
  expect(JSON.stringify(view)).not.toContain('synthetic-operator');
});

// Hold the final D1 activation write while another request commits. No sleeps,
// source mutation or relaxed assertion: the real API paths interleave here.
function holdActivation() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes("UPDATE assistants SET state='active', activated_at=")) {
      const first = statement.first.bind(statement);
      statement.first = async <T>() => { entered(); await gate; return first<T>(); };
    }
    return statement;
  });
  return { reached, release, restore: () => spy.mockRestore() };
}

it.each(['existing custom', 'missing'])('rejects activation when %s provider changes after compatibility check', async initial => {
  draft();
  if (initial === 'missing') db.exec("DELETE FROM provider_settings WHERE business_id='b1'");
  else db.exec("UPDATE provider_settings SET realtime_provider='custom',realtime_base_url='wss://custom.example/realtime',realtime_api_key='synthetic-custom' WHERE business_id='b1'");
  const hold = holdActivation();
  const activation = request('/api/me/assistants/candidate/activate', {}, 's1', 'POST');
  try {
    await hold.reached;
    expect((await request('/api/me/provider', direct)).status).toBe(200);
    const beforeRelease = snapshot();
    hold.release();
    const response = await activation;
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('retry activation');
    expect(snapshot()).toEqual(beforeRelease);
    expect((await request('/api/public/agent/candidate', undefined, '')).status).toBe(404);
    expect((await request('/api/me/assistants/candidate/activate', {}, 's1', 'POST')).status).toBe(400);
  } finally { hold.release(); await activation; hold.restore(); }
});

it('rejects activation if its checked provider row disappears', async () => {
  draft('draft', 'gpt-realtime', 'marin');
  db.exec("UPDATE provider_settings SET realtime_provider='openai' WHERE business_id='b1'");
  const hold = holdActivation();
  const activation = request('/api/me/assistants/candidate/activate', {}, 's1', 'POST');
  try {
    await hold.reached;
    db.exec("DELETE FROM provider_settings WHERE business_id='b1'");
    const beforeRelease = snapshot();
    hold.release();
    expect((await activation).status).toBe(409);
    expect(snapshot()).toEqual(beforeRelease);
  } finally { hold.release(); await activation; hold.restore(); }
});

it.each([{ engine: 'pipeline' }, { realtime_model: 'new-custom-model' }, { realtime_voice: 'new-custom-voice' }])
('rejects an assistant configuration edit after activation precheck (%j)', async edit => {
  draft();
  db.exec("UPDATE provider_settings SET realtime_provider='custom' WHERE business_id='b1'");
  const hold = holdActivation();
  const activation = request('/api/me/assistants/candidate/activate', {}, 's1', 'POST');
  try {
    await hold.reached;
    expect((await request('/api/me/assistants/candidate', edit)).status).toBe(200);
    const beforeRelease = snapshot();
    hold.release();
    expect((await activation).status).toBe(409);
    expect(snapshot()).toEqual(beforeRelease);
    hold.restore();
    expect((await request('/api/me/assistants/candidate/activate', {}, 's1', 'POST')).status).toBe(200);
  } finally { hold.release(); await activation; hold.restore(); }
});
