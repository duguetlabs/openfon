import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

let db: SqliteD1;
let env: Env;
async function request(path = '/api/me/bootstrap') {
  return worker.fetch(new Request('https://openfon.test' + path, { headers: { Cookie: 'ofs=s1' } }),
    env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}
beforeEach(() => {
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('u1','repair@example.invalid','unused');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('s1','u1','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('b1','u1','one','One');`);
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: 'synthetic-instance',
    DEFAULT_LLM_MODEL: 'instance-model', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: 'synthetic-instance-stt',
    DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime' } as unknown as Env;
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });
function seedProvider() {
  db.exec(`INSERT INTO provider_settings(business_id,llm_base_url,llm_api_key,llm_model,realtime_provider,
    realtime_base_url,realtime_api_key,stt_provider,stt_base_url,stt_api_key,stt_model,updated_at)
    VALUES('b1','https://text.example/v1','synthetic-text','custom-text','custom','wss://speech.example/realtime',
    'synthetic-realtime','custom','https://stt.example/v1','synthetic-stt','custom-stt','2001-01-01');`);
}
function provider() { return db.database.prepare("SELECT * FROM provider_settings WHERE business_id='b1'").get(); }
function state() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
function privateRepair() {
  expect(db.database.prepare("SELECT agent_name,persona,language FROM agent_settings WHERE business_id='b1'").get())
    .toEqual({ agent_name: '', persona: '', language: '' });
  expect(db.database.prepare("SELECT state,activated_at,name,persona,language FROM assistants WHERE id='asst_b1'").get())
    .toEqual({ state: 'draft', activated_at: null, name: '', persona: '', language: '' });
}

it('both-missing repair preserves the entire surviving provider and stays private/idempotent', async () => {
  seedProvider(); const before = provider();
  expect((await request()).status).toBe(200);
  expect(provider()).toEqual(before);
  expect(db.database.prepare("SELECT llm_base_url,llm_api_key FROM agent_settings WHERE business_id='b1'").get())
    .toEqual({ llm_base_url: 'https://text.example/v1', llm_api_key: 'synthetic-text' });
  privateRepair();
  const repaired = state(); expect((await request()).status).toBe(200);
  expect(state()).toEqual(repaired);
  expect((await request('/api/public/agent/one')).status).toBe(404);
});

it('both-missing repair retains the absent-provider instance fallback', async () => {
  expect((await request()).status).toBe(200);
  expect(provider()).toMatchObject({ llm_base_url: '', llm_api_key: '', realtime_provider: 'instance', realtime_api_key: '',
    stt_provider: 'instance', stt_api_key: '' });
  privateRepair();
});

function holdLegacyInsert() {
  let entered!: () => void, release!: () => void, held = false;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes('INSERT OR IGNORE INTO agent_settings')) {
      const run = statement.run.bind(statement);
      statement.run = async () => { if (!held) { held = true; entered(); await gate; } return run(); };
    }
    return statement;
  });
  return { reached, release, restore() { spy.mockRestore(); } };
}

it.each(['rotation', 'created after read'] as const)('repair selects provider credentials at SQL execution (%s)', async change => {
  if (change === 'rotation') seedProvider();
  const hold = holdLegacyInsert(); const pending = request();
  try {
    await hold.reached;
    if (change === 'created after read') seedProvider();
    db.exec("UPDATE provider_settings SET llm_base_url='https://rotated.example/v1',llm_api_key='synthetic-rotated' WHERE business_id='b1'");
    const winning = provider();
    hold.release(); expect((await pending).status).toBe(200);
    // Reconciliation may stamp updated_at when its initial provider read was stale.
    expect(provider()).toEqual({ ...winning, updated_at: expect.any(String) });
    expect(db.database.prepare("SELECT llm_base_url,llm_api_key FROM agent_settings WHERE business_id='b1'").get())
      .toEqual({ llm_base_url: 'https://rotated.example/v1', llm_api_key: 'synthetic-rotated' });
    privateRepair();
  } finally { hold.release(); await pending; hold.restore(); }
});

it('INSERT OR IGNORE retains a winning concurrent legacy repair and rereads it', async () => {
  seedProvider(); const hold = holdLegacyInsert(); const pending = request();
  try {
    await hold.reached;
    db.exec(`INSERT INTO agent_settings(business_id,agent_name,persona,language,greeting,llm_base_url,llm_api_key)
      VALUES('b1','','','','Winning repair','https://text.example/v1','synthetic-text');`);
    const winning = db.database.prepare("SELECT * FROM agent_settings WHERE business_id='b1'").get();
    const beforeProvider = provider();
    hold.release(); expect((await pending).status).toBe(200);
    expect(db.database.prepare("SELECT * FROM agent_settings WHERE business_id='b1'").get()).toEqual(winning);
    expect(provider()).toEqual(beforeProvider);
    expect(db.database.prepare("SELECT greeting FROM assistants WHERE id='asst_b1'").get()).toEqual({ greeting: 'Winning repair' });
    privateRepair();
  } finally { hold.release(); await pending; hold.restore(); }
});

it('post-migration old blank onboarding cannot change credentials and current repair restores its default provider', async () => {
  // Exact old eb13a193 onboarding INSERT; it never accepts a credential payload.
  db.exec("INSERT INTO agent_settings (business_id) VALUES ('b1')");
  const before = state();
  expect(() => db.exec("UPDATE agent_settings SET llm_api_key='synthetic-old-change' WHERE business_id='b1'"))
    .toThrow('OPENFON_PROVIDER_CREDENTIAL_WRITE_REQUIRES_CURRENT_WORKER');
  expect(state()).toEqual(before);
  expect((await request()).status).toBe(200);
  expect(provider()).toMatchObject({ llm_base_url: '', llm_api_key: '', realtime_provider: 'instance' });
  expect(db.database.prepare("SELECT agent_name,persona,language FROM agent_settings WHERE business_id='b1'").get())
    .toEqual({ agent_name: 'Alex', persona: 'friendly and professional', language: 'en' });
});
