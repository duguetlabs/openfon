import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
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
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
  db = new SqliteD1();
  applyMigrations(db);
  env = { ...fakeEnv(), DB: db as unknown as D1Database };
  oldHash = await hashPassword(password);
  for (const id of ['owner', 'other']) {
    db.database.prepare('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)').run(id, `${id}@example.test`, oldHash);
    db.database.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(`${id}-session`, id, '2026-10-11T12:00:00.000Z');
    db.database.prepare('INSERT INTO businesses (id,user_id,slug,name) VALUES (?,?,?,?)').run(`biz-${id}`, id, id, id);
  }
  db.database.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('owner-second-session', 'owner', '2026-10-11T12:00:00.000Z');
});
afterEach(() => { db.close(); vi.useRealTimers(); });

describe('account self service', () => {
  it('requires authentication for export and mutations', async () => {
    expect((await call('/api/me/account/export', 'GET', undefined, 'invalid')).status).toBe(401);
    expect((await call('/api/me/account', 'DELETE', { confirmation: 'DELETE', currentPassword: password }, 'invalid')).status).toBe(401);
  });

  it('changes the password and revokes other sessions while preserving the caller', async () => {
    expect((await call('/api/me/account/password', 'POST', { currentPassword: password, newPassword: 'new-correct-horse' })).status).toBe(200);
    const row = db.database.prepare('SELECT password_hash FROM users WHERE id=?').get('owner') as { password_hash: string };
    expect(await verifyPassword('new-correct-horse', row.password_hash)).toBe(true);
    expect(db.database.prepare('SELECT token FROM sessions ORDER BY token').all()).toEqual([{ token: 'other-session' }, { token: 'owner-session' }]);
    // An in-flight login which verified before the password change cannot
    // restore a session for the previous credential after revocation.
    expect(await createVerifiedSession(env, 'owner', oldHash)).toBeNull();
    expect(await createVerifiedSession(env, 'owner', row.password_hash)).toBeTypeOf('string');
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

  it('exports only owned data and excludes credentials and session tokens', async () => {
    db.database.prepare('INSERT INTO agent_settings (business_id,llm_api_key) VALUES (?,?)').run('biz-owner', 'provider-secret');
    db.database.prepare('INSERT INTO engine_profiles (id,business_id,name,llm_api_key) VALUES (?,?,?,?)').run('profile', 'biz-owner', 'Profile', 'profile-secret');
    db.database.prepare('INSERT INTO calls (id,business_id,status) VALUES (?,?,?)').run('call-owner', 'biz-owner', 'completed');
    db.database.prepare('INSERT INTO call_turns (call_id,role,text) VALUES (?,?,?)').run('call-owner', 'caller', 'My question');
    const response = await call('/api/me/account/export');
    expect(response.status).toBe(200);
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
    const assistant = db.database.prepare('INSERT INTO assistants(id,business_id,public_slug,name,persona) VALUES (?,?,?,?,?)');
    const callRow = db.database.prepare('INSERT INTO calls(id,business_id,summary) VALUES (?,?,?)');
    for (let i=0; i<12; i++) {
      assistant.run(`a${i}`, 'biz-owner', `slug${i}`, 'Agent', 'x'.repeat(190000));
      callRow.run(`c${i}`, 'biz-owner', 'y'.repeat(190000));
    }
    db.database.function('json_object', { varargs: true }, () => { throw new Error('Rejected exports must not construct JSON'); });
    const response = await call('/api/me/account/export');
    expect(response.status).toBe(413);
    expect((await response.text()).length).toBeLessThan(1024);
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
    db.database.prepare('INSERT INTO knowledge_collections (id,business_id,name) VALUES (?,?,?)').run('large', 'biz-owner', 'Large notes');
    const insert = db.database.prepare('INSERT INTO knowledge_items (id,business_id,collection_id,kind,content) VALUES (?,?,?, ?,?)');
    for (let i = 0; i < 5; i++) insert.run(`large-${i}`, 'biz-owner', 'large', 'note', 'x'.repeat(1024 * 1024));
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
    db.database.prepare('INSERT INTO calls (id,business_id) VALUES (?,?)').run('call-owner', 'biz-owner');
    expect((await call('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'DELETE' })).status).toBe(409);
    expect(db.database.prepare('SELECT id FROM users WHERE id=?').get('owner')).toEqual({ id: 'owner' });
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
});
