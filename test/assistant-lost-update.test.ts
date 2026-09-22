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
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES ('u1','one@example.test','hash'),('u2','two@example.test','hash');
    INSERT INTO sessions(token,user_id,expires_at) VALUES ('s1','u1','2099-01-01'),('s2','u2','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES ('b1','u1','one','One','Workshop'),('b2','u2','two','Two','Workshop');
    INSERT INTO agent_settings(business_id) VALUES ('b1'),('b2');
    INSERT INTO provider_settings(business_id) VALUES ('b1'),('b2');
    INSERT INTO assistants(id,business_id,public_slug) VALUES ('asst_b1','b1','one'),('asst_b2','b2','two');`);
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://api.kataleptic.com/v1', DEFAULT_LLM_API_KEY: 'instance-key',
    DEFAULT_LLM_MODEL: 'llama-3.3-70b', DEFAULT_STT_BASE_URL: 'https://api.kataleptic.com/v1', DEFAULT_STT_API_KEY: 'instance-stt',
    DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_MODEL: 'kataleptic-realtime-hd', REALTIME_BASE_URL: 'wss://api.kataleptic.com/v1/realtime' } as unknown as Env;
  // Establish compatibility/knowledge state before full refusal snapshots.
  expect((await request('/api/me/bootstrap')).status).toBe(200);
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });


type Writer = 'studio' | 'legacy';
function save(writer: Writer, body: Record<string, unknown>, target = 'asst_b1') {
  const fields = { ...body };
  if (writer === 'legacy' && fields.name !== undefined) { fields.agent_name = fields.name; delete fields.name; }
  return request(writer === 'studio' ? `/api/me/assistants/${target}` : '/api/me/business/b1/agent', fields);
}
const row = (id = 'asst_b1') => db.database.prepare('SELECT * FROM assistants WHERE id=?').get(id) as Record<string, unknown>;
const count = () => (db.database.prepare("SELECT count FROM rate_counters WHERE bucket='assistants:b1'").get() as { count: number }).count;
function snapshot() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
function holdWrite() {
  let entered!: () => void, release!: () => void, held = false;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  const marked = new WeakSet<object>();
  const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes('UPDATE assistants SET name=?')) marked.add(statement);
    return statement;
  });
  const batchSpy = vi.spyOn(db, 'batch').mockImplementation(async statements => {
    if (!held && marked.has(statements[0])) { held = true; entered(); await gate; }
    return batch(statements);
  });
  return { reached, release, restore() { prepareSpy.mockRestore(); batchSpy.mockRestore(); } };
}
const edits: Array<[string, unknown]> = [
  ['name', 'B name'], ['greeting', 'B greeting'], ['persona', 'B personality'], ['language', 'de'],
  ['voice', 'B voice'], ['take_messages', 0], ['custom_instructions', 'B instructions'],
  ['engine', 'realtime'], ['realtime_model', 'custom-model'], ['realtime_voice', 'custom-voice'],
  ['llm_model', 'B language model'], ['state', 'paused'],
];
for (const writer of ['studio', 'legacy'] as const) {
  it.each(edits)(`${writer} refuses a captured assistant change in %s even within one timestamp second`, async (field, value) => {
    const initial = row(); const hold = holdWrite(); const pending = save(writer, { greeting: 'A greeting' });
    try {
      await hold.reached;
      const concurrent = field === 'state'
        ? await request('/api/me/assistants/asst_b1/pause', {}, 's1', 'POST')
        : await save(writer, { [field]: value });
      expect(concurrent.status).toBe(200);
      expect(row().updated_at).toBe(initial.updated_at);
      const afterB = snapshot(), afterCount = count(); hold.release();
      expect((await pending).status).toBe(409); expect(snapshot()).toEqual(afterB);
      hold.restore(); expect((await save(writer, { greeting: 'A greeting' })).status).toBe(200);
      expect(count()).toBe(afterCount + 1);
      expect(row()[field]).toBe(field === 'greeting' ? 'A greeting' : value);
    } finally { hold.release(); await pending; hold.restore(); }
  });

  it(`${writer} compares captured values rather than a matching desired next state`, async () => {
    const hold = holdWrite(); const pending = save(writer, { greeting: 'Same next greeting' });
    try {
      await hold.reached; expect((await save(writer, { greeting: 'Same next greeting' })).status).toBe(200);
      const before = snapshot(); hold.release();
      expect((await pending).status).toBe(409); expect(snapshot()).toEqual(before);
    } finally { hold.release(); await pending; hold.restore(); }
  });

  it(`${writer} keeps normal full and no-op save semantics and one charge`, async () => {
    const initial = row(), before = count();
    expect((await save(writer, { ...initial, greeting: 'Full save' })).status).toBe(200);
    expect(count()).toBe(before + 1);
    const saved = row();
    expect((await save(writer, {})).status).toBe(200);
    expect(row()).toEqual(saved); expect(count()).toBe(before + 2);
    const mirror = db.database.prepare("SELECT * FROM agent_settings WHERE business_id='b1'").get() as Record<string, unknown>;
    const sync = db.database.prepare("SELECT agent_snapshot FROM compatibility_sync_state WHERE business_id='b1'").get() as { agent_snapshot: string };
    expect(mirror.greeting).toBe('Full save'); expect(JSON.parse(sync.agent_snapshot).greeting).toBe('Full save');
  });

  it(`${writer} retains quota and late snapshot full rollback`, async () => {
    db.exec("UPDATE rate_counters SET count=200 WHERE bucket='assistants:b1'");
    const full = snapshot(); expect((await save(writer, { greeting: 'Quota refused' })).status).toBe(429); expect(snapshot()).toEqual(full);
    db.exec("UPDATE rate_counters SET count=10 WHERE bucket='assistants:b1'");
    const before = snapshot(); db.hook = sql => { if (sql.includes('UPDATE compatibility_sync_state SET agent_snapshot=')) throw new Error('synthetic late snapshot'); };
    try { expect((await save(writer, { greeting: 'Rolled back' })).status).toBe(500); }
    finally { db.hook = null; }
    expect(snapshot()).toEqual(before);
  });
}

it.each([['studio', 'legacy'], ['legacy', 'studio']] as const)('disjoint cross-route %s then %s changes do not restore stale voice', async (first, second) => {
  const hold = holdWrite(); const pending = save(first, { greeting: 'A greeting' });
  try {
    await hold.reached; expect((await save(second, { voice: 'B voice' })).status).toBe(200);
    const before = snapshot(); hold.release();
    expect((await pending).status).toBe(409); expect(snapshot()).toEqual(before);
    hold.restore(); expect((await save(first, { greeting: 'A greeting' })).status).toBe(200);
    expect(row()).toMatchObject({ greeting: 'A greeting', voice: 'B voice' });
  } finally { hold.release(); await pending; hold.restore(); }
});

it('secondary partial conflict leaves primary mirror and snapshot intact', async () => {
  db.exec("INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language) VALUES('secondary','b1','secondary','draft','Secondary','Helpful','en')");
  const hold = holdWrite(); const pending = save('studio', { greeting: 'A greeting' }, 'secondary');
  try {
    await hold.reached; expect((await save('studio', { voice: 'B voice' }, 'secondary')).status).toBe(200);
    const before = snapshot(); hold.release();
    expect((await pending).status).toBe(409); expect(snapshot()).toEqual(before);
    hold.restore(); expect((await save('studio', { greeting: 'A greeting' }, 'secondary')).status).toBe(200);
    expect(row('secondary')).toMatchObject({ greeting: 'A greeting', voice: 'B voice', state: 'draft' });
  } finally { hold.release(); await pending; hold.restore(); }
});
