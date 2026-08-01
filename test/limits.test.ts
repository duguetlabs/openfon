import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { sweepStaleCalls } from '../src/index';
import { FakeD1, UPGRADED, fakeCtx, fakeEnv } from './fake-d1';
import { hashPassword } from '../src/auth';

const MINUTE = 60_000;

function setup() {
  const db = new FakeD1();
  db.seedBusiness({ id: 'biz1', slug: 'riverside-dental-1377' });
  const env = fakeEnv(db);
  const call = (path: string, init?: RequestInit) =>
    worker.fetch(new Request(`https://openfon.test${path}`, init), env, fakeCtx);
  const start = (slug = 'riverside-dental-1377') =>
    call('/api/public/call/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
  return { db, env, call, start };
}

afterEach(() => {
  vi.useRealTimers();
});

// The measured attack: 53.8 unauthenticated call rows/sec from one IP, 571 rows
// in a ten-second burst, 0 rejected. Same shape as scratchpad/repro/p0-2-uncapped-calls.mjs.
describe('POST /api/public/call/start burst', () => {
  it('rejects everything past the per-IP allowance', async () => {
    const { db, start } = setup();
    const codes: number[] = [];
    for (let i = 0; i < 100; i++) codes.push((await start()).status);

    expect(codes.filter((s) => s === 200)).toHaveLength(10); // LIMITS.callStart.max
    expect(codes.filter((s) => s === 429)).toHaveLength(90);
    expect(db.calls).toHaveLength(10); // and only those ten rows reached D1
  });

  it('answers 429 with a Retry-After the widget can honour', async () => {
    const { start } = setup();
    for (let i = 0; i < 10; i++) await start();
    const res = await start();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.json()).toEqual({ error: expect.stringContaining('Too many calls') });
  });

  it('lets the allowance recover when the window rolls over', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
    const { start } = setup();
    for (let i = 0; i < 10; i++) await start();
    expect((await start()).status).toBe(429);

    vi.setSystemTime(new Date('2026-08-01T12:01:30Z'));
    expect((await start()).status).toBe(200);
  });

  it('does not punish a caller who reloads the widget a few times', async () => {
    const { start } = setup();
    for (let i = 0; i < 5; i++) expect((await start()).status).toBe(200);
  });
});

describe('per-business call caps', () => {
  it('turns callers away once the concurrency cap is reached', async () => {
    const { db, call, start } = setup();
    db.businesses[0].max_concurrent_calls = 3;

    // Three callers who actually connect their WebSocket.
    for (let i = 0; i < 3; i++) {
      const { callId } = (await (await start()).json()) as { callId: string };
      expect((await call(`/ws/call/${callId}`)).headers.get(UPGRADED)).toBe('1');
    }
    const res = await start();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: expect.stringContaining('All lines are busy') });
  });

  it('enforces the cap at attach too, not only at start', async () => {
    const { db, call, start } = setup();
    db.businesses[0].max_concurrent_calls = 3;
    // A minute's worth of call ids collected up front, exactly what the burst
    // repro does — turning them into simultaneous Durable Objects must fail.
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(((await (await start()).json()) as { callId: string }).callId);

    const upgraded = [];
    for (const id of ids) if ((await call(`/ws/call/${id}`)).headers.get(UPGRADED)) upgraded.push(id);
    expect(upgraded).toHaveLength(3);
  });

  it('does not count rows that never opened a WebSocket', async () => {
    const { db, start } = setup();
    db.businesses[0].max_concurrent_calls = 3;
    // A caller reloading the widget leaves unconnected rows behind; they must
    // not consume the business's own concurrency budget.
    for (let i = 0; i < 5; i++) await start();
    expect((await start()).status).toBe(200);
  });

  it('stops at the daily cap', async () => {
    const { db, start } = setup();
    db.businesses[0].max_calls_per_day = 3;
    for (let i = 0; i < 3; i++) expect((await start()).status).toBe(200);
    const res = await start();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: expect.stringContaining('daily call limit') });
  });
});

describe('GET /ws/call/:callId', () => {
  it('refuses a call id that was never used inside the stale window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
    const { call, start } = setup();
    const { callId } = (await (await start()).json()) as { callId: string };

    vi.setSystemTime(new Date('2026-08-01T12:20:00Z'));
    expect((await call(`/ws/call/${callId}`)).status).toBe(404);
  });

  it('marks the row connected so the sweeper can tell it apart', async () => {
    const { db, call, start } = setup();
    const { callId } = (await (await start()).json()) as { callId: string };
    await call(`/ws/call/${callId}`);
    expect(db.calls.find((c) => c.id === callId)?.connected_at).toBeTypeOf('number');
  });
});

