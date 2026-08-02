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
  binaryCount(): number {
    return this.sent.filter((s) => typeof s !== 'string').length;
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
  failPuts = false; // durable storage having a bad moment
  failGetsFor: string | null = null; // …including on the way back out
  async get<T>(key: string): Promise<T | undefined> {
    if (this.failGetsFor === key) throw new Error('storage unavailable');
    return this.map.get(key) as T | undefined;
  }
  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (this.failPuts) throw new Error('storage unavailable');
    if (typeof keyOrEntries === 'string') this.map.set(keyOrEntries, value);
    else for (const [k, v] of Object.entries(keyOrEntries)) this.map.set(k, v);
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.map.clear();
  }
  failAlarms = false; // setAlarm rejecting while put succeeds
  async setAlarm(at: number): Promise<void> {
    if (this.failAlarms) throw new Error('alarm unavailable');
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
    failFinalizeReads: false, // transient failure on finalize's own row read
    failTurnWrites: false, // transient failure inserting a turn
    callRowActive: true, // false once the cron sweep has retired the row
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
                // loadCall's read is the one tests gate and fail; finalize's
                // own read must stay working so teardown can still be observed.
                if (ctl.gate && sql.includes('status, started_at')) await ctl.gate.promise;
                if (ctl.failCallReads && sql.includes('SELECT id, business_id')) throw new Error('D1 unavailable');
                if (ctl.failFinalizeReads && sql.includes('SELECT started_at')) throw new Error('D1 unavailable');
                // finalize selects `... AND status = 'active'`; a swept row misses.
                if (!ctl.callRowActive && sql.includes("status = ?")) return null;
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
              // A statement predicated on `status = 'active'` matches nothing
              // once the sweep has retired the row, which is how the real D1
              // reports the race this code has to notice.
              const matched = ctl.callRowActive || !sql.includes("status = 'active'");
              return { meta: { changes: matched ? 1 : 0 } };
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
  const { ctl, writes, turnWrites, callUpdates } = backing;
  /** Rebuild the object on the same storage and D1, as an eviction would. */
  const evictAndRebuild = () => new CallSession(state, fakeEnv(backing.db));
  return { session, storage, ctl, writes, turnWrites, callUpdates, evictAndRebuild };
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

  it('leaves no socket behind when arming the watchdog fails', async () => {
    // Assigning this.ws before arming meant a storage failure returned an error
    // with a socket in place but no listeners and no watchdog: every later
    // attach hit the 409, and nothing existed to finalize the row. An active
    // call that could neither be recovered nor replaced — reached through the
    // guard that exists to prevent exactly that.
    const { session, storage } = newSession();
    storage.failPuts = true;

    await expect(session.fetch(upgradeRequest())).rejects.toThrow('storage unavailable');

    // Nothing was retained, so the next attempt is a clean one.
    storage.failPuts = false;
    const retry = await session.fetch(upgradeRequest());
    expect(retry.status).toBe(101);
    serverSockets.at(-1)!.receive({ type: 'start' });
    await flush();
    expect(serverSockets.at(-1)!.countOf('ready')).toBe(1);
  });

  it('recovers cleanly when the alarm half of arming fails', async () => {
    // Arming persists state and schedules the alarm that acts on it; if only
    // the first half lands, the row sits active with nothing that will ever
    // finalize it. The atomicity itself comes from Workers coalescing writes
    // issued without an intervening await, which a hand-written double cannot
    // reproduce — so this asserts the part that is observable here: a failed
    // arm leaves no socket and the next attach is a clean one.
    const { session, storage } = newSession();
    storage.failAlarms = true;

    await expect(session.fetch(upgradeRequest())).rejects.toThrow('alarm unavailable');
    expect(storage.alarmAt).toBeNull();

    storage.failAlarms = false;
    const retry = await session.fetch(upgradeRequest());
    expect(retry.status).toBe(101); // no stale socket left behind
    expect(storage.alarmAt).not.toBeNull(); // armed properly this time
    serverSockets.at(-1)!.receive({ type: 'start' });
    await flush();
    expect(serverSockets.at(-1)!.countOf('ready')).toBe(1);
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

  it('does not carry a failed attempt forward onto a call that then works', async () => {
    // `failure` decides the row's status, so a marker left behind by an aborted
    // pre-ready attempt filed a call that ran perfectly well as failed — and a
    // working call vanishing from the owner's counts shows them nothing.
    const { session, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    Object.assign(session, { failure: 'Call failed: a previous attempt blew up' });
    sock.receive({ type: 'start' });
    await flush();
    expect(sock.countOf('ready')).toBe(1); // this attempt succeeded

    sock.receive({ type: 'hangup' });
    await flush();
    expect(callUpdates()[0].args[0]).toBe('completed');
    expect(String(callUpdates()[0].args[3] ?? '')).not.toContain('blew up');
  });

  it('freezes the end of the call before the first fallible statement', async () => {
    // Freezing after the select meant an attempt that died *on* the select
    // stored nothing, so the retry timed the call from its own clock and the
    // outage landed in the owner's talk time again.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CALL_ROW.started_at + 'Z').getTime());
    const { session, storage, ctl, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    vi.setSystemTime(Date.now() + 25_000); // a 25 s call
    ctl.failFinalizeReads = true; // …and finalize dies on its own select
    serverSockets[0].receive({ type: 'hangup' });
    await flush();
    expect(storage.map.get('ending')).toBeDefined(); // frozen anyway

    ctl.failFinalizeReads = false;
    vi.setSystemTime(Date.now() + 8 * 60_000);
    await session.alarm();

    expect(callUpdates()[0].args[2]).toBe(25); // not 505
  });

  it('ends the call when startup fails, instead of leaving it half-alive', async () => {
    // The widget turns any error frame into its terminal state, so the session
    // has to agree. Leaving the socket open kept the row 'active' with
    // connected_at set — a live call as far as the concurrency cap is
    // concerned — with nothing to release it until the sweep an hour later.
    const { session, ctl, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    ctl.failCallReads = true; // D1 blip inside loadCall()
    sock.receive({ type: 'start' });
    await flush();

    expect(sock.typesSent()).toContain('error');
    expect(sock.countOf('ready')).toBe(0);
    expect(sock.readyState).toBe(3); // closed, not left hanging
    expect(callUpdates()).toHaveLength(1); // and the slot is released
    expect(callUpdates()[0].args[0]).toBe('failed');
    expect(String(callUpdates()[0].args[3])).toContain('Call failed');
  });

  it('tells the caller nothing about why it broke', async () => {
    // The public widget is reachable by anyone with the business link, and a
    // thrown error quotes whatever it carried — an upstream body, a hostname.
    const { session, ctl, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    ctl.failCallReads = true;
    sock.receive({ type: 'start' });
    await flush();

    const shown = sock.messages().find((m) => m.type === 'error')?.message;
    expect(shown).toBe('Sorry — this call ran into a problem. Please try again.');
    // ...while the owner's row keeps the detail.
    expect(String(callUpdates()[0].args[3])).toContain('D1 unavailable');
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

  it('writes the call row once when closing the socket re-enters finalize', async () => {
    // finalize() closes the client socket, whose close listener calls finalize()
    // again. The single-flight slot has to be claimed before that happens, or
    // the second entry finds it empty and the row is written — and the call
    // summarized — twice.
    const { session, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];
    sock.receive({ type: 'start' });
    await flush();

    sock.receive({ type: 'hangup' });
    await flush();

    expect(callUpdates()).toHaveLength(1);
  });

  it('releases the call when it breaks mid-conversation, keeping the summary', async () => {
    // The case the concurrency cap cares about: the caller leaves the errored
    // tab open instead of clicking retry. Nothing else can release the row, and
    // the sweep that eventually would writes no summary at all.
    const { session, ctl, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];
    sock.receive({ type: 'start' });
    await flush();

    ctl.failTurnWrites = true; // the provider or D1 gives out mid-call
    sock.receive({ type: 'text', text: 'do you have anything on Friday?' });
    await flush();

    expect(sock.typesSent()).toContain('error');
    expect(sock.readyState).toBe(3);
    const update = callUpdates().at(-1)!;
    expect(update.args[0]).toBe('failed');
    expect(update.args[3]).toBeTruthy(); // a reason, not a null row
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

  it('keeps the outgoing connection live for the whole rotation window', async () => {
    // session.expiring rotates proactively so a call does not drop mid-sentence.
    // The old socket is deliberately held open until the replacement succeeds,
    // so it has to stay both readable and writable for those seconds — keying
    // the receive guard on "is this the write target" silently discarded every
    // audio delta the still-working connection produced.
    vi.useFakeTimers();
    const { session } = newSession('realtime');
    await session.fetch(upgradeRequest());
    const client = serverSockets[0];

    client.receive({ type: 'start' });
    await flush();
    const oldUp = upstreamSockets[0];
    oldUp.emit('open', {});
    await flush();
    expect(client.messages().find((m) => m.type === 'ready')?.mode).toBe('realtime');

    const audioBefore = client.binaryCount();

    // Engine warns of its cutoff: rotation begins, replacement starts dialing.
    oldUp.emit('message', { data: JSON.stringify({ type: 'session.expiring' }) });
    await flush();
    expect(upstreamSockets).toHaveLength(2);
    const newUp = upstreamSockets[1];
    expect(newUp.readyState).toBe(1);

    // Mid-rotation, the old connection is still mid-response.
    for (let i = 0; i < 3; i++) {
      oldUp.emit('message', {
        data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAAA' }),
      });
    }
    oldUp.emit('message', {
      data: JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'still talking' }),
    });
    await flush();

    expect(client.binaryCount()).toBe(audioBefore + 3); // nothing dropped
    expect(client.messages().some((m) => m.text === 'still talking')).toBe(true);

    // Caller audio must still reach the engine that is actually connected.
    const oldSentBefore = oldUp.sent.length;
    client.emit('message', { data: new ArrayBuffer(8) });
    await flush();
    expect(oldUp.sent.length).toBe(oldSentBefore + 1);
    expect(newUp.sent).toHaveLength(0); // not written to before it opens

    // Handover: once the replacement opens it takes over and the old is closed.
    newUp.emit('open', {});
    await flush();
    expect(newUp.sent.length).toBeGreaterThan(0); // session.update went out
    expect(oldUp.readyState).toBe(3);

    // And a rotated-out socket can no longer inject anything.
    const after = client.binaryCount();
    oldUp.emit('message', {
      data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'BBBB' }),
    });
    await flush();
    expect(client.binaryCount()).toBe(after);
  });

  it('briefs the replacement with turns that arrived during the handover', async () => {
    // The old connection stays live while the replacement dials, so history can
    // grow inside that window. Building the resume instructions at dial time
    // handed the new engine a transcript missing that exchange, and the agent
    // asked the caller to repeat what they had just said — on a rotation whose
    // whole purpose is to be seamless.
    vi.useFakeTimers();
    const { session } = newSession('realtime');
    await session.fetch(upgradeRequest());
    const client = serverSockets[0];
    client.receive({ type: 'start' });
    await flush();
    const oldUp = upstreamSockets[0];
    oldUp.emit('open', {});
    await flush();

    oldUp.emit('message', { data: JSON.stringify({ type: 'session.expiring' }) });
    await flush();
    const newUp = upstreamSockets[1];

    // Mid-handover exchange, on the connection that is still working.
    oldUp.emit('message', {
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'my booking reference is four seven two',
      }),
    });
    oldUp.emit('message', {
      data: JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'Got it, four seven two.' }),
    });
    await flush();

    newUp.emit('open', {});
    await flush();

    const update = newUp.messages().find((m) => m.type === 'session.update');
    const instructions = String((update?.session as { instructions?: string })?.instructions ?? '');
    expect(instructions).toContain('four seven two');
    expect(instructions).toContain('Got it, four seven two.');
  });

  it('keeps the call alive when a proactive rotation fails to connect', async () => {
    // Rotation deliberately holds the outgoing connection open while the
    // replacement dials. Treating a failed dial as unrecoverable hung up on a
    // caller whose engine was still working — a transient failure to open a
    // *second* socket ending a call that was never broken.
    vi.useFakeTimers();
    const { session, callUpdates } = newSession('realtime');
    await session.fetch(upgradeRequest());
    const client = serverSockets[0];
    client.receive({ type: 'start' });
    await flush();
    const engine = upstreamSockets[0];
    engine.emit('open', {});
    await flush();

    engine.emit('message', { data: JSON.stringify({ type: 'session.expiring' }) });
    await flush();
    expect(upstreamSockets).toHaveLength(2);

    // The replacement never connects.
    await vi.advanceTimersByTimeAsync(6000);
    await flush();

    expect(client.typesSent()).not.toContain('error');
    expect(client.typesSent()).not.toContain('ended');
    expect(client.readyState).toBe(1);
    expect(callUpdates()).toHaveLength(0); // not finalized
    expect(engine.readyState).toBe(1); // still riding the original

    // …and it is still carrying audio.
    const before = client.binaryCount();
    engine.emit('message', {
      data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAAA' }),
    });
    await flush();
    expect(client.binaryCount()).toBe(before + 1);

    // When that connection does finally close, there is nothing left and the
    // call ends properly rather than hanging.
    engine.close(1006, 'engine cutoff');
    await vi.advanceTimersByTimeAsync(6000);
    await flush();
    expect(client.typesSent()).toContain('error');
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
    const { session, storage, callUpdates } = newSession();
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
    // A conversation that happened and then went quiet on the caller's side is
    // still a call. Marking it failed would drop it — and any message left in
    // it — out of the owner's counts, which is the opposite of what they need.
    expect(callUpdates()[0].args[0]).toBe('completed');
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

  it('releases a socket that never starts, however hard it pings', async () => {
    // Squatting: upgrade a freshly issued call id, never send {type:"start"},
    // and hold the socket with the keepalive the protocol already accepts. No
    // provider work, but the row stays 'active' and occupies a concurrency
    // slot. The idle timer cannot see it — a ping is inbound traffic, so
    // `lastActivity` keeps getting refreshed.
    vi.useFakeTimers();
    const { session, storage, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];
    expect(storage.alarmAt).not.toBeNull(); // armed at upgrade, before any start

    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + 15_000);
      sock.receive({ type: 'ping' }); // keeps lastActivity fresh the whole time
      await flush();
    }
    await session.alarm();
    await flush();

    expect(callUpdates()).toHaveLength(1); // finalized, so the slot is released
    expect(sock.readyState).toBe(3);
    expect(storage.alarmAt).toBeNull();
    // Never became a call, so it must not count as one: 'failed' is what keeps
    // it out of the owner's call count and talk time.
    expect(callUpdates()[0].args[0]).toBe('failed');
    expect(String(callUpdates()[0].args[3])).toContain('never started the call');
  });

  it('retires the start deadline in the same write that arms the watchdog', async () => {
    // A standalone delete after `ready` could fail on its own, and then the
    // call is live with a stale deadline the watchdog would honour — hanging
    // up on a caller mid-conversation. Folded into armWatchdog's write it
    // either lands with the rest of the watchdog state or not at all.
    const { session, storage } = newSession();
    await session.fetch(upgradeRequest());
    expect(storage.map.get('startDeadline')).toBeGreaterThan(0); // armed at upgrade

    serverSockets[0].receive({ type: 'start' });
    await flush();

    expect(storage.map.get('startDeadline')).toBe(0); // retired
    expect(storage.map.get('hardDeadline')).toBeGreaterThan(0); // same write
  });

  it('does not kill a start that is still in flight', async () => {
    // The deadline could only see "startup has not finished", which is also
    // what a slow D1 read or engine handshake looks like — so a caller sitting
    // mid-connect was hung up on and told they had never started the call.
    vi.useFakeTimers();
    const { session, ctl, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    let release!: () => void;
    ctl.gate = { promise: new Promise<void>((r) => (release = r)), release: () => release() };
    sock.receive({ type: 'start' }); // parks inside loadCall()
    await flush();

    vi.setSystemTime(Date.now() + 45_000); // well past the 30 s deadline
    await session.alarm();
    await flush();

    expect(callUpdates()).toHaveLength(0); // survived
    expect(sock.readyState).toBe(1);
    expect(sock.typesSent()).not.toContain('ended');

    ctl.gate.release();
    ctl.gate = null;
    await flush();
    expect(sock.countOf('ready')).toBe(1); // and finishes normally
  });

  it('gives up on a start that never completes, with an accurate reason', async () => {
    // A client that keeps pinging would otherwise hold a half-started call
    // open forever: nothing else bounds the window before armWatchdog runs.
    vi.useFakeTimers();
    const { session, ctl, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    let release!: () => void;
    ctl.gate = { promise: new Promise<void>((r) => (release = r)), release: () => release() };
    sock.receive({ type: 'start' });
    await flush();

    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(Date.now() + 20_000);
      sock.receive({ type: 'ping' }); // keeps the idle timer happy
      await flush();
    }
    await session.alarm();
    await flush();

    expect(callUpdates()).toHaveLength(1);
    expect(callUpdates()[0].args[0]).toBe('failed');
    // Not "never started the call" — it did start, it just never finished.
    expect(String(callUpdates()[0].args[3])).toContain('did not finish starting');
    ctl.gate.release();
  });

  it('does not apply the start deadline once the call is under way', async () => {
    vi.useFakeTimers();
    const { session, storage, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];
    sock.receive({ type: 'start' });
    await flush();
    expect(storage.map.get('startDeadline')).toBe(0); // retired when the watchdog armed

    // Well past the start deadline, but the caller is talking.
    vi.setSystemTime(Date.now() + 90_000);
    sock.receive({ type: 'ping' });
    await flush();
    await session.alarm();

    expect(callUpdates()).toHaveLength(0); // still live
    expect(sock.readyState).toBe(1);
    expect(storage.alarmAt).not.toBeNull();
  });

  it('keeps the watchdog armed when the call row fails to write', async () => {
    vi.useFakeTimers();
    const { session, storage, ctl, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    ctl.failUpdates = true; // transient D1 outage
    vi.setSystemTime(Date.now() + 200_000);
    // Does not rethrow: propagating would hand the retry to Cloudflare's finite
    // budget, and an outage outlasting it would strand the row for good.
    await expect(session.alarm()).resolves.toBeUndefined();

    // Clearing the watchdog before the write landed would strand the row as
    // 'active' with nothing left to reclaim it.
    expect(storage.map.get('callId')).toBe('call-1');
    expect(callUpdates()).toHaveLength(0);
    expect(storage.alarmAt).toBeGreaterThan(Date.now()); // retry is scheduled

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

    // bind order: status, ended_at, duration, summary, intent, message_json, callId
    const update = callUpdates()[0];
    expect(update).toBeDefined();
    expect(update.args[0]).toBe('completed'); // recovered, not a failure
    expect(update.args[3]).toBe('Maria asked for a callback about a crown.');
    expect(update.args[4]).toBe('message');
    expect(String(update.args[5])).toContain('0664 1234567');
    // and the conversation genuinely reached the model
    expect(sentTranscript).toContain('This is Maria');
    expect(sentTranscript).toContain('crown');
  });

  it('retries finalize at the ordinary tick until it lands', async () => {
    // Cloudflare stops retrying a throwing alarm after about six attempts, so
    // the watchdog schedules its own. Flat, not a ladder: one object retrying
    // one row by primary key is not a herd, and spacing attempts out only
    // delays recovering the caller's summary.
    vi.useFakeTimers();
    const { session, storage, ctl, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    ctl.failUpdates = true;
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + 200_000);
      await session.alarm();
      delays.push((storage.alarmAt as number) - Date.now());
    }

    expect(callUpdates()).toHaveLength(0);
    expect(storage.map.get('callId')).toBe('call-1'); // still reclaimable
    expect(new Set(delays).size).toBe(1); // same cadence every time
    expect(delays[0]).toBe(60_000);

    // And it completes as soon as D1 comes back.
    ctl.failUpdates = false;
    await session.alarm();
    expect(callUpdates()).toHaveLength(1);
    expect(storage.alarmAt).toBeNull();
  });

  it('does not overwrite the sweep when it retires the row mid-summarization', async () => {
    // The window between finalize's active-row select and its update is as long
    // as a summarization call, which is plenty. An unconditional WHERE id = ?
    // put 'completed' and a duration over the sweep's terminal verdict — the
    // salvage path exists to cooperate with the sweep, not to override it.
    vi.useFakeTimers();
    const { session, storage, ctl, writes } = newSession();
    storage.map.set('callId', 'call-1');
    storage.map.set('hardDeadline', Date.now() - 1000);
    ctl.turns = [
      { role: 'agent', text: 'Riverside Dental.' },
      { role: 'caller', text: 'Ring me back on 0664 1234567.' },
      { role: 'agent', text: 'Will do.' },
    ];
    (globalThis as never).fetch = async () => {
      ctl.callRowActive = false; // the cron lands while we are summarizing
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"summary":"Callback requested.","intent":"message"}' } }],
        }),
      };
    };

    await session.alarm();

    const main = writes.find((w) => w.sql.includes('SET status'));
    expect(main!.sql).toContain("status = 'active'"); // predicated, so it matched nothing
    // ...and the content was salvaged instead of the verdict being overwritten.
    const salvage = writes.find((w) => w.sql.includes('COALESCE'));
    expect(salvage).toBeDefined();
    expect(salvage!.args[0]).toBe('Callback requested.');
  });

  it('keeps a failed call failed when the retry lands on a rebuilt instance', async () => {
    // `failure` decides the row's status. Held only in memory, an eviction
    // between attempts dropped it, and the attempt that finally landed wrote
    // 'completed' for a call that had broken.
    vi.useFakeTimers();
    const { session, storage, ctl, callUpdates, evictAndRebuild } = newSession();
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];
    sock.receive({ type: 'start' });
    await flush();

    ctl.failUpdates = true;
    ctl.failTurnWrites = true;
    sock.receive({ type: 'text', text: 'hello?' }); // breaks mid-call
    await flush();
    expect(callUpdates()).toHaveLength(0);
    expect(storage.map.get('ending')).toBeDefined();

    ctl.failUpdates = false;
    ctl.failTurnWrites = false;
    vi.setSystemTime(Date.now() + 200_000);
    await evictAndRebuild().alarm(); // fresh instance, in-memory failure gone

    expect(callUpdates()).toHaveLength(1);
    expect(callUpdates()[0].args[0]).toBe('failed');
    expect(String(callUpdates()[0].args[3])).toContain('Call failed');
  });

  it('salvages the caller message when the sweep retires the row first', async () => {
    // The sweep is terminal — finalize's `AND status = 'active'` misses forever
    // after it — and it writes none of the content fields. A summary this
    // session already paid for should not die with the row: for a small
    // business the callback message is the most valuable thing a call produces.
    vi.useFakeTimers();
    const { session, storage, ctl, writes } = newSession();
    storage.map.set('callId', 'call-1');
    storage.map.set('hardDeadline', Date.now() - 1000);
    ctl.turns = [
      { role: 'agent', text: 'Riverside Dental, how can I help?' },
      { role: 'caller', text: 'Ring me back on 0664 1234567 about a crown.' },
      { role: 'agent', text: 'Will do.' },
    ];
    (globalThis as never).fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '{"summary":"Callback requested.","intent":"message","caller_phone":"0664 1234567","message":"Ring back about a crown."}',
            },
          },
        ],
      }),
    });

    ctl.failUpdates = true;
    await session.alarm(); // summarizes, then the write fails
    expect(storage.map.get('summarized')).toBeDefined();

    ctl.callRowActive = false; // the cron sweep retires it as 'abandoned'
    ctl.failUpdates = false;
    await session.alarm();

    const salvage = writes.find((w) => w.sql.includes('COALESCE'));
    expect(salvage).toBeDefined();
    expect(salvage!.args[0]).toBe('Callback requested.');
    expect(String(salvage!.args[2])).toContain('0664 1234567');
    // Content only: the sweep's own verdict on the call is left alone.
    expect(salvage!.sql).not.toContain('status =');
    expect(salvage!.sql).not.toContain('duration_s');
    expect(storage.alarmAt).toBeNull(); // and it stops
  });

  it('stops retrying on its own, without relying on a sweep existing', async () => {
    // This has to be correct standing alone: `main` has no scheduled handler
    // and no cron, so an unbounded loop would keep the object alive and hit D1
    // once a minute forever. The ceiling is the DO's own, not the sweep's.
    vi.useFakeTimers();
    const { session, storage, ctl, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    ctl.failUpdates = true;
    let ticks = 0;
    while (storage.alarmAt !== null && ticks < 500) {
      vi.setSystemTime(storage.alarmAt);
      storage.alarmAt = null;
      await session.alarm();
      ticks++;
    }

    expect(storage.alarmAt).toBeNull(); // it gave up rather than looping forever
    expect(ticks).toBeLessThan(60); // ~30 min at a one-minute cadence
    expect(callUpdates()).toHaveLength(0);
    expect(storage.map.get('callId')).toBe('call-1'); // left for a later sweep
  });

  it('defers to platform retries when it has no durable clock to bound itself', async () => {
    // Without the persisted marker there is no record of when the failures
    // began, and an in-memory fallback resets on every eviction — each rebuilt
    // instance would measure zero elapsed and reschedule forever, which is the
    // unbounded loop the ceiling exists to prevent. Rethrowing hands it to the
    // platform's finite alarm retries: bounded by construction.
    vi.useFakeTimers();
    const { session, storage, ctl, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    ctl.failUpdates = true;
    storage.failGetsFor = 'ending';
    vi.setSystemTime(Date.now() + 200_000);
    storage.alarmAt = null;

    // The same outage takes out rememberEnding's read, so finalize never even
    // reaches the write — which is precisely when there is no clock to use.
    await expect(session.alarm()).rejects.toThrow('storage unavailable');
    expect(callUpdates()).toHaveLength(0);
    expect(storage.alarmAt).toBeNull(); // no self-scheduled retry to run away

    // With the marker readable it owns the retry again.
    storage.failGetsFor = null;
    await session.alarm();
    expect(storage.alarmAt).toBe(Date.now() + 60_000);
  });

  it('retries at a flat cadence rather than backing off', async () => {
    // Asserts the interval directly. Counting attempts was the previous shape
    // and it passed for the wrong reason: the loop did not consume the alarm,
    // so once the ceiling stopped rescheduling it kept re-firing the same stale
    // timestamp and the count assertion was satisfied by the loop itself. The
    // gap between attempts is the property that distinguishes flat from a
    // ladder, and a stale alarm cannot fake it.
    vi.useFakeTimers();
    const { session, storage, ctl } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    ctl.failUpdates = true;
    const gaps: number[] = [];
    while (storage.alarmAt !== null && gaps.length < 200) {
      const at = storage.alarmAt;
      gaps.push(at - Date.now());
      vi.setSystemTime(at);
      storage.alarmAt = null; // a real Durable Object consumes the alarm
      await session.alarm();
    }

    expect(new Set(gaps).size).toBe(1); // one interval, not a growing one
    expect(gaps[0]).toBe(60_000);
    expect(gaps.length).toBeGreaterThan(20); // an exponential ladder gives ~8
  });

  it('stops retrying once the sweep has retired the row', async () => {
    // The sweep is the termination condition, which is why this needs no
    // attempt counter: a row it marks 'abandoned' is no longer active, so the
    // next attempt finds nothing to reconcile and cleans itself up.
    vi.useFakeTimers();
    const { session, storage, ctl, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    ctl.failUpdates = true;
    vi.setSystemTime(Date.now() + 200_000);
    await session.alarm();
    expect(storage.alarmAt).not.toBeNull(); // still trying

    ctl.callRowActive = false; // the cron retired it
    ctl.failUpdates = false;
    await session.alarm();

    expect(callUpdates()).toHaveLength(0); // nothing left to write
    expect(storage.alarmAt).toBeNull(); // and it stopped waking up
    expect(storage.map.size).toBe(0);
  });

  it('reports the duration the call actually had, not the retry delay', async () => {
    // runFinalize recomputed Date.now() per attempt, so an outage plus the wait
    // before the next attempt landed in the owner's talk-time total.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CALL_ROW.started_at + 'Z').getTime());
    const { session, ctl, callUpdates } = newSession();
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush();

    vi.setSystemTime(Date.now() + 40_000); // 40 seconds of conversation
    const trueEnd = Date.now();
    ctl.failUpdates = true;
    serverSockets[0].receive({ type: 'hangup' }); // the write fails
    await flush();
    expect(callUpdates()).toHaveLength(0);

    ctl.failUpdates = false;
    vi.setSystemTime(Date.now() + 10 * 60_000); // ten minute outage
    await session.alarm(); // watchdog retry

    // bind order: status, ended_at, duration, ...
    const args = callUpdates()[0].args;
    expect(args[2]).toBe(40); // not 640
    expect(args[1]).toBe(new Date(trueEnd).toISOString().replace('T', ' ').slice(0, 19));
    expect(args[0]).toBe('completed');
  });

  it('does not re-bill summarization when the retry lands on a rebuilt instance', async () => {
    // Eviction between attempts is expected — every socket is closed by then —
    // so an in-memory memo alone let a replacement instance rehydrate the turns
    // and pay the summarization model all over again, once per retry.
    vi.useFakeTimers();
    const { session, storage, ctl, callUpdates, evictAndRebuild } = newSession();
    storage.map.set('callId', 'call-1');
    storage.map.set('hardDeadline', Date.now() - 1000);
    ctl.turns = [
      { role: 'agent', text: 'Riverside Dental, how can I help?' },
      { role: 'caller', text: 'Call me back on 0664 1234567 please.' },
      { role: 'agent', text: 'Will do.' },
    ];
    let summaryCalls = 0;
    (globalThis as never).fetch = async () => {
      summaryCalls++;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"summary":"Callback requested.","intent":"message"}' } }],
        }),
      };
    };

    ctl.failUpdates = true;
    await session.alarm();
    expect(summaryCalls).toBe(1);

    ctl.failUpdates = false;
    await evictAndRebuild().alarm(); // fresh instance, memo gone with it

    expect(callUpdates()).toHaveLength(1);
    expect(callUpdates()[0].args[3]).toBe('Callback requested.');
    expect(summaryCalls).toBe(1); // read back from storage, not re-billed
  });

  it('does not re-bill summarization on a finalize retry', async () => {
    vi.useFakeTimers();
    const { session, storage, ctl, callUpdates } = newSession();
    storage.map.set('callId', 'call-1');
    storage.map.set('hardDeadline', Date.now() - 1000);
    ctl.turns = [
      { role: 'agent', text: 'Riverside Dental, how can I help?' },
      { role: 'caller', text: 'Please call me back on 0664 1234567.' },
      { role: 'agent', text: 'Will do.' },
    ];
    let summaryCalls = 0;
    (globalThis as never).fetch = async () => {
      summaryCalls++;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"summary":"Callback requested.","intent":"message"}' } }],
        }),
      };
    };

    ctl.failUpdates = true;
    await session.alarm();
    expect(summaryCalls).toBe(1);

    ctl.failUpdates = false;
    vi.setSystemTime(Date.now() + 200_000);
    await session.alarm();

    expect(callUpdates()).toHaveLength(1);
    expect(callUpdates()[0].args[3]).toBe('Callback requested.'); // kept the result
    expect(summaryCalls).toBe(1); // and did not pay for it twice
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
    await session.alarm();
    expect(storage.map.get('callId')).toBe('call-1');

    ctl.failUpdates = false;
    vi.setSystemTime(Date.now() + 200_000); // the rescheduled retry comes due
    await evictAndRebuild().alarm();

    expect(callUpdates()).toHaveLength(1);
    expect(storage.alarmAt).toBeNull();
    expect(storage.map.size).toBe(0);
  });
});

