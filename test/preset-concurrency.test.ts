import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

let db: SqliteD1;
let env: Env;
type Route = 'studio' | 'legacy';
async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'PUT') {
  return worker.fetch(new Request(`https://openfon.test${path}`, {
    method, headers: { Cookie: 'ofs=s1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}
const path = (route: Route) => route === 'studio' ? '/api/me/engine-presets/preset' : '/api/me/profiles/preset';
const save = (route: Route, body: Record<string, unknown>) => request(path(route), body);
const apply = (route: Route, id = 'asst_b1') => request(path(route) + '/apply', { assistantId: id }, 'POST');
const remove = (route: Route) => request(path(route), undefined, 'DELETE');
const fields = ['engine', 'realtime_model', 'realtime_voice', 'language', 'voice', 'llm_model'] as const;
const changes: Array<[string, string]> = [
  ['name', 'B name'], ['engine', 'pipeline'], ['realtime_model', 'custom-model'],
  ['realtime_voice', 'custom-voice'], ['language', 'de'], ['voice', 'B voice'], ['llm_model', 'B model'],
];
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES ('u1','one@example.test','hash');
    INSERT INTO sessions(token,user_id,expires_at) VALUES ('s1','u1','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES ('b1','u1','one','One','Workshop');
    INSERT INTO agent_settings(business_id) VALUES ('b1');
    INSERT INTO provider_settings(business_id) VALUES ('b1');
    INSERT INTO assistants(id,business_id,public_slug) VALUES ('asst_b1','b1','one');
    INSERT INTO engine_profiles(id,business_id,name,engine,language) VALUES ('preset','b1','Original','realtime','en');
    INSERT INTO engine_presets(id,business_id,name,engine,language) VALUES ('preset','b1','Original','realtime','en');`);
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: 'synthetic-key',
    DEFAULT_LLM_MODEL: 'model', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_API_KEY: 'synthetic-stt',
    DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_MODEL: 'kataleptic-realtime-hd',
    REALTIME_BASE_URL: 'wss://instance.example/realtime', REALTIME_API_KEY: 'synthetic-realtime' } as unknown as Env;
  expect((await request('/api/me/bootstrap')).status).toBe(200);
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

function snapshot() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
const row = (table: string, id = 'preset') => db.database.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown>;
const count = (bucket = 'presets') => (db.database.prepare('SELECT count FROM rate_counters WHERE bucket=?').get(`${bucket}:b1`) as { count: number }).count;
function holdWrite(kind: 'save' | 'apply') {
  let entered!: () => void, release!: () => void, held = false;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db), marked = new WeakSet<object>();
  const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    if (kind === 'save' ? /UPDATE engine_(presets|profiles) SET name=/.test(sql) : sql.includes('UPDATE assistants SET engine=?')) marked.add(statement);
    return statement;
  });
  const batchSpy = vi.spyOn(db, 'batch').mockImplementation(async statements => {
    if (!held && marked.has(statements[0])) { held = true; entered(); await gate; }
    return batch(statements);
  });
  return { reached, release, restore() { prepareSpy.mockRestore(); batchSpy.mockRestore(); } };
}

for (const route of ['studio', 'legacy'] as const) {
  const source = route === 'studio' ? 'engine_presets' : 'engine_profiles';
  const mirror = route === 'studio' ? 'engine_profiles' : 'engine_presets';
  it.each(changes)(`${route} partial save conflicts on captured %s within the same second`, async (field, value) => {
    const timestamp = row('engine_presets').updated_at;
    const hold = holdWrite('save'), pending = save(route, { name: 'A name' });
    try {
      await hold.reached; expect((await save(route, { [field]: value })).status).toBe(200);
      expect(row('engine_presets').updated_at).toBe(timestamp);
      const afterB = snapshot(), beforeCount = count(); hold.release();
      expect((await pending).status).toBe(409); expect(snapshot()).toEqual(afterB);
      hold.restore(); expect((await save(route, { name: 'A name' })).status).toBe(200);
      for (const table of [source, mirror]) expect(row(table)[field]).toBe(field === 'name' ? 'A name' : value);
      expect(count()).toBe(beforeCount + 2);
    } finally { hold.release(); await pending; hold.restore(); }
  });

  it(`${route} save conflicts when source is deleted after its read`, async () => {
    const hold = holdWrite('save'), pending = save(route, { name: 'A name' });
    try {
      await hold.reached; expect((await remove(route)).status).toBe(200);
      const before = snapshot(); hold.release(); expect((await pending).status).toBe(409); expect(snapshot()).toEqual(before);
    } finally { hold.release(); await pending; hold.restore(); }
  });

  it(`${route} save compares original values even when another writer installs the same desired name`, async () => {
    const hold = holdWrite('save'), pending = save(route, { name: 'Same next' });
    try {
      await hold.reached; expect((await save(route, { name: 'Same next' })).status).toBe(200);
      const before = snapshot(); hold.release(); expect((await pending).status).toBe(409); expect(snapshot()).toEqual(before);
    } finally { hold.release(); await pending; hold.restore(); }
  });

  it(`${route} save retains missing mirror success with one charge and no reconstruction`, async () => {
    db.exec(`DELETE FROM ${mirror} WHERE id='preset'`); const before = count();
    expect((await save(route, { name: 'Only source' })).status).toBe(200);
    expect(row(source).name).toBe('Only source'); expect(row(mirror)).toBeUndefined(); expect(count()).toBe(before + 1);
  });

  it(`${route} full and no-op saves retain engine, Unicode and two-row charges`, async () => {
    const before = count(); const initial = row(source);
    expect((await save(route, { ...initial, name: 'Grüß dich 👋', voice: 'chosen' })).status).toBe(200);
    expect((await save(route, {})).status).toBe(200);
    for (const table of [source, mirror]) expect(row(table)).toMatchObject({ name: 'Grüß dich 👋', voice: 'chosen', engine: 'realtime' });
    expect(row('engine_profiles')).toMatchObject({ llm_base_url: '', llm_api_key: '' });
    expect(count()).toBe(before + 4);
  });

  it(`${route} save retains quota and late mirror full rollback`, async () => {
    db.exec("UPDATE rate_counters SET count=400 WHERE bucket='presets:b1'");
    const full = snapshot(); expect((await save(route, { name: 'Refused' })).status).toBe(429); expect(snapshot()).toEqual(full);
    db.exec("UPDATE rate_counters SET count=10 WHERE bucket='presets:b1'"); const before = snapshot();
    db.hook = sql => { if (sql.includes(`UPDATE ${mirror} SET name=`)) throw new Error('synthetic late mirror'); };
    try { expect((await save(route, { name: 'Rolled back' })).status).toBe(500); }
    finally { db.hook = null; }
    expect(snapshot()).toEqual(before);
  });

  it.each(changes.filter(([field]) => field !== 'name'))(`${route} Apply conflicts on source behavior edit %s`, async (field, value) => {
    const hold = holdWrite('apply'), pending = apply(route);
    try {
      await hold.reached; expect((await save(route, { [field]: value })).status).toBe(200);
      const before = snapshot(), beforeCount = count('assistants'); hold.release();
      expect((await pending).status).toBe(409); expect(snapshot()).toEqual(before);
      hold.restore(); expect((await apply(route)).status).toBe(200);
      expect(row('assistants', 'asst_b1')[field]).toBe(value); expect(count('assistants')).toBe(beforeCount + 1);
    } finally { hold.release(); await pending; hold.restore(); }
  });

  it(`${route} Apply conflicts on deleted source without touching assistant or quota`, async () => {
    const hold = holdWrite('apply'), pending = apply(route);
    try {
      await hold.reached; expect((await remove(route)).status).toBe(200);
      const before = snapshot(); hold.release(); expect((await pending).status).toBe(409); expect(snapshot()).toEqual(before);
    } finally { hold.release(); await pending; hold.restore(); }
  });

  it(`${route} Apply accepts name-only source rename and intentional target replacement`, async () => {
    const selected = row(source), hold = holdWrite('apply'), pending = apply(route);
    try {
      await hold.reached; expect((await save(route, { name: 'Renamed' })).status).toBe(200);
      expect((await request('/api/me/assistants/asst_b1', { voice: 'Target newer voice', greeting: 'Target newer greeting' })).status).toBe(200);
      const beforeCount = count('assistants'); hold.release(); expect((await pending).status).toBe(200);
      const target = row('assistants', 'asst_b1');
      for (const field of fields) expect(target[field]).toBe(selected[field]);
      expect(target.greeting).toBe('Target newer greeting'); expect(count('assistants')).toBe(beforeCount + 1);
      expect(row(source).name).toBe('Renamed');
    } finally { hold.release(); await pending; hold.restore(); }
  });

  it(`${route} Apply retains quota and late snapshot full rollback`, async () => {
    db.exec("UPDATE rate_counters SET count=200 WHERE bucket='assistants:b1'");
    const full = snapshot(); expect((await apply(route)).status).toBe(429); expect(snapshot()).toEqual(full);
    db.exec("UPDATE rate_counters SET count=10 WHERE bucket='assistants:b1'"); const before = snapshot();
    db.hook = sql => { if (sql.includes('UPDATE compatibility_sync_state SET agent_snapshot=')) throw new Error('synthetic late snapshot'); };
    try { expect((await apply(route)).status).toBe(500); }
    finally { db.hook = null; }
    expect(snapshot()).toEqual(before);
  });
}

it.each([['studio', 'legacy'], ['legacy', 'studio']] as const)('partial save %s conflicts with %s disjoint accepted edit', async (first, second) => {
  const hold = holdWrite('save'), pending = save(first, { name: 'A name' });
  try {
    await hold.reached; expect((await save(second, { voice: 'B voice' })).status).toBe(200);
    const before = snapshot(); hold.release(); expect((await pending).status).toBe(409); expect(snapshot()).toEqual(before);
  } finally { hold.release(); await pending; hold.restore(); }
});

it.each(['source-edit', 'target-delete'])('secondary Apply %s refuses atomically and leaves primary mirrors intact', async change => {
  db.exec("INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language) VALUES('secondary','b1','secondary','draft','Secondary','Helpful','en')");
  const hold = holdWrite('apply'), pending = apply('studio', 'secondary');
  try {
    await hold.reached;
    const competing = change === 'source-edit' ? await save('legacy', { voice: 'B voice' })
      : await request('/api/me/assistants/secondary', undefined, 'DELETE');
    expect(competing.status).toBe(200); const before = snapshot(); hold.release();
    expect((await pending).status).toBe(409); expect(snapshot()).toEqual(before);
  } finally { hold.release(); await pending; hold.restore(); }
});