// 567 rows were left status='active' forever in the reproduction. Path (a) never
// instantiates a Durable Object, so only a scheduled pass can retire them.
describe('sweepStaleCalls', () => {
  it('retires rows that were created but never connected', async () => {
    const db = new FakeD1();
    const fresh = db.seedCall({ id: 'fresh', business_id: 'biz1', started_at: Date.now() - 5 * MINUTE });
    const old = db.seedCall({ id: 'old', business_id: 'biz1', started_at: Date.now() - 20 * MINUTE });

    expect(await sweepStaleCalls(fakeEnv(db))).toBe(1);
    expect(old.status).toBe('abandoned');
    expect(old.ended_at).toBeTypeOf('number');
    expect(fresh.status).toBe('active');
  });

  it('never cuts off a long call that is still connected', async () => {
    const db = new FakeD1();
    const live = db.seedCall({
      id: 'live',
      business_id: 'biz1',
      started_at: Date.now() - 20 * MINUTE,
      connected_at: Date.now() - 20 * MINUTE,
    });
    expect(await sweepStaleCalls(fakeEnv(db))).toBe(0);
    expect(live.status).toBe('active');
  });

  it('retires a connected call stranded by a worker restart', async () => {
    const db = new FakeD1();
    const stranded = db.seedCall({
      id: 'deploy-victim',
      business_id: 'biz1',
      started_at: Date.now() - 90 * MINUTE,
      connected_at: Date.now() - 90 * MINUTE,
    });
    expect(await sweepStaleCalls(fakeEnv(db))).toBe(1);
    expect(stranded.status).toBe('abandoned');
  });

  it('prunes counter windows so the table cannot grow without bound', async () => {
    const db = new FakeD1();
    const nowSec = Math.floor(Date.now() / 1000);
    db.counters.set(`start:1.2.3.4|${nowSec - 200_000}`, 9);
    db.counters.set(`start:1.2.3.4|${nowSec - 60}`, 2);
    await sweepStaleCalls(fakeEnv(db));
    expect(db.counters.size).toBe(1);
  });

  it('runs from the scheduled handler', async () => {
    const db = new FakeD1();
    db.seedCall({ id: 'old', business_id: 'biz1', started_at: Date.now() - 20 * MINUTE });
    const waits: Promise<unknown>[] = [];
    worker.scheduled!({} as any, fakeEnv(db), { waitUntil: (p: Promise<unknown>) => waits.push(p) } as any);
    await Promise.all(waits);
    expect(db.calls[0].status).toBe('abandoned');
  });
});

describe('POST /api/auth/login', () => {
  async function withUser() {
    const { db, call } = setup();
    db.users.push({ id: 'u1', email: 'owner@example.test', password_hash: await hashPassword('correct-horse-battery') });
    const login = (email: string, password: string) =>
      call('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    return { db, login };
  }

  it('throttles a password-guessing run against one account', async () => {
    const { login } = await withUser();
    for (let i = 0; i < 5; i++) expect((await login('owner@example.test', `guess-${i}`)).status).toBe(401);
    const blocked = await login('owner@example.test', 'guess-5');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('900');
  });

  it('forgets the failures as soon as the owner gets it right', async () => {
    const { login } = await withUser();
    for (let i = 0; i < 4; i++) await login('owner@example.test', 'oops');
    expect((await login('owner@example.test', 'correct-horse-battery')).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login('owner@example.test', 'oops')).status).toBe(401);
  });

  it('spends the same work on a missing account as on a real one', async () => {
    const { login } = await withUser();
    const time = async (email: string) => {
      const t0 = performance.now();
      await login(email, 'wrong-password-on-purpose');
      return performance.now() - t0;
    };
    const hit: number[] = [];
    const miss: number[] = [];
    // Interleaved, and only 4 each so the per-email limiter never trips.
    for (let i = 0; i < 4; i++) {
      hit.push(await time('owner@example.test'));
      miss.push(await time(`nobody-${i}@example.test`));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    // Was 2.3x before the dummy verify; both branches now run one PBKDF2.
    const ratio = median(hit) / median(miss);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.7);
  });
});
