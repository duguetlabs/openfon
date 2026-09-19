import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { loadSummaryLlm, resolveSummary, type SummarySettings } from '../src/summary-settings';
import { resolveLlm } from '../src/providers';
import type { AgentSettings, Env, ProviderSettings } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

let db: SqliteD1;
const env = { DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: 'instance-private', DEFAULT_LLM_MODEL: 'instance-model' } as Env;
const assistant = { llm_base_url: 'https://text.example/v1', llm_api_key: 'reply-private', llm_model: 'reply-model' } as AgentSettings;
const provider = { ...assistant, llm_model: 'workspace-model' } as ProviderSettings;
const custom = { mode: 'custom', baseUrl: 'https://summary.example/v1', apiKey: 'summary-private', model: 'summary-model', revision: null };
const request = (body?: unknown, token = 's1', path = '/api/me/call-summaries') => worker.fetch(new Request(`https://openfon.test${path}`, {
  method: body === undefined ? 'GET' : 'PUT', headers: { Cookie: `ofs=${token}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), { ...env, DB: db as unknown as D1Database }, { waitUntil() {} } as ExecutionContext);
beforeEach(() => {
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('u1','one@example.test','h'),('u2','two@example.test','h');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('s1','u1','2099-01-01'),('s2','u2','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('b1','u1','one','One'),('b2','u2','two','Two');
    INSERT INTO agent_settings(business_id,llm_model) VALUES('b1','reply-model');
    INSERT INTO provider_settings(business_id,llm_base_url,llm_api_key,llm_model) VALUES('b1','https://text.example/v1','reply-private','workspace-model');`);
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });
it('migration preserves existing rows and default summary routing', () => {
  const old = new SqliteD1();
  try {
    applyMigrations(old, 1, 22);
    old.exec(`INSERT INTO users(id,email,password_hash) VALUES('u','x@example.test','h'); INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','B'); INSERT INTO agent_settings(business_id,llm_model) VALUES('b','old-summary');`);
    const before = old.database.prepare('SELECT * FROM agent_settings').get();
    applyMigrations(old, 23, 23);
    expect(old.database.prepare('SELECT * FROM agent_settings').get()).toEqual(before);
    expect(old.database.prepare('SELECT * FROM summary_settings').all()).toEqual([]);
    expect(resolveSummary(env, null, provider, assistant)).toEqual(resolveLlm(env, assistant));
  } finally { old.close(); }
});
it('saves summary-only credentials, returns no keys and isolates workspaces and account export', async () => {
  expect(await (await request()).json()).toMatchObject({ mode: 'legacy', revision: null });
  const res = await request(custom); expect(res.status).toBe(200);
  const view = await res.json() as { revision: string };
  expect(JSON.stringify(view)).not.toContain('summary-private');
  expect(await (await request()).json()).toEqual(view);
  expect(await (await request(undefined, 's2')).json()).toMatchObject({ mode: 'legacy', revision: null });
  expect((await request(custom, '')).status).toBe(401);
  expect((await request(undefined, '')).status).toBe(401);
  const exported = await request(undefined, 's1', '/api/me/account/export'); expect(exported.status).toBe(200);
  const data = await exported.text();
  for (const hidden of ['summary-private', 'summary.example', 'reply-private', 'instance-private']) expect(data).not.toContain(hidden);
  expect(data).toContain('summary-model');
  expect(db.database.prepare("SELECT llm_model,llm_api_key FROM provider_settings WHERE business_id='b1'").get()).toEqual({ llm_model: 'workspace-model', llm_api_key: 'reply-private' });
});
it('workspace summaries ignore assistant models, while conversation resolution stays unchanged', async () => {
  expect((await request({ ...custom, mode: 'workspace', baseUrl: '', apiKey: '', model: '' })).status).toBe(200);
  const config = await loadSummaryLlm({ ...env, DB: db as unknown as D1Database }, 'b1', assistant);
  expect(config).toEqual({ baseUrl: 'https://text.example/v1', apiKey: 'reply-private', model: 'workspace-model' });
  expect(resolveLlm(env, assistant).model).toBe('reply-model');
  const summary = db.database.prepare('SELECT * FROM summary_settings').get() as unknown as SummarySettings;
  expect(resolveSummary(env, { ...summary, model: 'summary-override' }, provider, assistant).model).toBe('summary-override');
  expect(resolveSummary(env, summary, null, assistant)).toEqual({ baseUrl: env.DEFAULT_LLM_BASE_URL, apiKey: 'instance-private', model: 'instance-model' });
});
it('custom summaries never inherit another component key, including at the instance endpoint', async () => {
  await request(custom);
  expect(await loadSummaryLlm({ ...env, DB: db as unknown as D1Database }, 'b1', assistant)).toEqual({ baseUrl: custom.baseUrl, apiKey: custom.apiKey, model: custom.model });
  const config = db.database.prepare('SELECT * FROM summary_settings').get() as unknown as SummarySettings;
  expect(() => resolveSummary(env, { ...config, base_url: env.DEFAULT_LLM_BASE_URL, api_key: '' }, provider, assistant)).toThrow('separate API key');
});
it.each([
  { mode: 'invalid' }, { model: '' }, { model: 7 }, { model: 'x'.repeat(257) }, { apiKey: '' }, { apiKey: null },
  { baseUrl: 'https://127.0.0.1/v1' }, { baseUrl: 'https://u:p@summary.example/v1' }, { baseUrl: 'http://summary.example/v1' },
  { baseUrl: 'not a URL' }, { mode: 'workspace' }, { revision: undefined },
])('rejects malformed settings without writes: %j', async patch => {
  expect((await request({ ...custom, ...patch })).status).toBe(400);
  expect(db.database.prepare('SELECT * FROM summary_settings').all()).toEqual([]);
});
it('retains only endpoint-bound keys and removes them when selecting workspace summaries', async () => {
  const view = await (await request(custom)).json() as { revision: string };
  expect((await request({ ...custom, ...view, apiKey: '', baseUrl: 'https://other.example/v1' })).status).toBe(400);
  const saved = await request({ ...custom, ...view, apiKey: '', model: 'new-summary' }); expect(saved.status).toBe(200);
  const current = await saved.json() as { revision: string };
  expect(db.database.prepare('SELECT api_key FROM summary_settings').get()).toEqual({ api_key: 'summary-private' });
  expect((await request({ ...custom, ...current, mode: 'workspace', model: '', baseUrl: '', apiKey: '' })).status).toBe(200);
  expect(db.database.prepare('SELECT api_key,base_url FROM summary_settings').get()).toEqual({ api_key: '', base_url: '' });
});
it.each(['initial', 'existing'])('rejects stale %s concurrent saves at the SQL write boundary', async kind => {
  const previous = kind === 'existing' ? await (await request(custom)).json() as { revision: string } : { revision: null };
  db.hook = sql => {
    if (!sql.startsWith('INSERT INTO summary_settings')) return;
    db.hook = null;
    db.exec(`INSERT INTO summary_settings(business_id,mode,base_url,api_key,model,revision) VALUES('b1','workspace','','','winner','concurrent') ON CONFLICT(business_id) DO UPDATE SET model='winner',revision='concurrent'`);
  };
  expect((await request({ ...custom, revision: previous.revision })).status).toBe(409);
  expect(db.database.prepare('SELECT model,revision FROM summary_settings').get()).toEqual({ model: 'winner', revision: 'concurrent' });
});
it('rejects stale browser revisions and cascades secret deletion with the account', async () => {
  await request(custom);
  expect((await request(custom)).status).toBe(409);
  db.exec("DELETE FROM users WHERE id='u1'");
  expect(db.database.prepare('SELECT * FROM summary_settings').all()).toEqual([]);
});
