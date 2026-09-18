import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';
import { fakeEnv, fakeCtx } from './fake-d1';

let db: SqliteD1;
let env: Env;
async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'PUT', token = 'session') {
  return worker.fetch(new Request(`https://openfon.test${path}`, {
    method, headers: { Cookie: `ofs=${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, fakeCtx);
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
  db = new SqliteD1(); applyMigrations(db, 1, 20);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'),('other','other@example.invalid','unused'),('empty','empty@example.invalid','unused');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01'),('empty-session','empty','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','biz','Business'),('other','other','other','Other');
    INSERT INTO knowledge_collections(id,business_id,name) VALUES('one','biz','One'),('two','biz','Two'),('foreign','other','Foreign');
    INSERT INTO knowledge_items(id,business_id,collection_id,kind,status,title,question,answer,content)
      VALUES('item','biz','one','note','draft','Original title','Question','Answer','Original content');`);
  env = { ...fakeEnv(undefined as never), DB: db as unknown as D1Database };
  expect((await request('/api/me/bootstrap')).status).toBe(200);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); vi.useRealTimers(); });
function snapshot() {
  const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
const item = () => db.database.prepare("SELECT * FROM knowledge_items WHERE id='item'").get() as Record<string, unknown>;
const charges = () => (db.database.prepare("SELECT count FROM rate_counters WHERE bucket='knowledge:biz'").get() as { count: number }).count;

type CursorRoute = 'detail' | 'items' | 'calls';
function cursorPath(route: CursorRoute, raw?: string) {
  const path = route === 'calls' ? '/api/me/calls?limit=10' : `/api/me/knowledge/collections/one${route === 'items' ? '/items' : ''}`;
  return raw === undefined ? path : `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(raw)}`;
}
function cursorAtLength(route: CursorRoute, length: number) {
  // ASCII JSON with byte length divisible by three gives exact unpadded base64 size.
  const position = route === 'calls' ? '2026-09-14 12:00:00' : 'draft|2026-09-14 12:00:00';
  const id = 'x'.repeat(length * 3 / 4 - JSON.stringify([position, '']).length);
  const raw = btoa(JSON.stringify([position, id])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  expect(raw.length).toBe(length); return raw;
}
function watchCursorWork() {
  const decode = vi.spyOn(globalThis, 'atob');
  const prepare = db.prepare.bind(db), pages: string[] = [];
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    if (sql.startsWith('SELECT * FROM knowledge_items WHERE collection_id=') || sql.includes('SELECT calls.*, assistants.name AS assistant_name, assistants.public_slug AS assistant_slug')) pages.push(sql);
    return prepare(sql);
  });
  return { decode, pages };
}

for (const route of ['detail', 'items', 'calls'] as const) {
  it.each(['valid2052', 'malformed2049'] as const)(`${route} rejects oversized %s before cursor decode and pagination SQL`, async form => {
    const raw = form === 'valid2052' ? cursorAtLength(route, 2052) : '!'.repeat(2049);
    const observed = watchCursorWork(), response = await request(cursorPath(route, raw));
    // Preserve original diagnostics: Knowledge already returns400 after decode;
    // valid long call cursors formerly return200. Do not mistake status alone for the bound.
    console.info('cursor boundary', { route, length: raw.length, status: response.status, decodes: observed.decode.mock.calls.length, pageQueries: observed.pages.length });
    expect(observed.decode).not.toHaveBeenCalled(); expect(observed.pages).toHaveLength(0);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: route === 'calls' ? 'Invalid cursor' : 'Invalid knowledge cursor' });
  });
  it(`${route} allows a structurally valid cursor at exactly2048 characters`, async () => {
    const raw = cursorAtLength(route, 2048), observed = watchCursorWork();
    expect((await request(cursorPath(route, raw))).status).toBe(200);
    expect(observed.decode).toHaveBeenCalledTimes(1); expect(observed.pages).toHaveLength(1);
  });
  it(`${route} retains small malformed base64 JSON and tuple400 behavior`, async () => {
    for (const raw of ['!', btoa('{broken'), btoa('{}'), btoa('[1,2]'), btoa('["only"]')]) {
      expect((await request(cursorPath(route, raw))).status).toBe(400);
    }
  });
  it(`${route} retains missing/empty first page and stable cursor pagination`, async () => {
    for (let i = 0; i < 21; i++) {
      const id = `page-${String(i).padStart(2, '0')}`;
      db.database.prepare("INSERT INTO knowledge_items(id,business_id,collection_id,kind,status,content) VALUES(?,'biz','one','note','draft','Content')").run(id);
      db.database.prepare("INSERT INTO calls(id,business_id,status,environment,connected_at) VALUES(?,'biz','completed','live',datetime('now'))").run(id);
    }
    const first = await request(cursorPath(route)), empty = await request(cursorPath(route, ''));
    expect(first.status).toBe(200); expect(empty.status).toBe(200);
    const body = await first.json() as { items?: { id: string }[]; nextCursor?: string } | { id: string }[];
    expect(await empty.json()).toEqual(body);
    const firstItems = Array.isArray(body) ? body : body.items!;
    expect(firstItems.length).toBe(route === 'calls' ? 10 : 20);
    const cursor = Array.isArray(body) ? first.headers.get('X-Next-Cursor') : body.nextCursor;
    expect(cursor).toBeTruthy();
    const second = await request(cursorPath(route, cursor!)); expect(second.status).toBe(200);
    const next = await second.json() as typeof body, nextItems = Array.isArray(next) ? next : next.items!;
    expect(nextItems.length).toBe(route === 'calls' ? 10 : 2);
    expect(new Set([...firstItems, ...nextItems].map(row => row.id)).size).toBe(firstItems.length + nextItems.length);
  });
}

