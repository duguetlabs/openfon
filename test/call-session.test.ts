// Regression tests for the CallSession lifecycle bugs, ported from the manual
// repro scripts that reproduced each one against a live wrangler dev instance.
//
// @cloudflare/vitest-pool-workers is not a dependency, so these drive the real
// CallSession class against hand-written fakes for the handful of runtime
// globals it touches (WebSocketPair, Response, WebSocket) plus D1 and DO
// storage. That covers the socket state machine, which is where the bugs were.
// See the file footer for what this approach does NOT cover.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallSession } from '../src/call-session';
import type { Env } from '../src/types';

// ---------- fakes ----------

class FakeSocket {
  readyState = 1; // OPEN
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};

  accept(): void {}
  send(data: unknown): void {
    if (this.readyState !== 1) throw new Error('socket closed');
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit('close', { code, reason });
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, ev: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }

  // test helpers
  messages(): { type: string; [k: string]: unknown }[] {
    return this.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s as string));
  }
  typesSent(): string[] {
    return this.messages().map((m) => m.type);
  }
  countOf(type: string): number {
    return this.typesSent().filter((t) => t === type).length;
  }
  receive(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) });
  }
}

class FakeStorage {
  map = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrEntries === 'string') this.map.set(keyOrEntries, value);
    else for (const [k, v] of Object.entries(keyOrEntries)) this.map.set(k, v);
  }
  async deleteAll(): Promise<void> {
    this.map.clear();
  }
  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

const CALL_ROW = { id: 'call-1', business_id: 'biz-1', status: 'active', started_at: '2026-08-01 12:00:00' };
const BIZ_ROW = {
  id: 'biz-1', user_id: 'u1', slug: 'riverside-dental', name: 'Riverside Dental',
  description: '', address: '', phone: '', website: '', timezone: 'Europe/Vienna',
  hours_json: '[]', services_json: '[]', faqs_json: '[]', closures_json: '[]',
};
const SETTINGS_ROW = {
  business_id: 'biz-1', agent_name: 'Alex', greeting: '', persona: 'friendly',
  language: 'en', voice: '', take_messages: 1, custom_instructions: '',
  llm_base_url: '', llm_api_key: '', llm_model: '', engine: 'pipeline',
  realtime_model: '', realtime_voice: '',
};

function fakeDb(engine: 'pipeline' | 'realtime' = 'pipeline') {
  const writes: { sql: string; args: unknown[] }[] = [];
  const ctl = { failUpdates: false }; // lets a test force a transient D1 failure
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes('FROM calls')) return CALL_ROW;
              if (sql.includes('FROM businesses')) return BIZ_ROW;
              if (sql.includes('FROM agent_settings')) return { ...SETTINGS_ROW, engine };
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (ctl.failUpdates && sql.includes('UPDATE calls')) throw new Error('D1 unavailable');
              writes.push({ sql, args });
              return {};
            },
          };
        },
      };
    },
  };
  return {
    db,
    writes,
    ctl,
    turnWrites: () => writes.filter((w) => w.sql.includes('INSERT INTO call_turns')),
    callUpdates: () => writes.filter((w) => w.sql.includes('UPDATE calls')),
  };
}

function fakeEnv(db: unknown): Env {
  return {
    DB: db,
    ASSETS: {},
    CALL_SESSION: {},
    DEFAULT_LLM_BASE_URL: 'http://stub.invalid/v1',
    DEFAULT_LLM_MODEL: 'test-model',
    DEFAULT_STT_BASE_URL: 'http://stub.invalid/v1',
    DEFAULT_STT_MODEL: 'test-stt',
    DEFAULT_TTS_PROVIDER: 'browser', // keeps synthesize() from touching the network
    AZURE_SPEECH_REGION: 'westeurope',
    DEFAULT_TTS_VOICE: 'en-US-AvaMultilingualNeural',
    REALTIME_BASE_URL: 'ws://stub.invalid/v1/realtime',
    REALTIME_MODEL: 'kataleptic-realtime-hd', // HD: no voice-catalog fetch on connect
  } as unknown as Env;
}

const upgradeRequest = () =>
  ({
    url: 'https://example.test/ws/call/call-1?call=call-1',
    headers: { get: (h: string) => (h === 'Upgrade' ? 'websocket' : null) },
  }) as unknown as Request;

/**
 * Let queued promise callbacks run. Microtasks only — a setTimeout here would
 * deadlock the fake-timer tests, and every fake in this file resolves
 * synchronously, so there is nothing on the macrotask queue to wait for.
 */
const flush = async (rounds = 24) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

// ---------- global stubs ----------

let serverSockets: FakeSocket[] = [];
let upstreamSockets: FakeSocket[] = [];
const realGlobals: Record<string, unknown> = {};

