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
  // A genuine WebSocket upgrade, which is the only thing allowed to claim a slot.
  const attach = (callId: string) => call(`/ws/call/${callId}`, { headers: { Upgrade: 'websocket' } });
  return { db, env, call, start, attach };
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

  it('performs no database write for a request it refuses', async () => {
    const { db, start } = setup();
    // Exhaust both the per-IP call-start allowance (10) and the wider
    // /api/public/* one (60), so everything after this is refused outright.
    for (let i = 0; i < 60; i++) await start();
    const settled = db.rowsWritten;

    for (let i = 0; i < 300; i++) expect((await start()).status).toBe(429);

    // Incrementing a counter that is already over its limit is a write the
    // attacker buys and the operator pays for, unbounded, for as long as they
    // keep going — and when D1's write quota runs out, `consume` itself starts
    // failing and takes every public and login route with it.
    expect(db.rowsWritten).toBe(settled);
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
    const { db, attach, start } = setup();
    db.businesses[0].max_concurrent_calls = 3;

    // Three callers who actually connect their WebSocket.
    for (let i = 0; i < 3; i++) {
      const { callId } = (await (await start()).json()) as { callId: string };
      expect((await attach(callId)).headers.get(UPGRADED)).toBe('1');
    }
    const res = await start();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: expect.stringContaining('All lines are busy') });
  });

  it('enforces the cap at attach too, not only at start', async () => {
    const { db, attach, start } = setup();
    db.businesses[0].max_concurrent_calls = 3;
    // A minute's worth of call ids collected up front, exactly what the burst
    // repro does — turning them into simultaneous Durable Objects must fail.
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(((await (await start()).json()) as { callId: string }).callId);

    const upgraded = [];
    for (const id of ids) if ((await attach(id)).headers.get(UPGRADED)) upgraded.push(id);
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

  it('does not charge the daily budget for rows that were never connected', async () => {
    const { db, start } = setup();
    db.businesses[0].max_calls_per_day = 3;
    // What a swept burst leaves behind — or what an upgrade inherits. These ids
    // can no longer attach and never reached a Durable Object, so they cannot
    // have spent anything the cap exists to bound.
    for (let i = 0; i < 50; i++) {
      db.seedCall({ id: `swept-${i}`, business_id: 'biz1', status: 'abandoned', connected_at: null });
    }
    expect((await start()).status).toBe(200);
  });

  it('still charges the budget for live tickets and for calls that connected', async () => {
    const { db, start } = setup();
    db.businesses[0].max_calls_per_day = 3;
    // An unattached but still-active row is a real reservation someone can
    // redeem; a connected row that was later swept did spend. Both count.
    db.seedCall({ id: 'pending', business_id: 'biz1', status: 'active', connected_at: null });
    db.seedCall({ id: 'was-connected', business_id: 'biz1', status: 'abandoned', connected_at: Date.now() });
    expect((await start()).status).toBe(200);
    const res = await start();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: expect.stringContaining('daily call limit') });
  });

  it('leaves no row behind when the daily cap refuses a call', async () => {
    const { db, start } = setup();
    db.businesses[0].max_calls_per_day = 3;
    for (let i = 0; i < 10; i++) await start();
    // The count is over every row in the rolling day, so a refusal that left its
    // row behind would let the burst block the business with its own rejections.
    expect(db.calls).toHaveLength(3);
  });

  it('keeps counting a long call until the sweep is the thing that releases it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
    const { db, env, attach, start } = setup();
    db.businesses[0].max_concurrent_calls = 1;
    const { callId } = (await (await start()).json()) as { callId: string };
    await attach(callId);

    // Well past any independent window a second mechanism might have used. The
    // count has none of its own, so the slot is still held.
    vi.setSystemTime(new Date('2026-08-01T12:45:00Z'));
    const busy = await start();
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ error: expect.stringContaining('All lines are busy') });

    // Only the sweep releases it, and only once the row is past STALE_CONNECTED.
    vi.setSystemTime(new Date('2026-08-01T13:10:00Z'));
    expect(await sweepStaleCalls(env)).toBe(1);
    expect((await start()).status).toBe(200);
  });
});

