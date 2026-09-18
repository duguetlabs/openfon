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
  // Establish compatibility/knowledge state before full refusal snapshots.
  expect((await request('/api/me/bootstrap')).status).toBe(200);
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });


type Writer = 'assistant-update' | 'preset-apply' | 'legacy-update' | 'legacy-apply';
const writers: Writer[] = ['assistant-update', 'preset-apply', 'legacy-update', 'legacy-apply'];
const custom = { realtime_provider: 'custom', realtime_base_url: 'wss://custom.example/realtime', realtime_api_key: 'synthetic-custom' };
const openai = { realtime_provider: 'openai', realtime_base_url: 'wss://api.openai.com/v1/realtime', realtime_api_key: 'synthetic-openai' };
const fields = { engine: 'realtime', realtime_model: 'my-custom-model', realtime_voice: 'custom-voice', language: 'de' };
let presetId: string;
function snapshot() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
async function setup(target = 'asst_b1', state = 'active') {
  expect((await request('/api/me/provider', custom)).status).toBe(200);
  if (target !== 'asst_b1') {
    db.database.prepare(`INSERT INTO assistants(id,business_id,public_slug,name,persona,language,state)
      VALUES (?,'b1',?,'Secondary','Helpful','en',?)`).run(target, target, state);
  }
  expect((await request(`/api/me/assistants/${target}`, fields)).status).toBe(200);
  // The primary was provisioned before this fixture; make state explicit.
  db.database.prepare('UPDATE assistants SET state=? WHERE id=?').run(state, target);
  const res = await request('/api/me/engine-presets', { name: 'Custom preset', ...fields }, 's1', 'POST');
  expect(res.status).toBe(201);
  presetId = (await res.json() as { id: string }).id;
}
function save(writer: Writer, target = 'asst_b1', token = 's1') {
  if (writer === 'legacy-apply') return request(`/api/me/profiles/${presetId}/apply`, {}, token, 'POST');
  if (writer === 'legacy-update') return request('/api/me/business/b1/agent', { ...fields, agent_name: 'Updated assistant' }, token);
  return writer === 'assistant-update'
    ? request(`/api/me/assistants/${target}`, { ...fields, name: 'Updated assistant' }, token)
    : request(`/api/me/engine-presets/${presetId}/apply`, { assistantId: target }, token, 'POST');
}
function holdWrite() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const matching = new WeakSet<object>();
  const prepare = db.prepare.bind(db);
  const batch = db.batch.bind(db);
  let held = false;
  const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const stmt = prepare(sql);
    if (sql.includes('UPDATE assistants SET name=?') || sql.includes('UPDATE assistants SET engine=?')) matching.add(stmt);
    return stmt;
  });
  const batchSpy = vi.spyOn(db, 'batch').mockImplementation(async statements => {
    if (!held && statements.some(statement => matching.has(statement))) { held = true; entered(); await gate; }
    return batch(statements);
  });
  return { reached, release, restore() { prepareSpy.mockRestore(); batchSpy.mockRestore(); } };
}

