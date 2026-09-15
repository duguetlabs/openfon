import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

let db: SqliteD1;
let env: Env;
async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return worker.fetch(new Request(`https://openfon.test${path}`, {
    method, headers: { Cookie: 'ofs=s1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES ('u1','state@example.test','hash');
    INSERT INTO sessions(token,user_id,expires_at) VALUES ('s1','u1','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES ('b1','u1','one','One','Workshop');
    INSERT INTO agent_settings(business_id) VALUES ('b1');
    INSERT INTO provider_settings(business_id) VALUES ('b1');
    INSERT INTO assistants(id,business_id,public_slug) VALUES ('asst_b1','b1','one');`);
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://api.kataleptic.com/v1', DEFAULT_LLM_API_KEY: '',
    DEFAULT_LLM_MODEL: 'llama-3.3-70b', DEFAULT_STT_BASE_URL: 'https://api.kataleptic.com/v1', DEFAULT_STT_API_KEY: '',
    DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_MODEL: 'kataleptic-realtime',
    REALTIME_BASE_URL: 'wss://api.kataleptic.com/v1/realtime' } as unknown as Env;
  expect((await request('/api/me/bootstrap')).status).toBe(200);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); vi.useRealTimers(); });
const activate = () => request('/api/me/assistants/candidate/activate', {});
const pause = () => request('/api/me/assistants/candidate/pause', {});
const row = () => db.database.prepare("SELECT * FROM assistants WHERE id='candidate'").get() as Record<string, unknown>;
const count = () => (db.database.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:b1'").get() as { count: number }).count;
function candidate(state: 'draft' | 'paused' | 'active' = 'draft') {
  db.database.prepare(`INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language,engine,activated_at)
    VALUES ('candidate','b1','candidate',?,'Candidate','Helpful','en','pipeline',?)`).run(state, state === 'draft' ? null : '2026-09-13 09:00:00');
}
function snapshot() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
function holdFirstActivation() {
  let enter!: () => void, release!: () => void, held = false;
  const reached = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes("UPDATE assistants SET state='active', activated_at=")) {
      const first = statement.first.bind(statement);
      statement.first = async <T>() => {
        if (!held) { held = true; enter(); await gate; }
        return first<T>();
      };
    }
    return statement;
  });
  return { reached, release, restore: () => spy.mockRestore() };
}

it.each(['draft', 'active'] as const)('activation refuses a committed pause from captured %s within the same second', async initial => {
  candidate(initial); const timestamp = row().updated_at;
  const hold = holdFirstActivation(), pending = activate();
  try {
    await hold.reached; expect((await pause()).status).toBe(200);
    expect(row().state).toBe('paused'); expect(row().updated_at).toBe(timestamp);
    const afterPause = snapshot(), spent = count(); hold.release();
    const response = await pending;
    console.log('activation-state-diagnostic', JSON.stringify({ initial, response: response.status, beforeState: 'paused', afterState: row().state, extraCharges: count() - spent }));
    expect(response.status).toBe(409); expect(snapshot()).toEqual(afterPause);
    expect((await request('/api/public/agent/candidate')).status).toBe(404);
    hold.restore(); expect((await activate()).status).toBe(200); expect(row().state).toBe('active'); expect(count()).toBe(spent + 1);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('two activations captured from paused allow the winner and conflict the stale state', async () => {
  candidate('paused'); const hold = holdFirstActivation(), pending = activate();
  try {
    await hold.reached; expect((await activate()).status).toBe(200);
    const afterWinner = snapshot(), spent = count(); hold.release();
    expect((await pending).status).toBe(409); expect(snapshot()).toEqual(afterWinner); expect(count()).toBe(spent);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('changed-state conflict bypasses activation trigger even when pause spends the final quota unit', async () => {
  candidate('active'); db.exec("UPDATE rate_counters SET count=199 WHERE bucket='assistants:b1'");
  const hold = holdFirstActivation(), pending = activate();
  try {
    await hold.reached; expect((await pause()).status).toBe(200); expect(count()).toBe(200);
    const afterPause = snapshot(); hold.release();
    expect((await pending).status).toBe(409); expect(snapshot()).toEqual(afterPause);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('same-state pause is outside the value-equality conflict guarantee', async () => {
  candidate('paused'); const hold = holdFirstActivation(), pending = activate();
  try {
    await hold.reached; expect((await pause()).status).toBe(200); const spent = count(); hold.release();
    expect((await pending).status).toBe(200); expect(row().state).toBe('active'); expect(count()).toBe(spent + 1);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('state ABA remains outside the equality guarantee', async () => {
  candidate('active'); const hold = holdFirstActivation(), pending = activate();
  try {
    await hold.reached; expect((await pause()).status).toBe(200); expect((await activate()).status).toBe(200);
    const spent = count(); hold.release(); expect((await pending).status).toBe(200); expect(count()).toBe(spent + 1);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('valid current essentials and greeting remain publishable without full-snapshot CAS', async () => {
  candidate(); const hold = holdFirstActivation(), pending = activate();
  try {
    await hold.reached;
    expect((await request('/api/me/assistants/candidate', { name: 'New name', persona: 'New personality', language: 'de', greeting: 'New greeting' }, 'PUT')).status).toBe(200);
    const edited = row(), spent = count(); hold.release(); expect((await pending).status).toBe(200);
    expect(row()).toMatchObject({ name: edited.name, persona: edited.persona, language: edited.language, greeting: edited.greeting, state: 'active' });
    expect(count()).toBe(spent + 1);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('already-active activation retains its timestamp and one accepted charge', async () => {
  candidate('active'); const timestamp = row().activated_at, spent = count();
  expect((await activate()).status).toBe(200); expect(row().activated_at).toBe(timestamp); expect(count()).toBe(spent + 1);
});

it('current Unicode-blank essentials still refuse after an initially valid precheck', async () => {
  candidate(); const hold = holdFirstActivation(), pending = activate();
  try {
    await hold.reached; db.database.prepare("UPDATE assistants SET persona=? WHERE id='candidate'").run('\u00a0\u2003\ufeff');
    const before = snapshot(); hold.release(); expect((await pending).status).toBe(409); expect(snapshot()).toEqual(before);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('accepted-state activation still rolls back atomically at exhausted quota', async () => {
  candidate('paused'); db.exec("UPDATE rate_counters SET count=200 WHERE bucket='assistants:b1'");
  const before = snapshot(); expect((await activate()).status).toBe(429); expect(snapshot()).toEqual(before);
});
