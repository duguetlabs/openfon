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
  const ctl = {
    failUpdates: false, // transient failure writing the finished call row
    failCallReads: false, // transient failure inside loadCall()
    failTurnWrites: false, // transient failure inserting a turn
    turns: [] as { role: string; text: string }[], // rows call_turns should return
    /** Resolve to release a gated loadCall(), letting a test interleave a hangup. */
    gate: null as { promise: Promise<void>; release: () => void } | null,
  };
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes('FROM calls')) {
                // loadCall's read is the one tests gate; finalize's must not block
                if (ctl.gate && sql.includes('status, started_at')) await ctl.gate.promise;
                if (ctl.failCallReads) throw new Error('D1 unavailable');
                return CALL_ROW;
              }
              if (sql.includes('FROM businesses')) return BIZ_ROW;
              if (sql.includes('FROM agent_settings')) return { ...SETTINGS_ROW, engine };
              return null;
            },
            async all() {
              if (sql.includes('FROM call_turns')) return { results: ctl.turns };
              return { results: [] };
            },
            async run() {
              if (ctl.failUpdates && sql.includes('UPDATE calls')) throw new Error('D1 unavailable');
              if (ctl.failTurnWrites && sql.includes('INSERT INTO call_turns')) throw new Error('D1 unavailable');
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
  const backing = fakeDb(engine);
  const storage = new FakeStorage();
  const state = { storage } as unknown as DurableObjectState;
  const session = new CallSession(state, fakeEnv(backing.db));
  const { ctl, turnWrites, callUpdates } = backing;
  /** Rebuild the object on the same storage and D1, as an eviction would. */
  const evictAndRebuild = () => new CallSession(state, fakeEnv(backing.db));
  return { session, storage, ctl, turnWrites, callUpdates, evictAndRebuild };
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

  it('refuses a replacement socket even after the first one closes', async () => {
    // A replacement would be accepted while `starting` is already resolved, so
    // its {type:"start"} returns with no `ready` and the client never begins
    // capturing audio — connected and useless. One socket per call, for life.
    const { session } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    serverSockets[0].readyState = 3; // caller dropped
    const again = await session.fetch(upgradeRequest());
    expect(again.status).toBe(409);
    expect(serverSockets).toHaveLength(1);
  });

  it('refuses a replacement while the first socket is still CLOSING', async () => {
    const { session, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];
    sock.receive({ type: 'start' });
    await flush();
    sock.readyState = 2; // CLOSING, finalization has not run yet

    expect((await session.fetch(upgradeRequest())).status).toBe(409);
    expect(callUpdates()).toHaveLength(0); // the refusal did not end the call

    // The owning socket's own close still finalizes normally.
    sock.readyState = 1;
    sock.close(1006, 'caller dropped');
    await flush();
    expect(callUpdates()).toHaveLength(1);
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

  it('joins starts that arrive together rather than duplicating the attempt', async () => {
    const { session, turnWrites } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    // All three land before the first has finished loading the call.
    sock.receive({ type: 'start' });
    sock.receive({ type: 'start' });
    sock.receive({ type: 'start' });
    await flush();

    expect(sock.countOf('ready')).toBe(1);
    expect(turnWrites()).toHaveLength(1);
  });

  it('lets the caller retry after a start fails transiently', async () => {
    // A latching boolean consumed the caller's only chance: the error surfaced,
    // `started` stayed true, and every later start returned immediately — a
    // permanently dead call on a socket that is still open.
    const { session, ctl } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    ctl.failCallReads = true; // D1 blip inside loadCall()
    sock.receive({ type: 'start' });
    await flush();
    expect(sock.typesSent()).toContain('error');
    expect(sock.countOf('ready')).toBe(0);

    ctl.failCallReads = false;
    sock.receive({ type: 'start' });
    await flush();
    expect(sock.countOf('ready')).toBe(1); // the caller is finally answered
  });

  it('does not re-run startup when a failure happens after ready is sent', async () => {
    // Retrying past this point would redo everything the idempotency guard
    // exists to prevent: a second greeting turn, and in realtime mode a second
    // engine connection with the first never closed.
    const { session, ctl, turnWrites } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    ctl.failTurnWrites = true; // fails in saveTurn(), after `ready` has gone out
    sock.receive({ type: 'start' });
    await flush();
    expect(sock.countOf('ready')).toBe(1);
    expect(sock.typesSent()).toContain('error');

    ctl.failTurnWrites = false;
    sock.receive({ type: 'start' });
    await flush();
    expect(sock.countOf('ready')).toBe(1); // not announced twice
    expect(turnWrites()).toHaveLength(0); // and no duplicate greeting row
  });

  it('abandons startup if the caller hangs up mid-way', async () => {
    // finalize() can complete while runStart() is parked on an await. Resuming
    // would re-arm the watchdog after cleanup and write a greeting turn for an
    // already-completed call.
    const { session, ctl, storage, turnWrites } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    let release!: () => void;
    ctl.gate = { promise: new Promise<void>((r) => (release = r)), release: () => release() };

    sock.receive({ type: 'start' }); // parks inside loadCall()
    await flush();
    sock.receive({ type: 'hangup' }); // caller gives up
    await flush();

    ctl.gate.release();
    await flush();

    expect(sock.countOf('ready')).toBe(0);
    expect(turnWrites()).toHaveLength(0);
    expect(upstreamSockets).toHaveLength(0);
    expect(storage.alarmAt).toBeNull(); // watchdog not re-armed after cleanup
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

  it('sees a stale call as idle when the alarm runs on a rebuilt instance', async () => {
    // The eviction case the watchdog exists for. A Date.now() initializer on
    // `lastActivity` made a rebuilt instance look freshly active, so the idle
    // path never fired and the call survived to the 30 min hard cap — and each
    // tick wrote the refreshed value back, so it never aged either.
    const { session, storage, callUpdates, evictAndRebuild } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    storage.map.set('lastActivity', Date.now() - 200_000);
    await evictAndRebuild().alarm();

    expect(callUpdates()).toHaveLength(1); // finalized on the idle path
    expect(storage.alarmAt).toBeNull();
  });

  it('does not refresh persisted activity from a rebuilt instance', async () => {
    // Rescheduling must carry the stale timestamp forward, or a call that keeps
    // getting evicted between ticks never ages past the idle limit.
    const { session, storage } = newSession();
    storage.map.set('callId', 'call-1');
    storage.map.set('hardDeadline', Date.now() + 600_000);
    const stale = Date.now() - 60_000; // old, but not yet past the idle limit
    storage.map.set('lastActivity', stale);

    await session.alarm();

    expect(storage.alarmAt).not.toBeNull(); // rescheduled, not finalized
    expect(storage.map.get('lastActivity')).toBe(stale); // and not bumped to now
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

  it('summarizes from call_turns when finalizing on a rebuilt instance', async () => {
    // The watchdog exists to prevent data loss, so it must not cause any. A
    // rebuilt object has no in-memory history; without reading the turns back
    // it wrote `completed` with a null summary and null message_json while
    // call_turns held the whole conversation — the caller's message gone, and
    // the dashboard showing a perfectly normal completed call.
    const { session, storage, ctl, callUpdates } = newSession();
    storage.map.set('callId', 'call-1');
    storage.map.set('hardDeadline', Date.now() - 1000); // past the wall-clock cap
    ctl.turns = [
      { role: 'agent', text: 'Thanks for calling Riverside Dental! How can I help?' },
      { role: 'caller', text: 'This is Maria on 0664 1234567, please call me back about a crown.' },
      { role: 'agent', text: 'Got it Maria, I will pass that on.' },
    ];

    let sentTranscript = '';
    (globalThis as never).fetch = async (_url: string, init: { body: string }) => {
      sentTranscript = init.body;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '{"summary":"Maria asked for a callback about a crown.","intent":"message","caller_name":"Maria","caller_phone":"0664 1234567","message":"Call back about a crown."}',
              },
            },
          ],
        }),
      };
    };

    await session.alarm();

    // bind order: duration, summary, intent, message_json, callId
    const update = callUpdates()[0];
    expect(update).toBeDefined();
    expect(update.args[1]).toBe('Maria asked for a callback about a crown.');
    expect(update.args[2]).toBe('message');
    expect(String(update.args[3])).toContain('0664 1234567');
    // and the conversation genuinely reached the model
    expect(sentTranscript).toContain('This is Maria');
    expect(sentTranscript).toContain('crown');
  });

  it('completes the call when the retry lands on a rebuilt instance', async () => {
    // The alarm retry is not guaranteed to hit the same object. A rebuilt one
    // reads everything it needs from storage — which is only true because the
    // watchdog is cleared after the row is written, never before.
    vi.useFakeTimers();
    const { session, storage, ctl, callUpdates, evictAndRebuild } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    ctl.failUpdates = true;
    vi.setSystemTime(Date.now() + 200_000);
    await expect(session.alarm()).rejects.toThrow('D1 unavailable');
    expect(storage.map.get('callId')).toBe('call-1');

    ctl.failUpdates = false;
    await evictAndRebuild().alarm();

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
