import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { AccountAuthBudget, accountAuthBudget } from '../src/account-auth-budget';
import { DatabaseSync } from 'node:sqlite';
import { createVerifiedSession, hashPassword, verifyPassword } from '../src/auth';
import { fakeCtx, fakeEnv } from './fake-d1';
import { applyMigrations, SqliteD1 } from './sqlite-d1';
import type { Env } from '../src/types';

let db: SqliteD1;
let env: Env;
const password = 'old-correct-horse';
let oldHash: string;
const call = (path: string, method = 'GET', body?: unknown, token = 'owner-session') => worker.fetch(
  new Request(`https://openfon.test${path}`, { method, headers: { Cookie: `ofs=${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, fakeCtx,
);
beforeEach(async ({ task }) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
  const budget = new AccountAuthBudget();
  vi.spyOn(accountAuthBudget, 'acquire').mockImplementation(() => budget.acquire());
  db = new SqliteD1();
  // Export must also exclude credentials from historical, pre-barrier rows.
  // Current installations reject creating these snapshots altogether.
  if (task.name === 'refuses pre-claim live sessions after migration and bootstrap backfill') applyMigrations(db, 1, 7);
  else if (task.name.startsWith('exports historical owned data')) applyMigrations(db, 1, 15);
  else applyMigrations(db);
  env = { ...fakeEnv(), DB: db as unknown as D1Database };
  oldHash = await hashPassword(password);
  for (const id of ['owner', 'other']) {
    db.database.prepare('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)').run(id, `${id}@example.test`, oldHash);
    db.database.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(`${id}-session`, id, '2026-10-11T12:00:00.000Z');
    db.database.prepare('INSERT INTO businesses (id,user_id,slug,name) VALUES (?,?,?,?)').run(`biz-${id}`, id, id, id);
  }
  db.database.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('owner-second-session', 'owner', '2026-10-11T12:00:00.000Z');
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('account self service', () => {
  it('requires authentication for export and mutations', async () => {
    const response = await call('/api/me/account/export', 'GET', undefined, 'invalid');
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await call('/api/me/account', 'DELETE', { confirmation: 'DELETE', currentPassword: password }, 'invalid')).status).toBe(401);
  });

  it('changes the password and rotates the caller cookie while revoking every old session', async () => {
    const response = await call('/api/me/account/password', 'POST', { currentPassword: password, newPassword: 'new-correct-horse' });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie');
    expect(cookie).toMatch(/^ofs=[a-f0-9]{64};/);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) expect(cookie).toContain(attribute);
    const replacement = cookie!.match(/^ofs=([^;]+)/)![1];
    const row = db.database.prepare('SELECT password_hash FROM users WHERE id=?').get('owner') as { password_hash: string };
    expect(await verifyPassword('new-correct-horse', row.password_hash)).toBe(true);
    expect(db.database.prepare('SELECT token FROM sessions WHERE user_id=?').all('owner')).toEqual([{ token: replacement }]);
    expect((await call('/api/me/account/export')).status).toBe(401);
    expect((await call('/api/me/account/export', 'GET', undefined, 'owner-second-session')).status).toBe(401);
    expect((await call('/api/me/account/export', 'GET', undefined, replacement)).status).toBe(200);
    expect((await call('/api/me/account/export', 'GET', undefined, 'other-session')).status).toBe(200);
    // An in-flight login which verified before the password change cannot
    // restore a session for the previous credential after revocation.
    expect(await createVerifiedSession(env, 'owner', oldHash)).toBeNull();
    expect(await createVerifiedSession(env, 'owner', row.password_hash)).toBeTypeOf('string');
  });

  it('rolls back the password and all sessions if replacement insertion fails', async () => {
    db.exec("CREATE TRIGGER refuse_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected session insert failure'); END");
    const before = db.database.prepare('SELECT * FROM sessions ORDER BY token').all();
    const response = await call('/api/me/account/password', 'POST', { currentPassword: password, newPassword: 'new-correct-horse' });
    expect(response.status).toBe(500);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(db.database.prepare('SELECT password_hash FROM users WHERE id=?').get('owner')).toEqual({ password_hash: oldHash });
    expect(db.database.prepare('SELECT * FROM sessions ORDER BY token').all()).toEqual(before);
  });

  it('rejects incorrect current passwords and invalid new passwords without changing credentials', async () => {
    expect((await call('/api/me/account/password', 'POST', { currentPassword: 'wrong', newPassword: 'new-correct-horse' })).status).toBe(403);
    expect((await call('/api/me/account/password', 'POST', { currentPassword: password, newPassword: 'short' })).status).toBe(400);
    expect((await call('/api/me/account/password', 'POST', null)).status).toBe(400);
    expect(db.database.prepare('SELECT password_hash FROM users WHERE id=?').get('owner')).toEqual({ password_hash: oldHash });
  });

  it('does not overwrite concurrent credential changes or revoke their sessions', async () => {
    const competingHash = await hashPassword('competing-password');
    let raced = false;
    db.hook = (sql) => {
      if (raced || !sql.startsWith('UPDATE users SET password_hash')) return;
      raced = true;
      db.database.prepare('UPDATE users SET password_hash=? WHERE id=?').run(competingHash, 'owner');
    };
    expect((await call('/api/me/account/password', 'POST', { currentPassword: password, newPassword: 'new-correct-horse' })).status).toBe(409);
    expect(db.database.prepare('SELECT password_hash FROM users WHERE id=?').get('owner')).toEqual({ password_hash: competingHash });
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get('owner')).toEqual({ n: 2 });
  });

  it('exports historical owned data and excludes credentials and session tokens', async () => {
    db.database.prepare('INSERT INTO agent_settings (business_id,llm_api_key) VALUES (?,?)').run('biz-owner', 'provider-secret');
    db.database.prepare('INSERT INTO engine_profiles (id,business_id,name,llm_api_key) VALUES (?,?,?,?)').run('profile', 'biz-owner', 'Profile', 'profile-secret');
    db.database.prepare('INSERT INTO calls (id,business_id,status) VALUES (?,?,?)').run('call-owner', 'biz-owner', 'completed');
    db.database.prepare('INSERT INTO call_turns (call_id,role,text) VALUES (?,?,?)').run('call-owner', 'caller', 'My question');
    const response = await call('/api/me/account/export');
    expect(response.status).toBe(200);
    // The registered account route inherits private-API middleware headers.
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    const text = await response.text();
    for (const forbidden of ['provider-secret', 'profile-secret', oldHash, 'owner-session', 'other@example.test', 'biz-other']) expect(text).not.toContain(forbidden);
    expect(text).toContain('My question');
    expect(JSON.parse(text).data.businesses).toHaveLength(1);
  });

  it('exports independent provider configuration without any capability key', async () => {
    db.database.prepare(`INSERT INTO provider_settings
      (business_id,llm_base_url,llm_model,llm_api_key,stt_provider,stt_base_url,stt_model,stt_api_key,realtime_provider,realtime_base_url,realtime_api_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('biz-owner','https://text.example/v1','custom-text','text-export-secret',
      'custom','https://speech.example/v1','custom-stt','speech-export-secret','openai','wss://api.openai.com/v1/realtime','realtime-export-secret');
    const response = await call('/api/me/account/export');
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const key of ['text-export-secret','speech-export-secret','realtime-export-secret','llm_api_key','stt_api_key','realtime_api_key']) expect(text).not.toContain(key);
    expect(JSON.parse(text).data.provider_settings[0]).toMatchObject({
      llm_model:'custom-text',stt_provider:'custom',stt_base_url:'https://speech.example/v1',stt_model:'custom-stt',
      realtime_provider:'openai',realtime_base_url:'wss://api.openai.com/v1/realtime',
    });
  });

  function snapshotExceptExportCharge() {
    const tables = db.database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    return Object.fromEntries(tables.map(({ name }) => [name,
      (db.database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as Array<Record<string, unknown>>)
        .filter(row => name !== 'rate_counters' || row.bucket !== 'account:export:owner')
        .map(row => JSON.stringify(row)).sort(),
    ]));
  }

  it('exports historical owned data with sanitized provider URLs in all five locations [export-url]', async () => {
    const url = 'HtTpS://user:encoded%2Dsecret@provider.example/v1?unknown=query-canary&unknown=second#fragment-canary';
    db.database.prepare('INSERT INTO agent_settings(business_id,llm_base_url,llm_api_key) VALUES (?,?,?)')
      .run('biz-owner', url, 'dedicated-canary');
    db.database.prepare('INSERT INTO engine_profiles(id,business_id,name,llm_base_url) VALUES (?,?,?,?)')
      .run('historical-url', 'biz-owner', 'Retain name', url);
    db.database.prepare('INSERT INTO provider_settings(business_id,llm_base_url,stt_base_url,realtime_base_url) VALUES (?,?,?,?)')
      .run('biz-owner', url, url.replace('HtTpS:', 'http:'), url.replace('HtTpS:', 'wss:'));
    db.database.prepare('UPDATE businesses SET website=? WHERE id=?').run('https://site.example/?routing=keep', 'biz-owner');
    const before = snapshotExceptExportCharge();
    const response = await call('/api/me/account/export');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    const body = await response.text();
    const { data } = JSON.parse(body);
    expect(data.agent_settings[0].llm_base_url).toBe('https://provider.example/v1');
    expect(data.engine_profiles[0].llm_base_url).toBe('https://provider.example/v1');
    expect(data.provider_settings[0]).toMatchObject({ llm_base_url: 'https://provider.example/v1',
      stt_base_url: 'http://provider.example/v1', realtime_base_url: 'wss://provider.example/v1' });
    for (const canary of ['encoded%2Dsecret', 'query-canary', 'fragment-canary', 'dedicated-canary']) expect(body).not.toContain(canary);
    expect(data.engine_profiles[0].name).toBe('Retain name');
    expect(data.businesses[0].website).toBe('https://site.example/?routing=keep');
    expect(snapshotExceptExportCharge()).toEqual(before);
    expect(db.database.prepare('SELECT count FROM rate_counters WHERE bucket=?').get('account:export:owner')).toMatchObject({ count: 1 });
  });

  it('exports a currently accepted query-bearing text provider without its query credentials [export-url]', async () => {
    const saved = await call('/api/me/provider', 'PUT', {
      baseUrl: 'https://text.example/v1?arbitrary=query-canary&target=route#fragment-canary', apiKey: 'own-provider-key',
    });
    expect(saved.status).toBe(200);
    expect(db.database.prepare('SELECT llm_base_url,llm_api_key FROM provider_settings WHERE business_id=?').get('biz-owner'))
      .toMatchObject({ llm_base_url: 'https://text.example/v1?arbitrary=query-canary&target=route#fragment-canary', llm_api_key: 'own-provider-key' });
    const before = snapshotExceptExportCharge();
    const response = await call('/api/me/account/export');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body).data.provider_settings[0].llm_base_url).toBe('https://text.example/v1');
    expect(body).not.toContain('query-canary');
    expect(body).not.toContain('fragment-canary');
    expect(body).not.toContain('own-provider-key');
    expect(snapshotExceptExportCharge()).toEqual(before);
  });

  for (const url of ['not an absolute URL?token=bad-canary', 'https://[bad/?token=bad-canary', 'data:text/plain,bad-canary', 'file:///private/bad-canary']) {
    it(`blanks malformed or unsupported provider URL ${url.split(':')[0]} [export-url]`, async () => {
      db.database.prepare('INSERT INTO provider_settings(business_id,llm_base_url,stt_base_url,realtime_base_url) VALUES (?,?,?,?)')
        .run('biz-owner', url, url, url);
      const before = snapshotExceptExportCharge();
      const response = await call('/api/me/account/export');
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text).data.provider_settings[0]).toMatchObject({ llm_base_url: '', stt_base_url: '', realtime_base_url: '' });
      expect(text).not.toContain('bad-canary');
      expect(snapshotExceptExportCharge()).toEqual(before);
    });
  }

  it('retains safe endpoint metadata and bounds serialized Unicode growth [export-url]', async () => {
    const original = 'HTTPS://bücher.example/日 本';
    db.database.prepare('INSERT INTO provider_settings(business_id,llm_base_url,stt_base_url,realtime_base_url) VALUES (?,?,?,?)')
      .run('biz-owner', original, '', 'ws://localhost:8080/v1');
    const before = snapshotExceptExportCharge();
    const response = await call('/api/me/account/export');
    expect(response.status).toBe(200);
    const text = await response.text();
    const provider = JSON.parse(text).data.provider_settings[0];
    expect(provider).toMatchObject({ llm_base_url: 'https://xn--bcher-kva.example/%E6%97%A5%20%E6%9C%AC', stt_base_url: '', realtime_base_url: 'ws://localhost:8080/v1' });
    expect(new TextEncoder().encode(provider.llm_base_url).length).toBeGreaterThan(new TextEncoder().encode(original).length);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(snapshotExceptExportCharge()).toEqual(before);
  });

  for (const mode of ['row', 'aggregate'] as const) {
    it(`refuses URL serialization growth beyond the ${mode} output budget [export-url]`, async () => {
      // Synthetic SQL-result boundary to exercise the independent post-transform
      // guard. Existing tests separately prove real raw/SQL preallocation refusal.
      db.exec("INSERT INTO provider_settings(business_id) VALUES ('biz-owner')");
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, 'prepare').mockImplementation(sql => {
        const statement = prepare(sql);
        if (sql.startsWith('WITH ')) {
          const all = statement.all.bind(statement);
          statement.all = async <T>() => {
            const result = await all<{ table_name: string; payload: string }>();
            const row = result.results.find(item => item.table_name === 'provider_settings')!;
            const item = JSON.parse(row.payload);
            item.llm_base_url = `https://provider.example/${'é'.repeat(mode === 'row' ? 260000 : 180000)}`;
            row.payload = JSON.stringify(item);
            if (mode === 'aggregate') for (let i = 0; i < 3; i++) result.results.push({ ...row });
            return result as unknown as Awaited<ReturnType<typeof statement.all<T>>>;
          };
        }
        return statement;
      });
      const response = await call('/api/me/account/export');
      expect(response.status).toBe(413);
      expect(response.headers.get('Content-Disposition')).toBeNull();
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect((await response.text()).length).toBeLessThan(1024);
    });
  }

  it('preserves nullable historical payload metadata [export-url]', async () => {
    // Synthetic SQL-result boundary: current provider URL columns are NOT NULL.
    // Exercise legacy/null payload tolerance without weakening the schema.
    db.exec("INSERT INTO provider_settings(business_id) VALUES ('biz-owner')");
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.startsWith('WITH ')) {
        const all = statement.all.bind(statement);
        statement.all = async <T>() => {
          const result = await all<{ table_name: string; payload: string }>();
          for (const row of result.results) if (row.table_name === 'provider_settings') {
            const item = JSON.parse(row.payload); item.llm_base_url = null; row.payload = JSON.stringify(item);
          }
          return result as unknown as Awaited<ReturnType<typeof statement.all<T>>>;
        };
      }
      return statement;
    });
    const response = await call('/api/me/account/export');
    expect(response.status).toBe(200);
    expect((await response.json() as any).data.provider_settings[0].llm_base_url).toBeNull();
  });

  it('reads account, calls and turns in one snapshot when finalization happens between operations', async () => {
    db.exec("INSERT INTO calls(id,business_id,status) VALUES ('snapshot-call','biz-owner','active')");
    let exportReads = 0;
    db.hook = sql => {
      // Simulate a finalizer getting its turn before the next database read.
      // The old per-table export reads calls first, then sees new turns later.
      if (!sql.includes('json_object(')) return;
      exportReads++;
      if (sql.includes('FROM call_turns')) {
        db.exec("UPDATE calls SET status='completed',summary='Finished' WHERE id='snapshot-call'; INSERT INTO call_turns(call_id,role,text) VALUES ('snapshot-call','caller','Final transcript')");
      }
    };
    const response = await call('/api/me/account/export');
    expect(response.status).toBe(200);
    const exported = await response.json() as { account: { id: string }; data: { calls: Array<{ status: string; summary: string }>; call_turns: Array<{ text: string }> } };
    expect(exported.account.id).toBe('owner');
    expect(exported.data.call_turns[0].text).toBe('Final transcript');
    expect(exported.data.calls[0]).toMatchObject({ status: 'completed', summary: 'Finished' });
    expect(exportReads).toBe(1);
  });

  it('enforces a combined byte budget across otherwise individually bounded tables', async () => {
    // Preserve oversized pre0015 assistant rows while testing the separate export cap.
    db.exec('DROP TRIGGER assistant_insert_budget; DROP TRIGGER assistant_update_budget;');
    const assistant = db.database.prepare('INSERT INTO assistants(id,business_id,public_slug,name,persona) VALUES (?,?,?,?,?)');
    const callRow = db.database.prepare('INSERT INTO calls(id,business_id,summary) VALUES (?,?,?)');
    for (let i=0; i<12; i++) {
      assistant.run(`a${i}`, 'biz-owner', `slug${i}`, 'Agent', 'x'.repeat(190000));
      callRow.run(`c${i}`, 'biz-owner', 'y'.repeat(190000));
    }
    applyMigrations(db, 15, 15);
    db.database.function('json_object', { varargs: true }, () => { throw new Error('Rejected exports must not construct JSON'); });
    const response = await call('/api/me/account/export');
    expect(response.status).toBe(413);
    expect((await response.text()).length).toBeLessThan(1024);
  });

  it('rejects aggregate escaping expansion before constructing any JSON rows', async () => {
    // Each row is below the existing240KB raw guard, and the whole account
    // is below4MiB raw, but control escaping across rows exceeds4MiB.
    const row = db.database.prepare('INSERT INTO calls(id,business_id,summary) VALUES (?,?,?)');
    for (let i=0; i<8; i++) row.run(`escaped-${i}`, 'biz-owner', '\u0001'.repeat(100000));
    db.database.function('json_object', { varargs: true }, () => { throw new Error('Escaping refusal must precede JSON materialization'); });
    const response = await call('/api/me/account/export');
    expect(response.status).toBe(413);
    expect((await response.text()).length).toBeLessThan(1024);
  });

  it('preserves control-heavy text when its conservative escaped bound fits', async () => {
    const summary = '\u0001'.repeat(100000);
    db.database.prepare('INSERT INTO calls(id,business_id,summary) VALUES (?,?,?)').run('escaped-fit', 'biz-owner', summary);
    const response = await call('/api/me/account/export');
    expect(response.status).toBe(200);
    const result = await response.json() as { data: { calls: Array<{ id: string; summary: string }> } };
    expect(result.data.calls.find(row => row.id === 'escaped-fit')?.summary).toBe(summary);
  });

  it('rejects excessive row counts before constructing JSON', async () => {
    db.database.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001)
      INSERT INTO calls(id,business_id) SELECT 'bulk-' || i, 'biz-owner' FROM n`);
    db.database.function('json_object', { varargs: true }, () => { throw new Error('Rejected exports must not construct JSON'); });
    expect((await call('/api/me/account/export')).status).toBe(413);
  });

  it('exports wide records under the D1 function argument limit without losing null fields', async () => {
    const native = new DatabaseSync(':memory:');
    db.database.function('json_object', { varargs: true }, (...args) => {
      if (args.length > 32) throw new Error('D1 SQL function argument limit exceeded');
      return (native.prepare(`SELECT json_object(${args.map(() => '?').join(',')}) AS value`).get(...args) as { value: string }).value;
    });
    try {
      expect((await call('/api/me/bootstrap')).status).toBe(200);
      db.database.prepare("UPDATE assistants SET state='draft', activated_at=NULL WHERE business_id=?").run('biz-owner');
      db.database.prepare('INSERT INTO calls (id,business_id,status) VALUES (?,?,?)').run('call-owner', 'biz-owner', 'completed');
      const response = await call('/api/me/account/export');
      expect(response.status).toBe(200);
      const exported = await response.json() as { data: Record<string, Array<Record<string, unknown>>> };
      expect(exported.data.assistants[0]).toHaveProperty('activated_at', null);
      expect(exported.data.calls[0]).toHaveProperty('failure_message', null);
    } finally { native.close(); }
  });

  it('refuses a byte-heavy export even when there are only a few records', async () => {
    // Oversized historical data remains export-bounded after quota migration.
    db.close(); db = new SqliteD1(); applyMigrations(db, 1, 12);
    env = { ...env, DB: db as unknown as D1Database };
    db.database.prepare('INSERT INTO users(id,email,password_hash) VALUES(?,?,?)').run('owner','owner@example.test',oldHash);
    db.exec("INSERT INTO sessions(token,user_id,expires_at) VALUES('owner-session','owner','2026-10-11T12:00:00Z'); INSERT INTO businesses(id,user_id,slug,name) VALUES('biz-owner','owner','owner','Owner');");
    db.database.prepare('INSERT INTO knowledge_collections (id,business_id,name) VALUES (?,?,?)').run('large', 'biz-owner', 'Large notes');
    const insert = db.database.prepare('INSERT INTO knowledge_items (id,business_id,collection_id,kind,content) VALUES (?,?,?, ?,?)');
    for (let i = 0; i < 5; i++) insert.run(`large-${i}`, 'biz-owner', 'large', 'note', 'x'.repeat(1024 * 1024));
    applyMigrations(db, 13, 13);
    db.database.function('json_object', { varargs: true }, () => { throw new Error('Rejected exports must not construct JSON'); });
    const response = await call('/api/me/account/export');
    expect(response.status).toBe(413);
    expect((await response.text()).length).toBeLessThan(1024);
  });

  it('rejects oversized workspace writes without persisting them', async () => {
    const response = await call('/api/me/business/biz-owner', 'PUT', { description: 'x'.repeat(129 * 1024) });
    expect(response.status).toBe(413);
    expect(db.database.prepare('SELECT description FROM businesses WHERE id=?').get('biz-owner')).toEqual({ description: '' });
  });

  it('requires confirmation and refuses deletion while a call is active', async () => {
    expect((await call('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'delete' })).status).toBe(400);
    expect((await call('/api/me/account', 'DELETE', { currentPassword: 'wrong', confirmation: 'DELETE' })).status).toBe(403);
    db.database.prepare('INSERT INTO calls (id,business_id,connected_at) VALUES (?,?,CURRENT_TIMESTAMP)').run('call-owner', 'biz-owner');
    expect((await call('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'DELETE' })).status).toBe(409);
    expect(db.database.prepare('SELECT id FROM users WHERE id=?').get('owner')).toEqual({ id: 'owner' });
  });

  it('deletes unused browser tickets and rejects their later WebSocket claim', async () => {
    const bootstrap = await (await call('/api/me/bootstrap')).json() as { assistants: { id: string }[] };
    db.database.prepare("INSERT INTO calls(id,business_id,assistant_id,status,channel,browser_claim_required) VALUES ('unused-ticket','biz-owner',?,'active','web',1)").run(bootstrap.assistants[0].id);
    expect((await call('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'DELETE' })).status).toBe(200);
    expect(db.database.prepare("SELECT id FROM calls WHERE id='unused-ticket'").get()).toBeUndefined();
    const upgrade = await worker.fetch(new Request('https://openfon.test/ws/call/unused-ticket', { headers: { Upgrade: 'websocket' } }), env, fakeCtx);
    expect(upgrade.status).toBe(404);
    expect(db.database.prepare("SELECT id FROM users WHERE id='other'").get()).toEqual({ id: 'other' });
  });

  it('atomically refuses deletion if a browser ticket connects before the delete', async () => {
    const bootstrap = await (await call('/api/me/bootstrap')).json() as { assistants: { id: string }[] };
    db.database.prepare("INSERT INTO calls(id,business_id,assistant_id,status,channel,browser_claim_required) VALUES ('racing-ticket','biz-owner',?,'active','web',1)").run(bootstrap.assistants[0].id);
    let raced = false;
    db.hook = sql => {
      if (raced || !sql.startsWith('DELETE FROM users')) return;
      raced = true;
      db.database.prepare("UPDATE calls SET connected_at=datetime('now') WHERE id='racing-ticket'").run();
    };
    expect((await call('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'DELETE' })).status).toBe(409);
    expect(db.database.prepare("SELECT id FROM users WHERE id='owner'").get()).toEqual({ id: 'owner' });
  });

  it('rejects a held WebSocket lookup whose ticket is deleted before its claim', async () => {
    const bootstrap = await (await call('/api/me/bootstrap')).json() as { assistants: { id: string }[] };
    db.database.prepare("UPDATE assistants SET name='Claim race',persona='Synthetic claim race',language='en',state='active' WHERE id=?").run(bootstrap.assistants[0].id);
    db.database.prepare("INSERT INTO calls(id,business_id,assistant_id,status,channel,browser_claim_required) VALUES ('held-ticket','biz-owner',?,'active','web',1)").run(bootstrap.assistants[0].id);
    let lookedUp!: () => void;
    let release!: () => void;
    const observed = new Promise<void>(resolve => { lookedUp = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.includes('SELECT calls.id, calls.business_id, calls.assistant_id')) {
        const first = statement.first.bind(statement);
        statement.first = async <T>() => {
          const row = await first<T>();
          lookedUp();
          await held;
          return row;
        };
      }
      return statement;
    });
    const dispatch = vi.spyOn(env.CALL_SESSION, 'get');
    const upgrade = worker.fetch(new Request('https://openfon.test/ws/call/held-ticket', { headers: { Upgrade: 'websocket' } }), env, fakeCtx);
    await observed;
    try {
      expect((await call('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'DELETE' })).status).toBe(200);
    } finally { release(); }
    expect((await upgrade).status).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();
    expect(db.database.prepare("SELECT id FROM calls WHERE id='held-ticket'").get()).toBeUndefined();
  });

  it('refuses pre-claim live sessions after migration and bootstrap backfill', async () => {
    db.database.prepare("INSERT INTO calls(id,business_id,status,channel) VALUES ('old-live','biz-owner','active','web')").run();
    applyMigrations(db, 8, 20);
    expect((await call('/api/me/bootstrap')).status).toBe(200);
    const row = db.database.prepare("SELECT assistant_id,connected_at,browser_claim_required FROM calls WHERE id='old-live'").get();
    expect(row?.assistant_id).not.toBeNull();
    expect(row?.connected_at).toBeNull();
    expect(row?.browser_claim_required).toBe(0);
    expect((await call('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'DELETE' })).status).toBe(409);
  });

  it('refuses ambiguous legacy sessions before their first turn', async () => {
    db.database.prepare("INSERT INTO calls(id,business_id,status,channel) VALUES ('legacy-web','biz-owner','active','web')").run();
    expect((await call('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'DELETE' })).status).toBe(409);
  });

  it('refuses NULL-connected calls with saved conversation evidence', async () => {
    const bootstrap = await (await call('/api/me/bootstrap')).json() as { assistants: { id: string }[] };
    db.database.prepare("INSERT INTO calls(id,business_id,assistant_id,status,channel,browser_claim_required) VALUES ('saved-turn','biz-owner',?,'active','web',1)").run(bootstrap.assistants[0].id);
    db.database.prepare("INSERT INTO call_turns(call_id,role,text) VALUES ('saved-turn','caller','Already talking')").run();
    expect((await call('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'DELETE' })).status).toBe(409);
  });

  it('retains the safety refusal for unconnected non-browser calls', async () => {
    db.database.prepare("INSERT INTO calls(id,business_id,status,channel) VALUES ('legacy-carrier','biz-owner','active','twilio')").run();
    expect((await call('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'DELETE' })).status).toBe(409);
  });

  it('atomically blocks deletion when a carrier reservation races the account request', async () => {
    let raced = false;
    db.hook = sql => {
      if (raced || !sql.startsWith('DELETE FROM users')) return;
      raced = true;
      db.database.prepare("INSERT INTO calls(id,business_id,status,channel,reserved_at) VALUES ('carrier','biz-owner','completed','telnyx',datetime('now'))").run();
    };
    expect((await call('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'DELETE' })).status).toBe(409);
    expect(db.database.prepare("SELECT id FROM users WHERE id='owner'").get()).toEqual({ id: 'owner' });
    db.database.prepare("UPDATE calls SET carrier_released_at=datetime('now') WHERE id='carrier'").run();
    expect((await call('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'DELETE' })).status).toBe(200);
  });

  it('models D1 cascade change counts separately from direct deleted rows', async () => {
    const result = await db.prepare('DELETE FROM users WHERE id=?').bind('other').run();
    // The user, workspace, and session are three changes for one deleted owner.
    expect(result.meta.changes).toBe(3);
  });

  it('cascades deletion through owned data and preserves another account', async () => {
    // Bootstrap creates the actual foundation graph: assistant, provider,
    // compatibility snapshots, and default knowledge collection.
    expect((await call('/api/me/bootstrap')).status).toBe(200);
    db.database.prepare('INSERT INTO calls (id,business_id,status) VALUES (?,?,?)').run('call-owner', 'biz-owner', 'completed');
    db.database.prepare('INSERT INTO call_turns (call_id,role,text) VALUES (?,?,?)').run('call-owner', 'caller', 'My question');
    const response = await call('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'DELETE' });
    expect(response.status).toBe(200);
    for (const table of ['calls', 'call_turns', 'assistants', 'agent_settings', 'provider_settings', 'compatibility_sync_state', 'knowledge_collections']) {
      expect(db.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(db.database.prepare('SELECT id FROM businesses').all()).toEqual([{ id: 'biz-other' }]);
    expect(db.database.prepare('SELECT id FROM users').all()).toEqual([{ id: 'other' }]);
    expect(db.database.prepare('SELECT token FROM sessions').all()).toEqual([{ token: 'other-session' }]);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('bounds sensitive account work before password hashing or exporting', async () => {
    for (let i = 0; i < 10; i++) expect((await call('/api/me/account/export')).status).toBe(200);
    expect((await call('/api/me/account/export')).status).toBe(429);
  });

  it('allows password rotation to revoke a stolen session after its export budget is exhausted', async () => {
    for (let i = 0; i < 10; i++) expect((await call('/api/me/account/export')).status).toBe(200);
    expect((await call('/api/me/account/export')).status).toBe(429);
    const rotated = await call('/api/me/account/password', 'POST', { currentPassword: password, newPassword: 'new-correct-horse' }, 'owner-second-session');
    expect(rotated.status).toBe(200);
    expect((await call('/api/me/account/export')).status).toBe(401);
    expect(db.database.prepare('SELECT count FROM rate_counters WHERE bucket=?').get('account:export:owner')).toEqual({ count: 10 });
  });

  it('keeps HEAD exports and unknown routes from consuming the rotation budget', async () => {
    for (let i = 0; i < 10; i++) expect((await call('/api/me/account/export', 'HEAD')).status).toBe(200);
    expect((await call('/api/me/account/export', 'HEAD')).status).toBe(429);
    for (let i = 0; i < 12; i++) {
      expect((await call('/api/me/account/unknown')).status).toBe(404);
      expect((await call('/api/me/account/export', 'POST')).status).toBe(404);
    }
    expect((await call('/api/me/account/password', 'POST', { currentPassword: password, newPassword: 'new-correct-horse' }, 'owner-second-session')).status).toBe(200);
    expect((await call('/api/me/account/export', 'HEAD')).status).toBe(401);
  });

  it('caps simultaneous password work and releases permits idempotently', () => {
    const budget = new AccountAuthBudget();
    const held = Array.from({ length: 4 }, () => budget.acquire());
    expect(held.every(Boolean)).toBe(true);
    expect(budget.acquire()).toBeNull();
    held[0]!(); held[0]!();
    const next = budget.acquire();
    expect(next).not.toBeNull();
    expect(budget.acquire()).toBeNull();
    for (const release of held) release!();
    next!();
  });

  it('shares CPU admission across account deletion and password rotation', async () => {
    let release!: () => void;
    let observed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fourLookups = new Promise<void>(resolve => { observed = resolve; });
    let lookups = 0;
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql === 'SELECT password_hash FROM users WHERE id=?') {
        const first = statement.first.bind(statement);
        statement.first = async <T>() => {
          const index = ++lookups;
          if (index === 4) observed();
          if (index <= 4) await gate;
          return first<T>();
        };
      }
      return statement;
    });
    const deletion = (token: string) => call('/api/me/account', 'DELETE', { confirmation: 'DELETE', currentPassword: 'wrong' }, token);
    const rotation = (token: string) => call('/api/me/account/password', 'POST', { currentPassword: 'wrong', newPassword: 'new-correct-horse' }, token);
    const held = [deletion('owner-session'), rotation('owner-session'), deletion('other-session'), rotation('other-session')];
    await fourLookups;
    let refusedDeletion: Response;
    let refusedRotation: Response;
    try {
      refusedDeletion = await deletion('owner-session');
      refusedRotation = await rotation('other-session');
    } finally { release(); await Promise.all(held); }
    expect(refusedDeletion!.status).toBe(429);
    expect(refusedDeletion!.headers.get('Retry-After')).toBe('1');
    expect(refusedRotation!.status).toBe(429);
    expect(lookups).toBe(4);
    expect((await deletion('owner-session')).status).toBe(403);
    expect((await rotation('other-session')).status).toBe(403);
  });

  it.each([200, 403, 409, 500])('releases deletion CPU admission after status %i', async status => {
    const release = vi.fn();
    vi.mocked(accountAuthBudget.acquire).mockImplementationOnce(() => release);
    if (status === 409) db.database.prepare("INSERT INTO calls(id,business_id,connected_at) VALUES ('held','biz-owner',CURRENT_TIMESTAMP)").run();
    if (status === 500) db.hook = sql => { if (sql === 'SELECT password_hash FROM users WHERE id=?') throw new Error('synthetic deletion lookup failure'); };
    const response = await call('/api/me/account', 'DELETE', { confirmation: 'DELETE', currentPassword: status === 403 ? 'wrong' : password });
    expect(response.status).toBe(status);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases password admission after database lookup failures', async () => {
    db.hook = sql => { if (sql === 'SELECT password_hash FROM users WHERE id=?') throw new Error('synthetic lookup failure'); };
    for (let i = 0; i < 4; i++) expect((await call('/api/me/account/password', 'POST', { currentPassword: password, newPassword: 'new-correct-horse' })).status).toBe(500);
    db.hook = null;
    expect((await call('/api/me/account/password', 'POST', { currentPassword: password, newPassword: 'new-correct-horse' })).status).toBe(200);
  });

  it('bounds KDF starts briefly without persisting an account lockout', async () => {
    for (let i = 0; i < 16; i++) expect((await call('/api/me/account/password', 'POST', { currentPassword: 'wrong', newPassword: 'new-correct-horse' })).status).toBe(403);
    expect((await call('/api/me/account/password', 'POST', { currentPassword: 'wrong', newPassword: 'new-correct-horse' })).status).toBe(429);
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM rate_counters WHERE bucket LIKE 'account:%'").get()).toEqual({ n: 0 });
    vi.setSystemTime(new Date(Date.now() + 500));
    expect((await call('/api/me/account/password', 'POST', { currentPassword: password, newPassword: 'new-correct-horse' })).status).toBe(200);
  });

  it('does not let exhausted deletion quota block password rotation', async () => {
    for (let i = 0; i < 10; i++) expect((await call('/api/me/account', 'DELETE', { currentPassword: 'wrong', confirmation: 'DELETE' })).status).toBe(403);
    expect((await call('/api/me/account', 'DELETE', { currentPassword: 'wrong', confirmation: 'DELETE' })).status).toBe(429);
    expect((await call('/api/me/account/password', 'POST', { currentPassword: password, newPassword: 'new-correct-horse' })).status).toBe(200);
  });

  it('revokes a stolen session despite ten wrong-password attempts', async () => {
    for (let i = 0; i < 10; i++) expect((await call('/api/me/account/password', 'POST', { currentPassword: 'wrong', newPassword: 'new-correct-horse' })).status).toBe(403);
    const rotated = await call('/api/me/account/password', 'POST', { currentPassword: password, newPassword: 'new-correct-horse' }, 'owner-second-session');
    expect(rotated.status).toBe(200);
    expect((await call('/api/me/account/export')).status).toBe(401);
    expect(rotated.headers.get('set-cookie')).toContain('ofs=');
  });
});
