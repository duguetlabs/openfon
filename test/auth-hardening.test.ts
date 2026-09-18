import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { getUserIdFromSession, hashPassword, verifyPassword } from '../src/auth';
import { FakeD1, fakeCtx, fakeEnv } from './fake-d1';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

const request = (db: FakeD1, path: string, body: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://openfon.test${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
  }), fakeEnv(db), fakeCtx);

describe('authentication input and origin boundaries', () => {
  it.each(['/api/auth/signup', '/api/auth/login'])('rejects malformed credentials before database work at %s', async (path) => {
    const db = new FakeD1();
    const invalid = ['{', 'null', '[]', 'true', JSON.stringify({ email: 123, password: 'password' }),
      JSON.stringify({ email: 'user@example.test', password: ['password'] }),
      JSON.stringify({ email: 'user@example.test', password: 'x'.repeat(1025) })];
    for (const body of invalid) expect((await request(db, path, body)).status).toBe(400);
    expect(db.rowsWritten).toBe(0);
    expect(db.users).toHaveLength(0);
  });

  it('rejects oversized credential payloads before parsing or hashing', async () => {
    const db = new FakeD1();
    const response = await request(db, '/api/auth/signup', JSON.stringify({ email: 'user@example.test', password: 'x'.repeat(17_000) }));
    expect(response.status).toBe(413);
    expect(db.rowsWritten).toBe(0);
  });

  it.each(['/api/auth/login', '/api/auth/signup', '/api/auth/logout', '/api/me/business'])(
    'rejects cross-origin writes at %s', async (path) => {
      const db = new FakeD1();
      const response = await request(db, path, '{}', { Origin: 'https://untrusted.openfon.test' });
      expect(response.status).toBe(403);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(db.rowsWritten).toBe(0);
    }
  );

  it('accepts same-origin requests and normalizes surrounding email whitespace', async () => {
    const db = new FakeD1();
    const response = await request(db, '/api/auth/signup', JSON.stringify({ email: ' Owner@Example.test ', password: 'correct-horse-battery' }), { Origin: 'https://openfon.test' });
    expect(response.status).toBe(200);
    expect(db.users[0].email).toBe('owner@example.test');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const cookie = response.headers.get('Set-Cookie');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });
});

describe('stored authentication records', () => {
  it.each(['not-a-date', '2026-09-11T12:00:00Z', '2026-09-11T11:59:59Z'])(
    'rejects and removes expired or invalid session timestamp %s', async (expires_at) => {
      const db = new FakeD1();
      db.sessions.push({ token: 'session', user_id: 'owner', expires_at });
      expect(await getUserIdFromSession(fakeEnv(db), 'session')).toBeNull();
      expect(db.sessions).toHaveLength(0);
    }
  );

  it('accepts a valid unexpired session', async () => {
    const db = new FakeD1();
    db.sessions.push({ token: 'session', user_id: 'owner', expires_at: '2026-09-11T12:00:01Z' });
    expect(await getUserIdFromSession(fakeEnv(db), 'session')).toBe('owner');
  });

  it('fails closed on malformed password records and verifies existing hashes', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('correct-horse-battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    for (const malformed of ['invalid:%%%%', 'YQ==:Yg==', `${hash}:extra`, '']) {
      expect(await verifyPassword('password', malformed)).toBe(false);
    }
  });
});