it('retains auth owned404 missing-workspace200 and from/to precedence before cursor decoding', async () => {
  const raw = '!'.repeat(2049), observed = watchCursorWork();
  expect((await request(cursorPath('calls', raw), undefined, 'GET', 'missing')).status).toBe(401);
  expect((await request(`/api/me/knowledge/collections/foreign?cursor=${raw}`)).status).toBe(404);
  const empty = await request(cursorPath('calls', raw), undefined, 'GET', 'empty-session');
  expect(empty.status).toBe(200); expect(await empty.json()).toEqual({ items: [], nextCursor: null });
  const badDate = await request(`${cursorPath('calls', raw)}&from=invalid`);
  expect(badDate.status).toBe(400); expect(await badDate.text()).toContain('Invalid from timestamp');
  expect(observed.decode).not.toHaveBeenCalled(); expect(observed.pages).toHaveLength(0);
});

type EnumLane = 'put-kind' | 'put-status' | 'post-status';
const fieldFor = (lane: EnumLane) => lane === 'put-kind' ? 'kind' : 'status';
function enumWrite(lane: EnumLane, value: unknown, extra: Record<string, unknown> = {}) {
  const create = lane === 'post-status';
  return request(create ? '/api/me/knowledge/collections/one/items' : '/api/me/knowledge/items/item', {
    ...(create ? { kind: 'note' } : {}), content: 'Accompanying edit', [fieldFor(lane)]: value, ...extra,
  }, create ? 'POST' : 'PUT');
}
for (const lane of ['put-kind', 'put-status', 'post-status'] as const) {
  const invalid = lane === 'put-kind' ? ['', 'NOTE', 'note ', 'document'] : ['', 'ACTIVE', 'active ', 'published'];
  it.each(invalid)(`${lane} rejects supplied invalid string %j without companion edits or charges`, async value => {
    const before = snapshot(), response = await enumWrite(lane, value);
    expect(response.status).toBe(400); expect(await response.text()).toContain(fieldFor(lane));
    expect(snapshot()).toEqual(before);
  });
  it(`${lane} retains nonstring400 before enum fallback`, async () => {
    for (const value of [null, 123, true, [], {}]) {
      const before = snapshot(), response = await enumWrite(lane, value);
      expect(response.status).toBe(400); expect(await response.text()).toContain(`${fieldFor(lane)} must be text`);
      expect(snapshot()).toEqual(before);
    }
  });
  it(`${lane} omission preserves current value or creation default with one write`, async () => {
    const before = charges(), response = lane === 'post-status'
      ? await request('/api/me/knowledge/collections/one/items', { kind: 'note', content: 'New draft' }, 'POST')
      : await request('/api/me/knowledge/items/item', { content: 'Partial update' });
    expect(response.status).toBe(lane === 'post-status' ? 201 : 200);
    expect(await response.json()).toMatchObject({ kind: 'note', status: 'draft', activated_at: null });
    expect(charges()).toBe(before + 1);
  });
  it(`${lane} invalid strings precede exhausted quota while valid requests remain429`, async () => {
    db.exec("UPDATE rate_counters SET count=500 WHERE bucket='knowledge:biz'");
    const before = snapshot();
    expect((await enumWrite(lane, 'invalid')).status).toBe(400); expect(snapshot()).toEqual(before);
    expect((await enumWrite(lane, lane === 'put-kind' ? 'note' : 'draft')).status).toBe(429); expect(snapshot()).toEqual(before);
  });
}

