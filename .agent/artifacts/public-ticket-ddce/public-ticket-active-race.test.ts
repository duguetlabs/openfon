import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

let db: SqliteD1;
let env: Env;
let dispatches: number;
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const request = (path: string, init: RequestInit = {}) => worker.fetch(
  new Request(`https://openfon.test${path}`, init), env, context
);
const start = () => request('/api/public/call/start', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'target-link' }),
});
const calls = () => db.database.prepare('SELECT * FROM calls ORDER BY id').all();
function snapshot() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
beforeEach(async () => {
  db = new SqliteD1(); applyMigrations(db); dispatches = 0;
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES ('u','ticket@example.invalid','hash');
    INSERT INTO sessions(token,user_id,expires_at) VALUES ('s','u','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name) VALUES ('b','u','workspace','Workspace');
    INSERT INTO agent_settings(business_id) VALUES ('b');
    INSERT INTO provider_settings(business_id) VALUES ('b');
    INSERT INTO assistants(id,business_id,public_slug) VALUES ('asst_b','b','workspace');`);
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://text.example/v1', DEFAULT_LLM_MODEL: 'model',
    DEFAULT_LLM_API_KEY: 'synthetic', DEFAULT_STT_BASE_URL: 'https://text.example/v1', DEFAULT_STT_MODEL: 'whisper-1',
    DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://realtime.example/v1',
    CALL_SESSION: { idFromName: (id: string) => id, get: () => ({ fetch: async () => { dispatches++; return new Response(null); } }) },
  } as unknown as Env;
  expect((await request('/api/me/bootstrap', { headers: { Cookie: 'ofs=s' } })).status).toBe(200);
  db.exec(`INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language)
    VALUES ('target','b','target-link','active','Target','Helpful','en');`);
});
afterEach(() => db.close());

function beforeInsert(change: () => void) {
  let reached = false;
  let before: ReturnType<typeof snapshot> | undefined;
  db.hook = sql => {
    if (!reached && sql.startsWith('INSERT INTO calls')) {
      reached = true; change(); before = snapshot();
    }
  };
  return { reached: () => reached, snapshot: () => before };
}
function changeTarget(change: string) {
  if (change === 'deleted') db.exec("DELETE FROM assistants WHERE id='target'");
  else db.database.prepare('UPDATE assistants SET state=? WHERE id=?').run(change, 'target');
}

it.each(['paused', 'draft', 'deleted'])('[ticket-race-negative] refuses a target changed before INSERT: %s', async change => {
  const boundary = beforeInsert(() => changeTarget(change));
  const response = await start();
  // Preserve attribution before the first intended old-source failure. Deletion
  // can produce FK500; it is not claimed to insert a successful ticket.
  console.log('ticket-race-diagnostic', JSON.stringify({ change, status: response.status,
    reached: boundary.reached(), calls: calls().map(row => ({ id: row.id, assistant_id: row.assistant_id })), dispatches }));
  expect(response.status).toBe(404);
  expect(boundary.reached()).toBe(true);
  expect(await response.json()).toEqual({ error: 'Unknown or unavailable assistant' });
  expect(calls()).toHaveLength(0);
  expect(snapshot()).toEqual(boundary.snapshot());
  expect(dispatches).toBe(0);
});

it.each(['paused', 'draft', 'deleted'])('refuses an initially unavailable target: %s', async change => {
  changeTarget(change);
  expect((await start()).status).toBe(404);
  expect(calls()).toHaveLength(0);
  expect(dispatches).toBe(0);
});

it('creates one active claim-aware live ticket without dispatching a session', async () => {
  const response = await start();
  expect(response.status).toBe(200);
  const body = await response.json() as { callId: string };
  expect(calls()).toHaveLength(1);
  expect(calls()[0]).toMatchObject({ id: body.callId, business_id: 'b', assistant_id: 'target',
    channel: 'web', environment: 'live', browser_claim_required: 1, connected_at: null });
  expect(dispatches).toBe(0);
});

it('retains exhausted-day429 and performs no ticket write', async () => {
  db.exec("UPDATE businesses SET max_calls_per_day=1 WHERE id='b'; INSERT INTO calls(id,business_id,assistant_id) VALUES ('prior','b','target')");
  const boundary = beforeInsert(() => {});
  const response = await start();
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('3600');
  expect(await response.json()).toEqual({ error: expect.stringContaining('daily call limit') });
  expect(boundary.reached()).toBe(true);
  expect(snapshot()).toEqual(boundary.snapshot());
  expect(calls()).toHaveLength(1);
});

it('permits a name edit while the selected target remains active', async () => {
  const boundary = beforeInsert(() => db.exec("UPDATE assistants SET name='Updated name' WHERE id='target'"));
  expect((await start()).status).toBe(200);
  expect(boundary.reached()).toBe(true);
  expect(calls()).toHaveLength(1);
  expect(db.database.prepare("SELECT name FROM assistants WHERE id='target'").get()).toEqual({ name: 'Updated name' });
});

it('retains WebSocket refusal when pause follows successful insertion', async () => {
  const response = await start(); expect(response.status).toBe(200);
  const { callId } = await response.json() as { callId: string };
  changeTarget('paused');
  expect((await request(`/ws/call/${callId}`, { headers: { Upgrade: 'websocket' } })).status).toBe(409);
  expect(calls()[0]).toMatchObject({ id: callId, connected_at: null });
  expect(dispatches).toBe(0);
});
