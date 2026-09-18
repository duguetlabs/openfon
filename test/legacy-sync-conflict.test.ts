import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { syncLegacyKnowledge } from '../src/studio-api';
import { SqliteD1, applyMigrations } from './sqlite-d1';
import { fakeEnv, fakeCtx } from './fake-d1';
import type { Env } from '../src/types';

let db: SqliteD1, env: Env;
const faq = (answer: string) => JSON.stringify([{ q: 'Question', a: answer }]);
const services = JSON.stringify([{ name: 'Service', notes: 'Initial service' }]);
const faqId = 'legacy_biz_faq_0', serviceId = 'legacy_biz_service_0';
const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'PUT') =>
  worker.fetch(new Request(`https://openfon.test${path}`, { method,
    headers: { Cookie: 'ofs=session', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, fakeCtx);
const sourceSave = (answer: string) => request('/api/me/business/biz', { faqs_json: faq(answer) });
const edit = (body: unknown) => request(`/api/me/knowledge/items/${faqId}`, body);
const rows = (table: string) => db.database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
const snapshot = () => (db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
  .map(({ name }) => ({ name, rows: rows(name) }));
const item = (id = faqId) => db.database.prepare('SELECT * FROM knowledge_items WHERE id=?').get(id);
const count = () => Number((db.database.prepare("SELECT COALESCE(SUM(count),0) AS n FROM rate_counters WHERE bucket='knowledge:biz'").get() as { n: number }).n);
const releases: (() => void)[] = [];
let errors: string[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
  db = new SqliteD1(); applyMigrations(db, 1, 21);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','owned','Owned');
    INSERT INTO agent_settings(business_id) VALUES('biz'); INSERT INTO provider_settings(business_id) VALUES('biz');`);
  db.database.prepare('UPDATE businesses SET services_json=?,faqs_json=? WHERE id=?').run(services, faq('S0'), 'biz');
  env = { ...fakeEnv(undefined as never), DB: db as unknown as D1Database };
  errors = []; vi.spyOn(console, 'error').mockImplementation(error => errors.push(String(error)));
  expect((await request('/api/me/bootstrap')).status).toBe(200);
});
afterEach(() => { releases.splice(0).forEach(release => release()); vi.restoreAllMocks(); db.close(); vi.useRealTimers(); });

function holdProjection() {
  let enter!: () => void, release!: () => void, held = false;
  const reached = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  const sql = new WeakMap<object, string>(), prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation(text => { const statement = prepare(text); sql.set(statement, text); return statement; });
  const batchSpy = vi.spyOn(db, 'batch').mockImplementation(async statements => {
    if (!held && statements.some(statement => sql.get(statement)?.includes('DELETE FROM knowledge_items WHERE business_id'))) {
      held = true; enter(); await gate; // BEFORE real db.batch/BEGIN, in original and fixed.
    }
    return batch(statements);
  });
  return { reached, release, restore() { batchSpy.mockRestore(); prepareSpy.mockRestore(); } };
}
function holdWorkspaceRead() {
  let enter!: () => void, release!: () => void, held = false;
  const reached = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.startsWith('SELECT * FROM businesses WHERE user_id = ?')) {
      const first = statement.first.bind(statement);
      vi.spyOn(statement, 'first').mockImplementation(async () => {
        const result = await first(); if (!held) { held = true; enter(); await gate; } return result;
      });
    }
    return statement;
  });
  return { reached, release, restore() { spy.mockRestore(); } };
}
async function capture(name: string, response: Response, before: unknown, winner: unknown, extra: Record<string, unknown> = {}) {
  const result = { name, status: response.status, body: await response.json(), before, winner, after: snapshot(), counters: rows('rate_counters'), errors: [...errors], extra };
  // Default+JSON reporters are REQUIRED. Emit complete observations before the
  // first expectation; original failures must not hide snapshots or later reads.
  console.log('legacy-sync-preassertion ' + JSON.stringify(result)); return result;
}

it('[original-negative] stale workspace GET cannot undo a completed source save and typed draft', async () => {
  const before = snapshot(), hold = holdWorkspaceRead(); const pending = request('/api/me/business');
  await hold.reached;
  try {
    const source = await sourceSave('S1'), typed = await edit({ answer: 'T', status: 'draft' });
    const winner = snapshot(); hold.release(); const response = await pending; hold.restore();
    const after = snapshot(), fresh = await request('/api/me/bootstrap'), afterFresh = snapshot();
    const result = await capture('stale-get', response, before, winner, { sourceStatus: source.status, typedStatus: typed.status, afterRequest: after, freshStatus: fresh.status, afterFresh });
    expect(result.status).toBe(409); expect(source.status).toBe(200); expect(typed.status).toBe(200);
    expect(after).toEqual(winner); expect(afterFresh).toEqual(winner); expect(item()).toMatchObject({ answer: 'T', status: 'draft' });
  } finally { hold.release(); await pending; hold.restore(); }
});

const competitors = [
  { name: 'typed edit and demotion', act: async () => (await edit({ answer: 'T', status: 'draft' })).status },
  { name: 'same-tenant move', act: async () => {
    const created = await request('/api/me/knowledge/collections', { name: 'Elsewhere' }, 'POST');
    const collection = await created.json() as { id: string }; return (await edit({ collection_id: collection.id })).status;
  } },
  { name: 'acknowledged deletion', act: async () => (await request(`/api/me/knowledge/items/${faqId}`, undefined, 'DELETE')).status },
  { name: 'synthetic imported-member insertion', act: async () => {
    db.database.prepare("INSERT INTO knowledge_items(id,business_id,collection_id,kind,status,content) VALUES('legacy_biz_faq_99','biz','kc_default_biz','note','draft','Peer')").run(); return 200;
  } },
  { name: 'competing source sync', act: async () => (await sourceSave('S2')).status },
  { name: 'omitted sibling source update', act: async () => (await request('/api/me/business/biz', { services_json: '[{"name":"New service"}]' })).status },
  { name: 'synthetic default identity change', act: async () => {
    db.exec("INSERT INTO knowledge_collections(id,business_id,name) VALUES('new-default','biz','New default'); UPDATE knowledge_collections SET is_default=0 WHERE id='kc_default_biz'; UPDATE knowledge_collections SET is_default=1 WHERE id='new-default';"); return 200;
  } },
  { name: 'synthetic marker deletion', act: async () => { db.exec("DELETE FROM compatibility_sync_state WHERE business_id='biz'"); return 200; } },
];
for (const competitor of competitors) it(`[original-negative] pending source batch refuses ${competitor.name}`, async () => {
  const before = snapshot(), hold = holdProjection(), pending = sourceSave('S1'); await hold.reached;
  try {
    const peerStatus = await competitor.act(), winner = snapshot(); hold.release(); const response = await pending;
    const result = await capture(competitor.name, response, before, winner, { peerStatus });
    expect(result.status).toBe(409); expect(peerStatus).toBe(200); expect(result.after).toEqual(winner);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('[original-negative] last imported member beyond the first guard group conflicts', async () => {
  const faqs = JSON.stringify(Array.from({ length: 7 }, (_, index) => ({ q: `Question ${index}`, a: 'S0' })));
  expect((await request('/api/me/business/biz', { faqs_json: faqs })).status).toBe(200);
  const before = snapshot(), hold = holdProjection(), pending = sourceSave('S1'); await hold.reached;
  try {
    const typed = await request('/api/me/knowledge/items/legacy_biz_faq_6', { answer: 'T', status: 'draft' }), winner = snapshot();
    hold.release(); const result = await capture('second-row-guard', await pending, before, winner, { typedStatus: typed.status });
    expect(result.status).toBe(409); expect(typed.status).toBe(200); expect(result.after).toEqual(winner);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('[original-negative] earlier legacy reconstruction survives a later knowledge conflict', async () => {
  db.exec("DELETE FROM agent_settings WHERE business_id='biz'");
  db.database.prepare("UPDATE businesses SET faqs_json=? WHERE id='biz'").run(faq('S1'));
  const before = snapshot(), hold = holdProjection(), pending = request('/api/me/bootstrap'); await hold.reached;
  try {
    const repaired = snapshot(), typed = await edit({ answer: 'T', status: 'draft' }), winner = snapshot();
    hold.release(); const result = await capture('earlier-repair', await pending, before, winner, { repaired, typedStatus: typed.status });
    expect(result.status).toBe(409); expect(typed.status).toBe(200); expect(result.after).toEqual(winner); expect(rows('agent_settings')).toHaveLength(1);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('[original-negative] missing-default conflict refuses its leading collection attachment and quota writes', async () => {
  db.exec("DELETE FROM knowledge_collections WHERE id='kc_default_biz'; INSERT INTO knowledge_collections(id,business_id,name) VALUES('survivor','biz','Survivor');");
  db.database.prepare("INSERT INTO knowledge_items(id,business_id,collection_id,kind,status,question,answer) VALUES(?,'biz','survivor','faq','active','Question','S0')").run(faqId);
  const before = snapshot(), hold = holdProjection(), pending = request('/api/me/bootstrap'); await hold.reached;
  try {
    const typed = await edit({ answer: 'T', status: 'draft' }), winner = snapshot(); hold.release();
    const result = await capture('missing-default-conflict', await pending, before, winner, { typedStatus: typed.status });
    expect(result.status).toBe(409); expect(typed.status).toBe(200); expect(result.after).toEqual(winner);
  } finally { hold.release(); await pending; hold.restore(); }
});

it('[original-negative] wrapped assertion errors map to conflict without writes', async () => {
  const before = snapshot(), batch = db.batch.bind(db); let injected = false;
  vi.spyOn(db, 'batch').mockImplementation(async statements => {
    if (!injected) { injected = true; throw new Error('D1 wrapper', { cause: new Error("JSON path error near '[OPENFON_LEGACY_KNOWLEDGE_CONFLICT]'") }); }
    return batch(statements);
  });
  const result = await capture('wrapped-conflict', await sourceSave('S1'), before, before, { injected });
  expect(result.status).toBe(409); expect(result.after).toEqual(before);
});

it('[original-negative] synthetic create conflict bypasses canonical duplicate recovery', async () => {
  db.exec("DELETE FROM businesses; DELETE FROM rate_counters;");
  const before = snapshot(), batch = db.batch.bind(db); let injected = false, winner: unknown, peerStatus: number | undefined;
  vi.spyOn(db, 'batch').mockImplementation(async statements => {
    if (!injected) {
      injected = true;
      peerStatus = (await request('/api/me/business', { name: 'Peer created' }, 'POST')).status;
      winner = snapshot();
      throw new Error('D1 wrapper', { cause: new Error("JSON path error near '[OPENFON_LEGACY_KNOWLEDGE_CONFLICT]'") });
    }
    return batch(statements);
  });
  const response = await request('/api/me/business', { name: 'Requested create' }, 'POST');
  const result = await capture('create-conflict-mapping', response, before, winner, { peerStatus });
  expect(result.status).toBe(409); expect(peerStatus).toBe(201); expect(result.after).toEqual(winner);
});

it('[original-negative] explicit fresh repair after a conflict retains intentional replacement policy', async () => {
  db.database.prepare("UPDATE businesses SET faqs_json=? WHERE id='biz'").run(faq('S1'));
  const before = snapshot(), hold = holdProjection(), pending = request('/api/me/bootstrap'); await hold.reached;
  try {
    const typed = await edit({ answer: 'T', status: 'draft' }), winner = snapshot(); hold.release(); const response = await pending; hold.restore();
    const afterConflict = snapshot(), fresh = await request('/api/me/bootstrap'), afterFresh = snapshot();
    const result = await capture('fresh-repair-residual', response, before, winner, { typedStatus: typed.status, afterConflict, freshStatus: fresh.status, afterFresh });
    expect(result.status).toBe(409); expect(afterConflict).toEqual(winner); expect(fresh.status).toBe(200);
    expect(item()).toMatchObject({ answer: 'S1', status: 'active' });
  } finally { hold.release(); await pending; hold.restore(); }
});

it('fresh intentional replacement can replace a previously observed typed draft', async () => {
  expect((await edit({ answer: 'T', status: 'draft' })).status).toBe(200); const before = snapshot(), spend = count();
  const result = await capture('fresh-intent', await sourceSave('S1'), before, before);
  expect(result.status).toBe(200); expect(item()).toMatchObject({ answer: 'S1', status: 'active' }); expect(count()).toBe(spend + 1);
});
it('equivalent cleanup preserves marker typed draft deletion generated IDs and charges', async () => {
  await edit({ answer: 'T', status: 'draft' }); await request(`/api/me/knowledge/items/${serviceId}`, undefined, 'DELETE');
  await request('/api/me/knowledge/collections/kc_default_biz/items', { kind: 'note', content: 'Independent' }, 'POST');
  const before = snapshot(), marker = rows('compatibility_sync_state'), items = rows('knowledge_items'), spend = count();
  const result = await capture('equivalent-cleanup', await request('/api/me/business/biz', { faqs_json: '[ {"a":"S0", "q":"Question", "ignored":true} ]', services_json: '[ {"notes":"Initial service", "name":"Service"} ]' }), before, before);
  expect(result.status).toBe(200); expect(rows('compatibility_sync_state')).toEqual(marker); expect(rows('knowledge_items')).toEqual(items); expect(count()).toBe(spend);
});
it('empty replacement and repeated no-op marker succeed without item charges', async () => {
  const before = snapshot(), spend = count(); const response = await request('/api/me/business/biz', { services_json: '[]', faqs_json: '[]' });
  await syncLegacyKnowledge(env, { id: 'biz', services_json: '[]', faqs_json: '[]' });
  await syncLegacyKnowledge(env, { id: 'biz', services_json: '[]', faqs_json: '[]' });
  const result = await capture('empty-noop', response, before, before);
  expect(result.status).toBe(200); expect(rows('knowledge_items')).toEqual([]); expect(count()).toBe(spend);
});
it('new-workspace creation retains one batch foundation and initial projection', async () => {
  db.exec("DELETE FROM businesses; DELETE FROM rate_counters;"); const before = snapshot();
  const result = await capture('new-workspace', await request('/api/me/business', { name: 'Created', faqs_json: faq('Created answer') }, 'POST'), before, before);
  expect(result.status).toBe(201); expect(rows('businesses')).toHaveLength(1); expect(rows('agent_settings')).toHaveLength(1);
  expect(rows('assistants')).toHaveLength(1); expect(rows('provider_settings')).toHaveLength(1); expect(rows('knowledge_items')).toHaveLength(1); expect(rows('assistant_knowledge_collections')).toHaveLength(1);
});
it('missing-default successful repair keeps collection attachment and items atomic', async () => {
  db.exec("DELETE FROM knowledge_collections WHERE id='kc_default_biz'"); const before = snapshot();
  const result = await capture('missing-default-success', await request('/api/me/bootstrap'), before, before);
  expect(result.status).toBe(200); expect(rows('knowledge_collections')).toHaveLength(1); expect(rows('knowledge_items')).toHaveLength(2); expect(rows('assistant_knowledge_collections')).toHaveLength(1);
});
it('known exhausted item quota is write-free before source mutation', async () => {
  db.exec("UPDATE rate_counters SET count=500 WHERE bucket='knowledge:biz'"); const before = snapshot();
  const result = await capture('known-quota', await sourceSave('S1'), before, before);
  expect(result.status).toBe(429); expect(result.after).toEqual(before);
});
it('quota acquired by a peer after observation rolls back the complete source batch', async () => {
  const before = snapshot(), hold = holdProjection(), pending = sourceSave('S1'); await hold.reached;
  try {
    db.exec("UPDATE rate_counters SET count=500 WHERE bucket='knowledge:biz'"); const winner = snapshot(); hold.release();
    const result = await capture('late-quota', await pending, before, winner);
    expect(result.status).toBe(429); expect(result.after).toEqual(winner);
  } finally { hold.release(); await pending; hold.restore(); }
});
it('late marker execution failure rolls back prior source delete insert and trigger charge', async () => {
  const before = snapshot(), spend = count(); let inside: ReturnType<typeof snapshot> | undefined;
  db.hook = sql => { if (sql.includes('INSERT INTO compatibility_sync_state (business_id, services_json')) { inside = snapshot(); throw new Error('SYNTHETIC_LATE_MARKER_EXECUTION'); } };
  const response = await sourceSave('S1'); db.hook = undefined;
  const result = await capture('late-marker-rollback', response, before, before, { inside });
  expect(result.status).toBe(500); expect(inside).toBeDefined();
  expect(inside?.find(table => table.name === 'businesses')?.rows[0]).toMatchObject({ faqs_json: faq('S1') });
  expect(inside?.find(table => table.name === 'rate_counters')?.rows.find(row => row.bucket === 'knowledge:biz')).toMatchObject({ count: spend + 1 });
  expect(result.after).toEqual(before);
});
it('exact restored row ABA remains accepted without a revision guarantee', async () => {
  const original = item(), before = snapshot(), hold = holdProjection(), pending = sourceSave('S1'); await hold.reached;
  try {
    const changed = await edit({ answer: 'T' }), restored = await edit(original); const winner = snapshot(), spend = count(); hold.release();
    const result = await capture('same-second-aba', await pending, before, winner, { changedStatus: changed.status, restoredStatus: restored.status });
    expect(result.status).toBe(200); expect(changed.status).toBe(200); expect(restored.status).toBe(200); expect(item()).toMatchObject({ answer: 'S1' }); expect(count()).toBe(spend + 1);
  } finally { hold.release(); await pending; hold.restore(); }
});
it('unaffected family edits and generated-ID drafts do not conflict', async () => {
  const before = snapshot(), hold = holdProjection(), pending = sourceSave('S1'); await hold.reached;
  try {
    const changed = await request(`/api/me/knowledge/items/${serviceId}`, { content: 'Typed service', status: 'draft' });
    const draft = await request('/api/me/knowledge/collections/kc_default_biz/items', { kind: 'note', content: 'Independent' }, 'POST');
    const winner = snapshot(); hold.release(); const result = await capture('unaffected', await pending, before, winner, { changedStatus: changed.status, draftStatus: draft.status });
    expect(result.status).toBe(200); expect(changed.status).toBe(200); expect(draft.status).toBe(201);
    expect(item(serviceId)).toMatchObject({ content: 'Typed service', status: 'draft' }); expect(rows('knowledge_items')).toHaveLength(3);
  } finally { hold.release(); await pending; hold.restore(); }
});
it('unrelated database errors retain generic failure mapping', async () => {
  const before = snapshot(); db.hook = sql => { if (sql.includes('DELETE FROM knowledge_items WHERE business_id')) throw new Error('SYNTHETIC_OTHER_ERROR'); };
  const response = await sourceSave('S1'); db.hook = undefined;
  const result = await capture('other-error', response, before, before);
  expect(result.status).toBe(500); expect(result.after).toEqual(before);
});
