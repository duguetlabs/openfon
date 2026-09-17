import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';
import { fakeEnv, fakeCtx } from './fake-d1';

let db: SqliteD1;
let env: Env;
type Kind = 'item' | 'collection';
const path = (kind: Kind) => `/api/me/knowledge/${kind === 'item' ? 'items/item' : 'collections/one'}`;
const table = (kind: Kind) => kind === 'item' ? 'knowledge_items' : 'knowledge_collections';
async function request(url: string, body?: unknown, method = body === undefined ? 'GET' : 'PUT') {
  return worker.fetch(new Request(`https://openfon.test${url}`, {
    method, headers: { Cookie: 'ofs=session', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, fakeCtx);
}
const save = (kind: Kind, body: Record<string, unknown>) => request(path(kind), body);
const row = (kind: Kind) => db.database.prepare(`SELECT * FROM ${table(kind)} WHERE id=?`).get(kind === 'item' ? 'item' : 'one') as Record<string, unknown>;
const count = (kind: Kind) => (db.database.prepare('SELECT count FROM rate_counters WHERE bucket=?')
  .get(`${kind === 'item' ? 'knowledge' : 'knowledge-collections'}:biz`) as { count: number }).count;
function snapshot() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}

beforeEach(async () => {
  // Same-second changes must conflict even though updated_at does not change.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
  db = new SqliteD1(); applyMigrations(db, 1, 20);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','biz','Business');
    INSERT INTO knowledge_collections(id,business_id,name,description) VALUES('one','biz','One','Original description'),('two','biz','Two','');
    INSERT INTO knowledge_items(id,business_id,collection_id,kind,status,title,question,answer,content)
      VALUES('item','biz','one','note','draft','Original title','Original question','Original answer','Original content');`);
  env = { ...fakeEnv(undefined as never), DB: db as unknown as D1Database };
  expect((await request('/api/me/bootstrap')).status).toBe(200);
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

// Hold exactly the requested UPDATE after reads/preflight, before any batch BEGIN.
// bind mutates and returns the same adapter statement, so the run spy survives it.
function holdWrite(kind: Kind, operation: 'UPDATE' | 'DELETE' = 'UPDATE') {
  let entered!: () => void, release!: () => void, held = false;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const targets = new WeakSet<object>();
  const holdOnce = async () => { if (!held) { held = true; entered(); await gate; } };
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.startsWith(operation === 'UPDATE' ? `UPDATE ${table(kind)} SET` : `DELETE FROM ${table(kind)} WHERE`)) {
      if (kind === 'item') targets.add(statement);
      const run = statement.run.bind(statement);
      vi.spyOn(statement, 'run').mockImplementation(async () => {
        await holdOnce();
        return run();
      });
    }
    return statement;
  });
  const batchSpy = vi.spyOn(db, 'batch').mockImplementation(async statements => {
    if (statements.some(statement => targets.has(statement))) await holdOnce();
    return batch(statements);
  });
  return { reached, release, restore() { spy.mockRestore(); batchSpy.mockRestore(); } };
}

const itemChanges = [
  ['collection_id', 'two'], ['kind', 'faq'], ['status', 'active'], ['title', 'B title'],
  ['question', 'B question'], ['answer', 'B answer'], ['content', 'B content'],
] as const;
it.each(itemChanges)('item deletion preserves a concurrent %s edit and allows a fresh retry', async (field, value) => {
  const timestamp = row('item').updated_at;
  const hold = holdWrite('item', 'DELETE');
  const pending = request(path('item'), undefined, 'DELETE');
  try {
    await hold.reached;
    expect((await save('item', { [field]: value })).status).toBe(200);
    expect(row('item').updated_at).toBe(timestamp);
    const afterEdit = snapshot();
    hold.release();
    expect((await pending).status).toBe(409);
    expect(snapshot()).toEqual(afterEdit);
    hold.restore();
    expect((await request(path('item'), undefined, 'DELETE')).status).toBe(200);
    expect(row('item')).toBeUndefined();
  } finally { hold.release(); await pending; hold.restore(); }
});

for (const kind of ['item', 'collection'] as const) {
  const changes = kind === 'item' ? itemChanges : [['name', 'B name'], ['description', 'B description']] as const;
  const ownField = kind === 'item' ? 'title' : 'name';
  it.each(changes)(`${kind} conflicts on captured %s in the same second and fresh retry charges once`, async (field, value) => {
    const timestamp = row(kind).updated_at, hold = holdWrite(kind), pending = save(kind, { [ownField]: 'A edit' });
    try {
      await hold.reached; expect((await save(kind, { [field]: value })).status).toBe(200);
      expect(row(kind).updated_at).toBe(timestamp);
      const afterB = snapshot(), beforeCount = count(kind); hold.release();
      expect((await pending).status).toBe(409); expect(snapshot()).toEqual(afterB);
      hold.restore(); expect((await save(kind, { [ownField]: 'A edit' })).status).toBe(200);
      expect(row(kind)[field]).toBe(field === ownField ? 'A edit' : value);
      expect(count(kind)).toBe(beforeCount + 1);
    } finally { hold.release(); await pending; hold.restore(); }
  });
  it(`${kind} deletion after capture conflicts with no quota or persisted side effects`, async () => {
    const hold = holdWrite(kind), pending = save(kind, { [ownField]: 'A edit' });
    try {
      await hold.reached; expect((await request(path(kind), undefined, 'DELETE')).status).toBe(200);
      const afterB = snapshot(); hold.release(); expect((await pending).status).toBe(409); expect(snapshot()).toEqual(afterB);
    } finally { hold.release(); await pending; hold.restore(); }
  });
  it(`${kind} conflicts even when B installs A's desired value`, async () => {
    const next = { [ownField]: 'Same desired' }, hold = holdWrite(kind), pending = save(kind, next);
    try {
      await hold.reached; expect((await save(kind, next)).status).toBe(200);
      const afterB = snapshot(); hold.release(); expect((await pending).status).toBe(409); expect(snapshot()).toEqual(afterB);
    } finally { hold.release(); await pending; hold.restore(); }
  });
  it(`${kind} ordinary partial and no-op saves preserve response and charge once each`, async () => {
    const before = count(kind), response = await save(kind, { [ownField]: '  Grüß dich 👋  ' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(kind === 'item' ? { id: 'item', title: 'Grüß dich 👋' } : { ok: true });
    expect((await save(kind, {})).status).toBe(200); expect(count(kind)).toBe(before + 2);
    expect(row(kind)[ownField]).toBe('Grüß dich 👋');
  });
  it(`${kind} spent quota rejects the single statement atomically`, async () => {
    db.database.prepare('UPDATE rate_counters SET count=? WHERE bucket=?')
      .run(kind === 'item' ? 500 : 100, `${kind === 'item' ? 'knowledge' : 'knowledge-collections'}:biz`);
    const before = snapshot(); expect((await save(kind, { [ownField]: 'Refused' })).status).toBe(429); expect(snapshot()).toEqual(before);
  });
}

it('activation conflicts if content becomes incomplete after readiness validation', async () => {
  const hold = holdWrite('item'), pending = save('item', { status: 'active' });
  try {
    await hold.reached; expect((await save('item', { content: '' })).status).toBe(200);
    const afterB = snapshot(); hold.release(); expect((await pending).status).toBe(409); expect(snapshot()).toEqual(afterB);
    hold.restore(); expect((await save('item', { status: 'active' })).status).toBe(400); expect(snapshot()).toEqual(afterB);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('retains activation timestamp through active edits and clears it on draft transition', async () => {
  expect((await save('item', { status: 'active' })).status).toBe(200);
  const activated = row('item').activated_at; expect(activated).toBeTruthy();
  vi.setSystemTime(new Date('2026-09-14T12:01:00Z'));
  expect((await save('item', { title: 'Active edit' })).status).toBe(200); expect(row('item').activated_at).toBe(activated);
  expect((await save('item', { status: 'draft' })).status).toBe(200); expect(row('item').activated_at).toBeNull();
});

it('retains same-workspace moves, ownership refusals and duplicate-name preflight', async () => {
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('other','other@example.invalid','unused');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('other','other','other','Other');
    INSERT INTO knowledge_collections(id,business_id,name) VALUES('other','other','Other');`);
  expect((await save('item', { collection_id: 'two' })).status).toBe(200);
  expect(row('item').collection_id).toBe('two'); const before = snapshot();
  expect((await save('item', { collection_id: 'other' })).status).toBe(404);
  expect((await request('/api/me/knowledge/collections/other', { name: 'Forbidden' })).status).toBe(404);
  expect((await save('collection', { name: 'Two' })).status).toBe(409); expect(snapshot()).toEqual(before);
});

it('SQL-time activated_at metadata remains current without an unrelated timestamp CAS', async () => {
  expect((await save('item', { status: 'active' })).status).toBe(200);
  const hold = holdWrite('item'), pending = save('item', { title: 'A title' });
  try {
    await hold.reached;
    // Synthetic metadata-only writer: none of the seven captured fields changed.
    db.exec("UPDATE knowledge_items SET activated_at='2026-09-13 10:00:00' WHERE id='item'");
    const before = count('item'); hold.release(); expect((await pending).status).toBe(200);
    expect(row('item').activated_at).toBe('2026-09-13 10:00:00'); expect(count('item')).toBe(before + 1);
  } finally { hold.release(); await pending; hold.restore(); }
});