it('accepts all valid kinds/statuses and retains readiness and SQL activation timestamps', async () => {
  for (const kind of ['note', 'faq', 'service']) {
    const before = charges();
    const created = await request('/api/me/knowledge/collections/one/items', { kind, status: 'active', title: 'Title', question: 'Question', answer: 'Answer', content: 'Content' }, 'POST');
    expect(created.status).toBe(201); expect(await created.json()).toMatchObject({ kind, status: 'active', activated_at: '2026-09-14 12:00:00' });
    expect(charges()).toBe(before + 1);
    expect((await request('/api/me/knowledge/items/item', { kind, status: 'active' })).status).toBe(200);
    const activated = item().activated_at; vi.setSystemTime(new Date(Date.now() + 1000));
    expect((await request('/api/me/knowledge/items/item', {})).status).toBe(200); expect(item().activated_at).toBe(activated);
    expect((await request('/api/me/knowledge/items/item', { status: 'draft' })).status).toBe(200); expect(item().activated_at).toBeNull();
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
  }
});
it('keeps incomplete active requests write-free400 after valid enums', async () => {
  const before = snapshot();
  expect((await request('/api/me/knowledge/items/item', { status: 'active', content: '' })).status).toBe(400);
  expect((await request('/api/me/knowledge/collections/one/items', { kind: 'faq', status: 'active', question: 'Question' }, 'POST')).status).toBe(400);
  expect(snapshot()).toEqual(before);
});
it('retains ownership/destination404 nonstring400 and create required-kind precedence', async () => {
  const before = snapshot();
  expect((await request('/api/me/knowledge/items/missing', { kind: 'invalid', status: 'invalid' })).status).toBe(404);
  expect((await request('/api/me/knowledge/collections/foreign/items', { kind: 'invalid', status: 'invalid' }, 'POST')).status).toBe(404);
  expect((await request('/api/me/knowledge/items/item', { collection_id: 'foreign', kind: 'invalid', status: 'invalid' })).status).toBe(404);
  const nonstring = await request('/api/me/knowledge/items/item', { collection_id: 'foreign', status: null });
  expect(nonstring.status).toBe(400); expect(await nonstring.text()).toContain('status must be text');
  for (const body of [{ status: 'invalid' }, { kind: 'invalid', status: 'invalid' }]) {
    const response = await request('/api/me/knowledge/collections/one/items', body, 'POST');
    expect(response.status).toBe(400); expect(await response.text()).toContain('Knowledge kind');
  }
  expect(snapshot()).toEqual(before);
});

it('reports PUT kind before status when both supplied strings are invalid', async () => {
  const before = snapshot();
  const response = await request('/api/me/knowledge/items/item', { kind: 'invalid', status: 'invalid', content: 'Must not persist' });
  expect(response.status).toBe(400); expect(await response.text()).toContain('Knowledge kind');
  expect(snapshot()).toEqual(before);
});