beforeEach(() => {
  serverSockets = [];
  upstreamSockets = [];
  for (const k of ['WebSocketPair', 'Response', 'WebSocket', 'fetch']) realGlobals[k] = (globalThis as never)[k];

  (globalThis as never).WebSocketPair = function () {
    const client = new FakeSocket();
    const server = new FakeSocket();
    serverSockets.push(server);
    return { 0: client, 1: server };
  };
  // undici's Response rejects status 101, which is exactly what the upgrade
  // path returns. Only .status and .webSocket are read by the code under test.
  (globalThis as never).Response = class {
    constructor(
      public body: unknown,
      public init: { status?: number; webSocket?: unknown } = {}
    ) {}
    get status() {
      return this.init.status ?? 200;
    }
    get webSocket() {
      return this.init.webSocket ?? null;
    }
  };
  (globalThis as never).WebSocket = function () {
    const ws = new FakeSocket();
    upstreamSockets.push(ws);
    return ws;
  };
  // Any real network call in these tests is a bug in the test, not a pass.
  (globalThis as never).fetch = () => {
    throw new Error('no network in unit tests');
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(realGlobals)) (globalThis as never)[k] = v;
  vi.useRealTimers();
});

function newSession(engine: 'pipeline' | 'realtime' = 'pipeline') {
  const { db, ctl, turnWrites, callUpdates } = fakeDb(engine);
  const storage = new FakeStorage();
  const state = { storage } as unknown as DurableObjectState;
  const session = new CallSession(state, fakeEnv(db));
  return { session, storage, ctl, turnWrites, callUpdates };
}

// ---------- tests ----------

describe('second attach to a live call', () => {
  it('is refused, so the first caller keeps the stream', async () => {
    const { session } = newSession();
    const first = await session.fetch(upgradeRequest());
    expect(first.status).toBe(101);

    const second = await session.fetch(upgradeRequest());
    // Previously this returned 101 and replaced this.ws: the newcomer received
    // the original caller's transcripts and audio while they heard nothing.
    expect(second.status).toBe(409);
    expect(serverSockets).toHaveLength(1);

    // The original socket is still the one being served.
    serverSockets[0].receive({ type: 'start' });
    await flush();
    expect(serverSockets[0].countOf('ready')).toBe(1);
  });

  it('allows a fresh attach once the previous socket has closed', async () => {
    const { session } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].readyState = 3; // caller hung up / dropped
    const again = await session.fetch(upgradeRequest());
    expect(again.status).toBe(101);
  });

  it('does not let a superseded socket finalize the call that replaced it', async () => {
    // A socket still CLOSING does not block a new attach, so its close event
    // arrives after this.ws has moved on. Unscoped, that event tore down the
    // new caller's call.
    const { session, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    const stale = serverSockets[0];
    stale.readyState = 2; // CLOSING

    const second = await session.fetch(upgradeRequest());
    expect(second.status).toBe(101);
    const fresh = serverSockets[1];

    stale.close(1006, 'late close of the old socket');
    await flush();

    expect(fresh.readyState).toBe(1); // still connected
    expect(fresh.typesSent()).not.toContain('ended');
    expect(callUpdates()).toHaveLength(0); // call was not finalized
  });
});

describe('handleStart idempotency', () => {
  it('answers once no matter how many start messages arrive', async () => {
    const { session, turnWrites } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    for (let i = 0; i < 3; i++) {
      sock.receive({ type: 'start' });
      await flush();
    }

    // Was 3 ready frames and 3 identical agent greeting rows.
    expect(sock.countOf('ready')).toBe(1);
    expect(turnWrites()).toHaveLength(1);
    expect(turnWrites()[0].args).toContain('agent');
  });
});

describe('finalize closes attached sockets', () => {
  it('sends ended and actually closes, instead of going silently deaf', async () => {
    const { session } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];
    sock.receive({ type: 'start' });
    await flush();

    sock.receive({ type: 'hangup' });
    await flush();

    expect(sock.typesSent()).toContain('ended');
    // The bug: socket stayed OPEN while `ended` dropped every later message,
    // so the caller just heard the agent stop with no error and no hangup.
    expect(sock.readyState).toBe(3);
    expect(sock.closed?.code).toBe(1000);
  });

  it('clears the watchdog alarm when the call ends', async () => {
    const { session, storage } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();
    expect(storage.alarmAt).not.toBeNull(); // armed on start

    serverSockets[0].receive({ type: 'hangup' });
    await flush();
    expect(storage.alarmAt).toBeNull();
    expect(storage.map.size).toBe(0);
  });
});

describe('upstream connect timeout', () => {
  it('closes the abandoned socket and ignores it if it opens late', async () => {
    vi.useFakeTimers();
    const { session } = newSession('realtime');
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    sock.receive({ type: 'start' });
    await vi.advanceTimersByTimeAsync(6000); // past the 5 s connect timeout
    await flush();

    expect(upstreamSockets).toHaveLength(1);
    const zombie = upstreamSockets[0];
    expect(zombie.closed).not.toBeNull(); // was left open and still in this.upstream

    // The call fell back to pipeline, which is what the client was told.
    const ready = sock.messages().find((m) => m.type === 'ready');
    expect(ready?.mode).toBe('pipeline');

    // A late open must not push session.update at an engine we abandoned...
    zombie.readyState = 1;
    zombie.emit('open', {});
    await flush();
    expect(zombie.sent).toHaveLength(0);

    // ...and its audio must not reach a client now decoding MP3.
    const before = sock.sent.length;
    zombie.emit('message', {
      data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAAA' }),
    });
    await flush();
    expect(sock.sent).toHaveLength(before);
  });
});