for (const writer of writers) {
  it.each(writer.startsWith('legacy-') ? [{ target: 'asst_b1', state: 'active' }, { target: 'asst_b1', state: 'draft' }]
    : [{ target: 'asst_b1', state: 'active' }, { target: 'secondary', state: 'active' }, { target: 'secondary', state: 'draft' }])
  (`${writer} refuses a stale provider write without touching quota/mirror/snapshot (%j)`, async ({ target, state }) => {
    await setup(target, state);
    const hold = holdWrite(); const pending = save(writer, target);
    try {
      await hold.reached;
      expect((await request('/api/me/provider', openai)).status).toBe(200);
      const expected = snapshot();
      hold.release();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(await response.text()).toContain('Reload and retry');
      expect(snapshot()).toEqual(expected);
      expect((await save(writer, target)).status).toBe(400);
      expect(snapshot()).toEqual(expected);
      if (state === 'draft') {
        expect((await request(`/api/public/agent/${target === 'asst_b1' ? 'one' : target}`, undefined, '')).status).toBe(404);
        expect(db.database.prepare('SELECT state,realtime_model FROM assistants WHERE id=?').get(target))
          .toEqual({ state: 'draft', realtime_model: fields.realtime_model });
      }
    } finally { hold.release(); await pending; hold.restore(); }
  });

  it.each(['url', 'key', 'missing-to-present', 'present-to-missing'])
  (`${writer} detects checked provider changes (%s)`, async change => {
    await setup();
    if (change === 'missing-to-present') db.exec("DELETE FROM provider_settings WHERE business_id='b1'");
    const hold = holdWrite(); const pending = save(writer);
    try {
      await hold.reached;
      if (change === 'present-to-missing') db.exec("DELETE FROM provider_settings WHERE business_id='b1'");
      else expect((await request('/api/me/provider', change === 'url'
        ? { ...custom, realtime_base_url: 'wss://changed.example/realtime', realtime_api_key: 'synthetic-replacement' }
        : { ...custom, realtime_api_key: 'synthetic-rotated' })).status).toBe(200);
      const expected = snapshot();
      hold.release();
      expect((await pending).status).toBe(409);
      expect(snapshot()).toEqual(expected);
      hold.restore();
      expect((await save(writer)).status).toBe(200);
    } finally { hold.release(); await pending; hold.restore(); }
  });

  it(`${writer} updates the primary and snapshot atomically without charging extra assistant quota`, async () => {
    await setup();
    const before = db.database.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:b1'").get() as { count: number };
    expect((await save(writer)).status).toBe(200);
    expect(db.database.prepare("SELECT engine,realtime_model,realtime_voice,language FROM assistants WHERE id='asst_b1'").get()).toEqual(fields);
    expect(db.database.prepare("SELECT engine,realtime_model,realtime_voice,language FROM agent_settings WHERE business_id='b1'").get()).toEqual(fields);
    const sync = db.database.prepare("SELECT agent_snapshot FROM compatibility_sync_state WHERE business_id='b1'").get() as { agent_snapshot: string };
    expect(JSON.parse(sync.agent_snapshot)).toMatchObject(fields);
    expect(db.database.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:b1'").get()).toEqual({ count: before.count + 1 });
  });

  it(`${writer} rolls back every row and counter on quota refusal and late snapshot failure`, async () => {
    await setup();
    db.exec("UPDATE rate_counters SET count=200 WHERE bucket='assistants:b1'");
    const atQuota = snapshot();
    expect((await save(writer)).status).toBe(429);
    expect(snapshot()).toEqual(atQuota);
    db.exec("UPDATE rate_counters SET count=10 WHERE bucket='assistants:b1'");
    const beforeLateFailure = snapshot();
    db.hook = sql => { if (sql.includes('UPDATE compatibility_sync_state SET agent_snapshot=')) throw new Error('synthetic snapshot failure'); };
    try { expect((await save(writer)).status).toBe(500); } finally { db.hook = null; }
    expect(snapshot()).toEqual(beforeLateFailure);
    expect((await save(writer)).status).toBe(200);
  });

  it(`${writer} keeps foreign ownership refusal unchanged`, async () => {
    await setup();
    const before = snapshot();
    expect((await save(writer, 'asst_b1', 's2')).status).toBe(404);
    expect(snapshot()).toEqual(before);
  });
}

it.each(['before provider read', 'before batch'])('legacy writer cannot undo a text credential rotation (%s)', async boundary => {
  await setup();
  let reached: Promise<void>;
  let release!: () => void;
  let restore: () => void;
  if (boundary === 'before batch') {
    const hold = holdWrite(); ({ reached, release, restore } = hold);
  } else {
    let entered!: () => void;
    reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.includes('assistants.name AS agent_name')) {
        const first = statement.first.bind(statement);
        statement.first = async <T>() => { const row = await first<T>(); entered(); await gate; return row; };
      }
      return statement;
    });
    restore = () => spy.mockRestore();
  }
  const pending = save('legacy-update');
  try {
    await reached;
    expect((await request('/api/me/provider', { baseUrl: 'https://text.example/v1', apiKey: 'synthetic-new-text' })).status).toBe(200);
    const expected = snapshot();
    release();
    expect((await pending).status).toBe(409);
    expect(snapshot()).toEqual(expected);
    restore();
    expect((await save('legacy-update')).status).toBe(200);
    expect(db.database.prepare("SELECT llm_base_url,llm_api_key FROM provider_settings WHERE business_id='b1'").get())
      .toEqual({ llm_base_url: 'https://text.example/v1', llm_api_key: 'synthetic-new-text' });
  } finally { release(); await pending; restore(); }
});

it('legacy writer retains default keys, permits explicit replacement/clear, and keeps credential mirrors atomic', async () => {
  await setup();
  for (const fields of [{ llm_api_key: 'synthetic-text' }, {}, { llm_api_key: '••••' }, { clearApiKey: true }]) {
    expect((await request('/api/me/business/b1/agent', fields)).status).toBe(200);
    const expected = { llm_base_url: '', llm_api_key: 'clearApiKey' in fields ? '' : 'synthetic-text' };
    expect(db.database.prepare("SELECT llm_base_url,llm_api_key FROM provider_settings WHERE business_id='b1'").get()).toEqual(expected);
    expect(db.database.prepare("SELECT llm_base_url,llm_api_key FROM agent_settings WHERE business_id='b1'").get()).toEqual(expected);
  }
});

it('legacy profile apply preserves current credentials and profile fields', async () => {
  await setup();
  expect((await request('/api/me/provider', { baseUrl: 'https://text.example/v1', apiKey: 'synthetic-current-text' })).status).toBe(200);
  const beforeProvider = db.database.prepare("SELECT * FROM provider_settings WHERE business_id='b1'").get();
  const beforeProfile = db.database.prepare('SELECT * FROM engine_profiles WHERE id=?').get(presetId);
  expect((await save('legacy-apply')).status).toBe(200);
  expect(db.database.prepare("SELECT * FROM provider_settings WHERE business_id='b1'").get()).toEqual(beforeProvider);
  expect(db.database.prepare('SELECT * FROM engine_profiles WHERE id=?').get(presetId)).toEqual(beforeProfile);
  expect(db.database.prepare("SELECT llm_base_url,llm_api_key FROM agent_settings WHERE business_id='b1'").get())
    .toEqual({ llm_base_url: 'https://text.example/v1', llm_api_key: 'synthetic-current-text' });
});