describe('GET /ws/call/:callId', () => {
  it('refuses a call id that was never used inside the stale window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
    const { attach, start } = setup();
    const { callId } = (await (await start()).json()) as { callId: string };

    vi.setSystemTime(new Date('2026-08-01T12:20:00Z'));
    expect((await attach(callId)).status).toBe(404);
  });

  it('marks the row connected so the sweeper can tell it apart', async () => {
    const { db, attach, start } = setup();
    const { callId } = (await (await start()).json()) as { callId: string };
    await attach(callId);
    expect(db.calls.find((c) => c.id === callId)?.connected_at).toBeTypeOf('number');
  });

  it('refuses a second attach on a call id that is already connected', async () => {
    const { db, attach, start } = setup();
    const { callId } = (await (await start()).json()) as { callId: string };
    expect((await attach(callId)).headers.get(UPGRADED)).toBe('1');

    // One row, one slot — but two sessions' worth of provider work, counted once
    // against both caps. Refused at the route regardless of what the DO does.
    const second = await attach(callId);
    expect(second.status).toBe(409);
    expect(db.calls.filter((c) => c.connected_at !== null)).toHaveLength(1);
  });

  it('does not label a capacity refusal as an interrupted conversation', async () => {
    const { db, attach, start } = setup();
    db.businesses[0].max_concurrent_calls = 1;
    const a = (await (await start()).json()) as { callId: string };
    const b = (await (await start()).json()) as { callId: string };
    await attach(a.callId);

    expect((await attach(b.callId)).status).toBe(429);
    const refused = db.calls.find((c) => c.id === b.callId);
    // It never reached a Durable Object, so the dashboard must read it as
    // "Never connected", not as a real call that got cut off.
    expect(refused?.status).toBe('abandoned');
    expect(refused?.connected_at).toBeNull();
  });

  it('will not let a plain GET claim a concurrency slot', async () => {
    const { db, call, start } = setup();
    db.businesses[0].max_concurrent_calls = 1;
    const { callId } = (await (await start()).json()) as { callId: string };

    // No Upgrade header. connected_at is what the cap counts, so writing it from
    // a bare GET would make the business look busy for free.
    const res = await call(`/ws/call/${callId}`);
    expect(res.status).toBe(426);
    expect(db.calls.find((c) => c.id === callId)?.connected_at).toBeNull();
    expect((await start()).status).toBe(200);
  });

  it('hands the slot back when the Durable Object cannot be reached at all', async () => {
    const db = new FakeD1();
    db.seedBusiness({ id: 'biz1', slug: 'riverside-dental-1377', max_concurrent_calls: 1 });
    const env = fakeEnv(db);
    // Not an error response — a rejected promise, which is what a DO that fails
    // to start or gets reset mid-handshake produces.
    env.CALL_SESSION = {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async () => { throw new Error('durable object reset'); } }),
    };
    const req = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://openfon.test${path}`, init), env, fakeCtx);
    const body = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'riverside-dental-1377' }) };
    const { callId } = (await (await req('/api/public/call/start', body)).json()) as { callId: string };

    expect((await req(`/ws/call/${callId}`, { headers: { Upgrade: 'websocket' } })).status).toBe(502);
    expect(db.calls.find((c) => c.id === callId)?.connected_at).toBeNull();
    // And the business is not left looking busy.
    expect((await req('/api/public/call/start', body)).status).toBe(200);
  });

  it('hands the slot back when the Durable Object refuses the handshake', async () => {
    const db = new FakeD1();
    db.seedBusiness({ id: 'biz1', slug: 'riverside-dental-1377', max_concurrent_calls: 1 });
    const env = fakeEnv(db);
    env.CALL_SESSION = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(null, { status: 426 }) }) };
    const req = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://openfon.test${path}`, init), env, fakeCtx);
    const { callId } = (await (
      await req('/api/public/call/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'riverside-dental-1377' }),
      })
    ).json()) as { callId: string };

    expect((await req(`/ws/call/${callId}`, { headers: { Upgrade: 'websocket' } })).status).toBe(426);
    expect(db.calls.find((c) => c.id === callId)?.connected_at).toBeNull();
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

  it('ages a connected call from when it connected, not when the row was made', async () => {
    const db = new FakeD1();
    // Attachment is allowed for 15 minutes after creation, so these come apart.
    // 50 minutes into a real conversation — must survive.
    const late = db.seedCall({
      id: 'connected-late',
      business_id: 'biz1',
      started_at: Date.now() - 64 * MINUTE,
      connected_at: Date.now() - 50 * MINUTE,
    });
    expect(await sweepStaleCalls(fakeEnv(db))).toBe(0);
    expect(late.status).toBe('active');
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

  it('reconciles a row an older worker connected, before classifying it', async () => {
    // Pinned: this asserts an exact timestamp, and a live clock ticking between
    // the seed and the assertion makes it fail by a millisecond.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
    const db = new FakeD1();
    // The rollout window `npm run deploy` opens: the migration has already run,
    // then the old worker — which never writes connected_at — serves this call,
    // and the deploy restarting the worker strands it. Classified as-is it takes
    // the never-dialled branch and a real transcript reads "Never connected".
    const row = db.seedCall({
      id: 'served-by-old-worker',
      business_id: 'biz1',
      started_at: Date.now() - 40 * MINUTE,
      connected_at: null,
    });
    db.seedTurn('served-by-old-worker', Date.now() - 39 * MINUTE);
    db.seedTurn('served-by-old-worker', Date.now() - 38 * MINUTE);

    expect(await sweepStaleCalls(fakeEnv(db))).toBe(0);
    expect(row.connected_at).toBe(Date.now() - 39 * MINUTE);
    // Now judged on the connected clock, which has 21 minutes left to run.
    expect(row.status).toBe('active');
  });

  it('retires a reconciled row as interrupted once its connected clock runs out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
    const db = new FakeD1();
    const row = db.seedCall({
      id: 'old-worker-stranded',
      business_id: 'biz1',
      started_at: Date.now() - 95 * MINUTE,
      connected_at: null,
    });
    db.seedTurn('old-worker-stranded', Date.now() - 94 * MINUTE);

    expect(await sweepStaleCalls(fakeEnv(db))).toBe(1);
    expect(row.status).toBe('abandoned');
    // connected_at survives the retirement, so the dashboard reads this as a
    // conversation that was cut off rather than one that never happened.
    expect(row.connected_at).toBe(Date.now() - 94 * MINUTE);
  });

  it('still retires an old row whose connection was released', async () => {
    const db = new FakeD1();
    // A refused handshake clears connected_at, so the row falls back to the
    // never-dialled branch and is aged from started_at again.
    const released = db.seedCall({
      id: 'released',
      business_id: 'biz1',
      started_at: Date.now() - 20 * MINUTE,
      connected_at: null,
    });
    expect(await sweepStaleCalls(fakeEnv(db))).toBe(1);
    expect(released.status).toBe('abandoned');
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

  it('cannot be used to lock an owner out of their own account', async () => {
    const { login } = await withUser();
    // Anyone who knows the address can burn the whole per-email allowance.
    for (let i = 0; i < 5; i++) expect((await login('owner@example.test', `guess-${i}`)).status).toBe(401);
    expect((await login('owner@example.test', 'guess-5')).status).toBe(429);
    // The owner must still get in, and doing so must clear the bucket. Deciding
    // the email limit before verifying the password would make this a permanent
    // lockout, refreshed every window.
    expect((await login('owner@example.test', 'correct-horse-battery')).status).toBe(200);
    expect((await login('owner@example.test', 'oops')).status).toBe(401);
  });

  it('does not let a successful login buy back the per-IP guessing budget', async () => {
    const { db, login } = await withUser();
    // Signup is public, so an attacker always has an account of their own.
    db.users.push({ id: 'u2', email: 'attacker@example.test', password_hash: await hashPassword('their-own-password') });

    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await login(`victim-${i}@example.test`, 'oops')).status);
    // The reset attempt: a correct login to an account they control.
    expect((await login('attacker@example.test', 'their-own-password')).status).toBe(200);
    for (let i = 10; i < 20; i++) codes.push((await login(`victim-${i}@example.test`, 'oops')).status);

    // The success refunds its own reservation, so all 20 guesses land — but not
    // one more. Clearing the bucket instead would reset the ceiling on every
    // successful login and the limiter would never bite.
    expect(codes.filter((s) => s === 401)).toHaveLength(20);
    expect(codes.filter((s) => s === 429)).toHaveLength(0);
    expect((await login('victim-99@example.test', 'oops')).status).toBe(429);
  });

  it('will not let a blocked address mint counter rows with made-up emails', async () => {
    const { db, login } = await withUser();
    for (let i = 0; i < 20; i++) await login(`victim-${i}@example.test`, 'oops');
    const rowsWhenBlocked = db.counters.size;

    // Every one of these is refused on the IP bucket. The email bucket is keyed
    // on whatever the client sends, so reserving it before the IP check let a
    // blocked attacker write a new row per request — costing the operator more
    // than a served user, which is backwards.
    for (let i = 0; i < 50; i++) {
      expect((await login(`throwaway-${i}-${Math.random()}@example.test`, 'x')).status).toBe(429);
    }
    expect(db.counters.size).toBe(rowsWhenBlocked);
  });

  it('refunds into the window the reservation came from, not the one it landed in', async () => {
    vi.useFakeTimers();
    // 100 ms before a 15-minute boundary. PBKDF2 takes longer than that, so a
    // login started here finishes in the next window.
    vi.setSystemTime(new Date('2026-08-01T12:14:59.900Z'));
    const { db, login } = await withUser();
    const oldWindow = Date.parse('2026-08-01T12:00:00Z') / 1000;
    const newWindow = Date.parse('2026-08-01T12:15:00Z') / 1000;
    // Someone else is already using the next window.
    db.counters.set(`lgip:local|${newWindow}`, 3);

    // Cross the boundary between the reservation and the refund.
    db.hook = (sql) => {
      if (sql.startsWith('SELECT id, password_hash')) vi.setSystemTime(new Date('2026-08-01T12:15:00.100Z'));
    };
    expect((await login('owner@example.test', 'correct-horse-battery')).status).toBe(200);
    db.hook = null;

    // The reservation was taken from the old window, so that is where it goes
    // back. Recomputing the window would leave the old one stuck at 1 — a
    // penalty the user earned back — and take the stranger's new window to 2.
    expect(db.counters.get(`lgip:local|${oldWindow}`)).toBe(0);
    expect(db.counters.get(`lgip:local|${newWindow}`)).toBe(3);
  });

  it('does not spend an office’s allowance on people who signed in fine', async () => {
    const { login } = await withUser();
    // Twenty successful sign-ins in a window must not exhaust a shared IP.
    for (let i = 0; i < 20; i++) {
      expect((await login('owner@example.test', 'correct-horse-battery')).status).toBe(200);
    }
    expect((await login('owner@example.test', 'oops')).status).toBe(401);
  });

  it('stops guessing at the per-IP limit even across many addresses', async () => {
    const { login } = await withUser();
    // Rotating the target email dodges the per-email bucket; the per-IP one is
    // what bounds how much PBKDF2 a single source can demand.
    const codes: number[] = [];
    for (let i = 0; i < 24; i++) codes.push((await login(`victim-${i}@example.test`, 'oops')).status);
    expect(codes.filter((s) => s === 401)).toHaveLength(20);
    expect(codes.filter((s) => s === 429)).toHaveLength(4);
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
    // The minimum, not the median: scheduling noise on a shared CI runner only
    // ever adds time, so the fastest observation is the closest estimate of what
    // the branch actually costs — and the only estimator here that does not drift
    // with load. The distinguishing signal is large (a whole PBKDF2, ~2.3x before
    // the dummy verify), so a wide band still fails loudly if the branch returns.
    const fastest = (xs: number[]) => Math.min(...xs);
    const ratio = fastest(hit) / fastest(miss);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });
});