describe('upstream recovery', () => {
  it('still reconnects when an established socket errors before closing', async () => {
    // Sockets routinely fire `error` immediately before `close`. Treating that
    // as "never became usable" cleared this.upstream and made the close
    // listener's ownership guard false, silently killing the reconnect.
    vi.useFakeTimers();
    const { session } = newSession('realtime');
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    sock.receive({ type: 'start' });
    await flush();
    upstreamSockets[0].emit('open', {});
    await flush();
    expect(sock.messages().find((m) => m.type === 'ready')?.mode).toBe('realtime');

    upstreamSockets[0].emit('error', {}); // error, then close — the usual pair
    upstreamSockets[0].close(1006, 'engine dropped');
    await flush();

    expect(upstreamSockets.length).toBe(2); // recovery actually ran
  });

  it('is bounded and finalizes rather than spawning orphan connections', async () => {
    vi.useFakeTimers();
    const { session } = newSession('realtime');
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    const started = (async () => sock.receive({ type: 'start' }))();
    await flush();
    upstreamSockets[0].emit('open', {}); // engine connects
    await started;
    await flush();
    expect(sock.messages().find((m) => m.type === 'ready')?.mode).toBe('realtime');

    // Engine drops. Recovery retries once; that retry also times out.
    upstreamSockets[0].close(1006, 'engine gone');
    await vi.advanceTimersByTimeAsync(6000);
    await flush();

    // One retry only — the close listener and the failed connect used to each
    // start their own recovery, leaving an orphan socket nobody closed.
    expect(upstreamSockets.length).toBeLessThanOrEqual(2);
    for (const u of upstreamSockets) expect(u.readyState).toBe(3);
    expect(sock.typesSent()).toContain('error');
    expect(sock.readyState).toBe(3); // call finalized, socket closed
  });
});

describe('watchdog alarm', () => {
  it('finalizes a call whose client vanished without a close frame', async () => {
    vi.useFakeTimers();
    const { session, storage } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    // The socket is still open but nothing has arrived on it — not even the
    // 20 s keepalive ping — which is what a dropped network looks like.
    vi.setSystemTime(Date.now() + 200_000);
    await session.alarm();
    await flush();

    expect(storage.alarmAt).toBeNull();
    expect(serverSockets[0].readyState).toBe(3);
    expect(serverSockets[0].typesSent()).toContain('ended');
  });

  it('reschedules itself while the call is still active', async () => {
    const { session, storage } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    const armedAt = storage.alarmAt;
    await session.alarm(); // recent activity -> keep going
    expect(storage.alarmAt).not.toBeNull();
    expect(storage.alarmAt).toBeGreaterThanOrEqual(armedAt as number);
    expect(serverSockets[0].readyState).toBe(1);
  });

  it('recovers the call id from storage after an eviction', async () => {
    // A fresh instance whose in-memory fields are gone still has to finalize.
    const { session, storage } = newSession();
    storage.map.set('callId', 'call-1');
    storage.map.set('hardDeadline', Date.now() - 1000); // past the wall-clock cap
    storage.map.set('lastActivity', Date.now());

    await session.alarm();
    expect(storage.alarmAt).toBeNull();
  });

  it('does nothing when there is no call to reconcile', async () => {
    const { session, storage } = newSession();
    await session.alarm();
    expect(storage.alarmAt).toBeNull();
  });

  it('keeps the watchdog armed when the call row fails to write', async () => {
    vi.useFakeTimers();
    const { session, storage, ctl, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    ctl.failUpdates = true; // transient D1 outage
    vi.setSystemTime(Date.now() + 200_000);
    await expect(session.alarm()).rejects.toThrow('D1 unavailable');

    // Clearing the watchdog before the write landed would strand the row as
    // 'active' with nothing left to reclaim it.
    expect(storage.map.get('callId')).toBe('call-1');
    expect(callUpdates()).toHaveLength(0);

    // At-least-once delivery: the retry has to actually complete the call.
    ctl.failUpdates = false;
    await session.alarm();
    expect(callUpdates()).toHaveLength(1);
    expect(storage.alarmAt).toBeNull();
    expect(storage.map.size).toBe(0);
  });
});

// NOT COVERED by this file, and worth stating plainly:
//   * Real Workers runtime semantics — DO eviction, hibernation, and whether an
//     alarm survives a deploy. These fakes assert our logic, not the platform's.
//   * The realtime audio path end to end (base64 PCM framing, barge-in flushes).
//   * D1 behaviour: the fake never enforces constraints or returns errors.
//   * The /ws/call/:callId route in src/index.ts, which decides who reaches the
//     DO at all — that guard belongs to the abuse-limits work.
// Closing those needs @cloudflare/vitest-pool-workers and a miniflare D1.