// A trap for whoever widens the typecheck: `tsconfig.worker.json` includes only
// `src/**/*.ts`, so nothing here is type-checked today, and the `globalThis as
// never` casts below rely on that. Extending the typecheck to cover `test/` is
// a reasonable thing to want given how much logic now lives here, and it will
// fail on those casts first, for a reason that looks unrelated to the change.
// Rewrite them as a typed global augmentation at that point, not before.
//
// NOT COVERED by this file, and worth stating plainly:
//   * Real Workers runtime semantics — DO eviction, hibernation, and whether an
//     alarm survives a deploy. These fakes assert our logic, not the platform's.
//   * Storage write coalescing. `commit()` relies on writes issued without an
//     intervening await landing in one transaction; FakeStorage applies each
//     write as it is called, so a test here cannot tell an atomic arm from a
//     partial one. What is asserted instead is the recoverable state a failed
//     arm leaves behind. If someone reorders those writes to await one first,
//     these tests will still pass — the guard is the comment on commit().
//   * The realtime audio path end to end (base64 PCM framing, barge-in flushes).
//   * D1 behaviour: the fake never enforces constraints or returns errors.
//   * The /ws/call/:callId route in src/index.ts, which decides who reaches the
//     DO at all — that guard belongs to the abuse-limits work.
// Closing those needs @cloudflare/vitest-pool-workers and a miniflare D1.
