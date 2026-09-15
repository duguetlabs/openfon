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


const custom = { realtime_provider: 'custom', realtime_base_url: 'wss://custom.example/realtime', realtime_api_key: 'synthetic-custom' };
const openai = { realtime_provider: 'openai', realtime_base_url: 'wss://api.openai.com/v1/realtime', realtime_api_key: 'synthetic-openai' };
const draft = { name: 'Requested draft', engine: 'realtime', realtime_model: 'custom-model', realtime_voice: 'custom-voice' };
const create = (body = draft) => request('/api/me/assistants', body, 's1', 'POST');
function snapshot() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
const count = () => (db.database.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:b1'").get() as { count: number }).count;
function holdCreate(boundary: 'before foundation' | 'before insert' = 'before insert') {
  let entered!: () => void, release!: () => void, held = false;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  const marked = new WeakSet<object>();
  const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes('INSERT INTO assistants (')) marked.add(statement);
    if (boundary === 'before foundation' && sql === 'SELECT * FROM provider_settings WHERE business_id = ?') {
      const first = statement.first.bind(statement);
      statement.first = async <T>() => {
        const row = await first<T>();
        if (!held) { held = true; entered(); await gate; }
        return row;
      };
    }
    return statement;
  });
  const batchSpy = vi.spyOn(db, 'batch').mockImplementation(async statements => {
    if (boundary === 'before insert' && !held && marked.has(statements[0])) { held = true; entered(); await gate; }
    return batch(statements);
  });
  return { reached, release, restore() { prepareSpy.mockRestore(); batchSpy.mockRestore(); } };
}

it.each(['before foundation', 'before insert'] as const)('create refuses a concurrent incompatible provider (%s)', async boundary => {
  expect((await request('/api/me/provider', custom)).status).toBe(200);
  const hold = holdCreate(boundary); const pending = create();
  try {
    await hold.reached;
    expect((await request('/api/me/provider', openai)).status).toBe(200);
    const before = snapshot(); hold.release();
    expect((await pending).status).toBe(409);
    expect(snapshot()).toEqual(before);
    hold.restore();
    expect((await create()).status).toBe(400);
    expect(snapshot()).toEqual(before);
  } finally { hold.release(); await pending; hold.restore(); }
});

it.each(['url', 'key', 'deleted'])('create pins its post-repair provider snapshot (%s)', async change => {
  expect((await request('/api/me/provider', custom)).status).toBe(200);
  const hold = holdCreate(); const pending = create();
  try {
    await hold.reached;
    if (change === 'deleted') db.exec("DELETE FROM provider_settings WHERE business_id='b1'");
    else expect((await request('/api/me/provider', change === 'url'
      ? { ...custom, realtime_base_url: 'wss://rotated.example/realtime' }
      : { ...custom, realtime_api_key: 'synthetic-rotated' })).status).toBe(200);
    const before = snapshot(); hold.release();
    expect((await pending).status).toBe(409);
    expect(snapshot()).toEqual(before);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('known incompatible preflight does not repair a missing provider or primary', async () => {
  env.REALTIME_PROVIDER = 'openai';
  db.exec("DELETE FROM provider_settings WHERE business_id='b1'; DELETE FROM assistants WHERE id='asst_b1'");
  const before = snapshot();
  expect((await create()).status).toBe(400);
  expect(snapshot()).toEqual(before);
});

it('compatible keyless instance creation succeeds after missing-provider repair', async () => {
  env.REALTIME_PROVIDER = 'openai'; env.REALTIME_API_KEY = ''; env.DEFAULT_LLM_API_KEY = '';
  db.exec("DELETE FROM provider_settings WHERE business_id='b1'");
  const response = await create({ ...draft, realtime_model: 'gpt-realtime', realtime_voice: 'marin' });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ state: 'draft', realtime_model: 'gpt-realtime', realtime_voice: 'marin' });
  expect(db.database.prepare("SELECT realtime_provider,realtime_api_key FROM provider_settings WHERE business_id='b1'").get())
    .toEqual({ realtime_provider: 'instance', realtime_api_key: '' });
});

it.each(['accept', 'conflict'])('missing-primary/provider repair is outside the requested create batch (%s)', async outcome => {
  db.exec("DELETE FROM provider_settings WHERE business_id='b1'; DELETE FROM assistants WHERE id='asst_b1'");
  const initialCount = count();
  const hold = holdCreate(); const pending = create();
  try {
    await hold.reached;
    expect(db.database.prepare("SELECT id FROM assistants WHERE id='asst_b1'").get()).toEqual({ id: 'asst_b1' });
    expect(count()).toBe(initialCount + 1); // Legitimate primary repair already committed.
    if (outcome === 'conflict') expect((await request('/api/me/provider', openai)).status).toBe(200);
    const afterRepair = snapshot(), repairCount = count();
    hold.release(); const response = await pending;
    if (outcome === 'conflict') {
      expect(response.status).toBe(409);
      expect(snapshot()).toEqual(afterRepair);
    } else {
      expect(response.status).toBe(201);
      const row = await response.json() as { id: string; state: string; public_slug: string };
      expect(row.state).toBe('draft'); expect(count()).toBe(repairCount + 1);
      expect(db.database.prepare('SELECT COUNT(*) AS n FROM assistant_knowledge_collections WHERE assistant_id=?').get(row.id)).toEqual({ n: 1 });
      expect((await request(`/api/public/agent/${row.public_slug}`, undefined, '')).status).toBe(404);
    }
  } finally { hold.release(); await pending; hold.restore(); }
});

it.each(['quota', 'attachment failure'])('requested create rolls back on %s', async failure => {
  expect((await request('/api/me/provider', custom)).status).toBe(200);
  const hold = holdCreate(); const pending = create();
  try {
    await hold.reached;
    if (failure === 'quota') db.exec("UPDATE rate_counters SET count=200 WHERE bucket='assistants:b1'");
    else db.hook = sql => { if (sql.includes('INSERT OR IGNORE INTO assistant_knowledge_collections')) throw new Error('synthetic attachment failure'); };
    const before = snapshot(); hold.release();
    expect((await pending).status).toBe(failure === 'quota' ? 429 : 500);
    expect(snapshot()).toEqual(before);
  } finally { hold.release(); await pending; db.hook = null; hold.restore(); }
});