it('legacy profile apply refuses a missing primary without changing legacy fields or snapshot', async () => {
  await setup();
  db.exec("DELETE FROM assistants WHERE id='asst_b1'");
  const before = snapshot();
  expect((await save('legacy-apply')).status).toBe(409);
  expect(snapshot()).toEqual(before);
});

function holdProviderPut(missingProvider = false) {
  let providerReads = 0;
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const matching = new WeakSet<object>();
  const prepare = db.prepare.bind(db); const batch = db.batch.bind(db);
  let held = false;
  const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    if (missingProvider && sql === 'SELECT * FROM provider_settings WHERE business_id = ?' && ++providerReads === 2) {
      const first = statement.first.bind(statement);
      statement.first = async <T>() => { db.exec("DELETE FROM provider_settings WHERE business_id='b1'"); return first<T>(); };
    }
    if (sql.includes('INSERT INTO provider_settings (business_id, llm_base_url, llm_api_key, llm_model,')) matching.add(statement);
    return statement;
  });
  const batchSpy = vi.spyOn(db, 'batch').mockImplementation(async statements => {
    if (!held && matching.has(statements[0])) { held = true; entered(); await gate; }
    return batch(statements);
  });
  return { reached, release, restore() { prepareSpy.mockRestore(); batchSpy.mockRestore(); } };
}

it('provider PUT refuses stale OpenAI restore after custom switch and active custom edit', async () => {
  await setup();
  expect((await request('/api/me/provider', openai)).status).toBe(200);
  const hold = holdProviderPut(); const pending = request('/api/me/provider', { model: 'stale-partial-text-edit' });
  try {
    await hold.reached;
    expect((await request('/api/me/provider', custom)).status).toBe(200);
    expect((await request('/api/me/assistants/asst_b1', fields)).status).toBe(200);
    const expected = snapshot();
    hold.release();
    expect((await pending).status).toBe(409);
    expect(snapshot()).toEqual(expected);
    hold.restore();
    expect((await request('/api/me/provider', { model: 'fresh-partial-text-edit' })).status).toBe(200);
    expect(db.database.prepare("SELECT realtime_provider,llm_model FROM provider_settings WHERE business_id='b1'").get())
      .toEqual({ realtime_provider: 'custom', llm_model: 'fresh-partial-text-edit' });
  } finally { hold.release(); await pending; hold.restore(); }
});

it.each(['same requested next', 'text rotation', 'STT rotation'])('provider PUT pins the captured row (%s)', async change => {
  await setup();
  const hold = holdProviderPut();
  const pending = request('/api/me/provider', change === 'same requested next' ? openai : { model: 'stale-partial' });
  try {
    await hold.reached;
    const edit = change === 'same requested next' ? openai : change === 'text rotation'
      ? { apiKey: 'synthetic-concurrent-text' }
      : { stt_provider: 'openai', stt_base_url: 'https://api.openai.com/v1', stt_model: 'whisper-1', stt_api_key: 'synthetic-concurrent-stt' };
    expect((await request('/api/me/provider', edit)).status).toBe(200);
    const expected = snapshot();
    hold.release();
    expect((await pending).status).toBe(409);
    expect(snapshot()).toEqual(expected);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('provider PUT refuses a concurrent row creation after capturing a missing provider', async () => {
  await setup();
  const hold = holdProviderPut(true); const pending = request('/api/me/provider', openai);
  try {
    await hold.reached;
    expect(db.database.prepare("SELECT business_id FROM provider_settings WHERE business_id='b1'").get()).toBeUndefined();
    expect((await request('/api/me/provider', custom)).status).toBe(200);
    const expected = snapshot();
    hold.release();
    expect((await pending).status).toBe(409);
    expect(snapshot()).toEqual(expected);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('provider PUT continues later cleanup after zero-row model cleanup and avoids unchanged-row quota charges', async () => {
  await setup();
  expect((await request('/api/me/assistants/asst_b1', { realtime_model: 'gpt-realtime', realtime_voice: 'custom-voice' })).status).toBe(200);
  const count = () => (db.database.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:b1'").get() as { count: number }).count;
  const before = count();
  expect((await request('/api/me/provider', openai)).status).toBe(200);
  expect(db.database.prepare("SELECT realtime_model,realtime_voice FROM assistants WHERE id='asst_b1'").get())
    .toEqual({ realtime_model: 'gpt-realtime', realtime_voice: '' });
  expect(count()).toBe(before + 1);
  const synced = db.database.prepare("SELECT agent_snapshot FROM compatibility_sync_state WHERE business_id='b1'").get() as { agent_snapshot: string };
  expect(JSON.parse(synced.agent_snapshot)).toMatchObject({ realtime_model: 'gpt-realtime', realtime_voice: '' });
  expect((await request('/api/me/provider', { model: 'unrelated-text-edit' })).status).toBe(200);
  expect(count()).toBe(before + 1);
});
