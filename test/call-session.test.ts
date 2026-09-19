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
import { applyMigrations, SqliteD1 } from './sqlite-d1';
import type { Env } from '../src/types';

function jsonStream(value: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close();
  } });
}

// ---------- fakes ----------

class FakeSocket {
  autoAudioReceipts = true;
  readyState = 1; // OPEN
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};

  accept(): void {}
  send(data: unknown): void {
    if (this.readyState !== 1) throw new Error('socket closed');
    this.sent.push(data);
    if (this.autoAudioReceipts && typeof data === 'string' &&
        (data.startsWith('{"type":"audio_receipt"') || data.startsWith('{"type":"control_receipt"'))) {
      const message = JSON.parse(data);
      if (message.type === 'audio_receipt' || message.type === 'control_receipt') queueMicrotask(() => {
        if (this.readyState === 1) this.receive({ type: 'audio_received', id: message.id });
      });
    }
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
  tts_provider: 'instance', tts_base_url: '', tts_api_key: '', tts_model: '',
};

function fakeDb(engine: 'pipeline' | 'realtime' = 'pipeline', settings: Partial<typeof SETTINGS_ROW> = {}) {
  const writes: { sql: string; args: unknown[] }[] = [];
  const ctl = {
    channel: 'web',
    failUpdates: false, // transient failure writing the finished call row
    failCallReads: false, // transient failure inside loadCall()
    failFinalizeReads: false, // transient failure on finalize's own row read
    failTurnWrites: false, // transient failure inserting a turn
    callerTurnGate: null as Promise<void> | null,
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
                if (sql.includes("failure_code GLOB 'asterisk_*'")) return null; // no carrier failure in this generic fake
                if (!ctl.callRowActive && sql.includes("status = ?")) return null;
                return { ...CALL_ROW, channel: ctl.channel };
              }
              if (sql.includes('FROM businesses')) return BIZ_ROW;
              if (sql.includes('FROM agent_settings')) return { ...SETTINGS_ROW, engine, ...settings };
              return null;
            },
            async all() {
              if (sql.includes('FROM call_turns')) return { results: ctl.turns };
              return { results: [] };
            },
            async run() {
              if (ctl.failUpdates && sql.includes('UPDATE calls')) throw new Error('D1 unavailable');
              if (ctl.failTurnWrites && sql.includes('INSERT INTO call_turns')) throw new Error('D1 unavailable');
              if (ctl.callerTurnGate && sql.includes('INSERT INTO call_turns') && args[1] === 'caller') await ctl.callerTurnGate;
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
const gatewayRequests: { url: string; init: RequestInit }[] = [];
let gatewayOutcomes: ('pending' | 'reject' | number)[] = [];
const gatewayDisposals = new Set<() => void>();
const signalTimers = new Set<ReturnType<typeof setTimeout>>();
let restoreSignalTimeout = () => {};

// Only this synthetic endpoint is admitted. Legacy emit('open') means that the
// pending HTTP Upgrade completes, not a post-upgrade open event from workerd.
function gatewayFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.hostname !== 'stub.invalid' || url.pathname !== '/v1/realtime' ||
      !['http:', 'https:'].includes(url.protocol) || new Headers(init.headers).get('Upgrade') !== 'websocket') {
    throw new Error('no network in unit tests');
  }
  gatewayRequests.push({ url: url.href, init });
  const outcome = gatewayOutcomes.shift() ?? 'pending';
  if (outcome === 'reject') return Promise.reject(new Error('synthetic upgrade rejection'));
  if (typeof outcome === 'number') return Promise.resolve({ status: outcome, webSocket: null } as unknown as Response);
  const ws = new FakeSocket(); upstreamSockets.push(ws);
  return new Promise((resolve, reject) => {
    let settled = false;
    const clean = () => { init.signal?.removeEventListener('abort', fail); gatewayDisposals.delete(fail); };
    const fail = () => {
      if (settled) return;
      settled = true; clean(); ws.close(1000, 'synthetic upgrade cancelled');
      reject(new Error('synthetic upgrade cancelled'));
    };
    gatewayDisposals.add(fail);
    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true; clean(); resolve({ status: 101, webSocket: ws } as unknown as Response);
    });
    ws.addEventListener('error', fail);
    ws.addEventListener('close', fail);
    init.signal?.addEventListener('abort', fail, { once: true });
    if (init.signal?.aborted) fail();
  });
}

beforeEach(() => {
  serverSockets = [];
  upstreamSockets = [];
  gatewayRequests.length = 0; gatewayOutcomes = [];
  // Model AbortSignal.timeout using the same fake clock as the test. This is
  // deterministic fixture behavior, not evidence of native fetch cancellation.
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    const timer = setTimeout(() => { signalTimers.delete(timer); controller.abort(); }, ms);
    signalTimers.add(timer);
    return controller.signal;
  });
  restoreSignalTimeout = () => timeout.mockRestore();
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
  globalThis.fetch = gatewayFetch as typeof fetch;
});

afterEach(async () => {
  for (const dispose of gatewayDisposals) dispose();
  await flush();
  for (const timer of signalTimers) clearTimeout(timer);
  signalTimers.clear(); restoreSignalTimeout();
  for (const [k, v] of Object.entries(realGlobals)) (globalThis as never)[k] = v;
  vi.useRealTimers();
});

function newSession(engine: 'pipeline' | 'realtime' = 'pipeline', settings: Partial<typeof SETTINGS_ROW> = {}, envOverrides: Partial<Env> = {}) {
  const backing = fakeDb(engine, settings);
  const storage = new FakeStorage();
  const state = { storage } as unknown as DurableObjectState;
  const sessionEnv = { ...fakeEnv(backing.db), ...envOverrides };
  const session = new CallSession(state, sessionEnv);
  const { ctl, writes, turnWrites, callUpdates } = backing;
  /** Rebuild the object on the same storage and D1, as an eviction would. */
  const evictAndRebuild = () => new CallSession(state, sessionEnv);
  return { session, storage, ctl, writes, turnWrites, callUpdates, evictAndRebuild };
}

// ---------- tests ----------

it('announces the browser speech language for pipeline greetings and replies', async () => {
  const { session } = newSession('pipeline', { language: 'de' });
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: jsonStream({ choices: [{ message: { content: 'Guten Tag!' } }] }),
  })) as unknown as typeof fetch;
  await session.fetch(upgradeRequest());
  const caller = serverSockets[0]; caller.receive({ type: 'start' }); await flush(80);
  expect(caller.messages().find(m => m.type === 'ready')).toMatchObject({ language: 'de', ttsMode: 'browser' });
  caller.receive({ type: 'text', text: 'Hallo' }); await flush(80);
  expect(caller.messages().find(m => m.type === 'agent_text')).toMatchObject({ language: 'de', text: 'Guten Tag!' });
  caller.receive({ type: 'hangup' }); await flush(80);
});

it('pipeline uses the saved speech key, announces server audio, and cancels speech on hangup', async () => {
  const { session } = newSession('pipeline', { tts_provider: 'custom', tts_base_url: 'https://speech.example/v1', tts_api_key: 'speech-only', tts_model: 'custom-tts', voice: 'coral' });
  let speechSignal: AbortSignal | undefined;
  const cancel = vi.fn();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    speechSignal = init.signal!;
    return new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}), cancel }));
  });
  globalThis.fetch = fetcher as unknown as typeof fetch;
  await session.fetch(upgradeRequest());
  const caller = serverSockets[0]; caller.receive({ type: 'start' }); await flush(80);
  expect(caller.messages().find(m => m.type === 'ready')).toMatchObject({ ttsMode: 'server', mode: 'pipeline' });
  expect(fetcher).toHaveBeenCalledWith('https://speech.example/v1/audio/speech', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer speech-only' }), body: expect.stringContaining('"voice":"coral"') }));
  caller.receive({ type: 'hangup' }); await flush(80);
  expect(speechSignal?.aborted).toBe(true); expect(cancel).toHaveBeenCalled();
});

describe('pipeline closing guard', () => {
  it.each([
    { first: 'Your message is saved. <END_CALL>', second: 'Hasta luego.', expected: 'Your message is saved. Hasta luego.', calls: 2 },
    { first: 'Auf Wiederhören. <END_CALL>', second: '', expected: 'Auf Wiederhören.', calls: 1 },
    { first: '<END_CALL>', second: '', expected: undefined, calls: 2 },
    { first: '<END_CALL>', second: 'How can I help you?', expected: undefined, calls: 2 },
  ])('preserves useful speech and bounds the farewell request: $first', async ({ first, second, expected, calls }) => {
    vi.useFakeTimers();
    const { session } = newSession('pipeline');
    let requests = 0;
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: jsonStream({ choices: [{ message: { content: ++requests === 1 ? first : second } }] }),
    })) as unknown as typeof fetch;
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0]; caller.receive({ type: 'start' }); await flush(100);
    caller.receive({ type: 'text', text: 'Eso es todo, gracias.' }); await flush(150);
    expect(requests).toBe(calls + (expected === undefined ? 1 : 0)); // finalization also summarizes
    if (expected) {
      expect(caller.messages().find(m => m.type === 'agent_text')?.text).toBe(expected);
      expect(caller.countOf('ending')).toBe(1);
      expect(caller.closed).toBeNull();
      caller.receive({ type: 'playback_complete', id: caller.messages().find(m => m.type === 'ending')!.id });
      await flush(100);
    } else expect(caller.countOf('ending')).toBe(0);
    expect(caller.countOf('ended')).toBe(1);
  });

  it('does not emit a late farewell after the caller hangs up', async () => {
    vi.useFakeTimers();
    const { session } = newSession('pipeline');
    let finish!: (value: unknown) => void;
    let requests = 0;
    const response = (text: string) => ({ ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), body: jsonStream({ choices: [{ message: { content: text } }] }) });
    globalThis.fetch = vi.fn(async () => ++requests === 1 ? response('<END_CALL>') : requests === 2 ? new Promise(resolve => { finish = resolve; }) : response('{}')) as unknown as typeof fetch;
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0]; caller.receive({ type: 'start' }); await flush(100);
    caller.receive({ type: 'text', text: 'Goodbye.' }); await flush(100);
    expect(requests).toBe(2);
    caller.receive({ type: 'hangup' }); await flush(100);
    finish(response('Goodbye.')); await flush(100);
    expect(caller.countOf('agent_text')).toBe(0);
    expect(caller.countOf('ending')).toBe(0);
  });
});

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
    const { session, storage, callUpdates } = newSession();
    storage.failPuts = true;

    await expect(session.fetch(upgradeRequest())).rejects.toThrow('storage unavailable');

    // The row outlives the failed arm — it was inserted before the upgrade —
    // and with no alarm armed nothing in the session would ever finalize it.
    const retired = callUpdates()[0];
    expect(retired).toBeDefined();
    expect(retired.sql).toContain("status = 'failed'");
    expect(String(retired.args[1])).toContain('could not be started');
    expect(retired.sql).toContain("outcome = 'failed'");
    expect(retired.sql).toContain("failure_code = 'watchdog_unavailable'");
    expect(String(retired.args[2])).toContain('watchdog could not be started');
    expect(retired.sql).toContain("status = 'active'"); // never contests another writer

    // Nothing else was retained, so the next attempt is a clean one.
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
  it('keeps legacy services and FAQs for a mixed-version call without an assistant id', async () => {
    const previousServices = BIZ_ROW.services_json;
    const previousFaqs = BIZ_ROW.faqs_json;
    BIZ_ROW.services_json = JSON.stringify([{ name: 'Emergency cleaning', price: '€90' }]);
    BIZ_ROW.faqs_json = JSON.stringify([{ q: 'Do you validate parking?', a: 'Yes, for two hours.' }]);
    try {
      const { session } = newSession();
      await session.fetch(upgradeRequest());
      serverSockets[0].receive({ type: 'start' });
      await flush();

      const history = (session as unknown as { history: { content: string }[] }).history;
      expect(history[0].content).toContain('Emergency cleaning');
      expect(history[0].content).toContain('Do you validate parking?');
      expect(history[0].content).toContain('Yes, for two hours.');
    } finally {
      BIZ_ROW.services_json = previousServices;
      BIZ_ROW.faqs_json = previousFaqs;
    }
  });

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

describe('realtime session payload', () => {
  /**
   * The `session.update` a tier's engine actually receives, driven through the
   * real start path rather than by reaching into the class — the bug these
   * pin is "what we put on the wire", so the wire is what gets inspected.
   */
  const sessionFor = async (realtime_model: string): Promise<Record<string, unknown>> => {
    const { session } = newSession('realtime', { realtime_model });
    await session.fetch(upgradeRequest());
    serverSockets.at(-1)!.receive({ type: 'start' });
    await flush();
    upstreamSockets.at(-1)!.emit('open', {});
    await flush();
    const update = upstreamSockets.at(-1)!.messages().find((m) => m.type === 'session.update');
    expect(update, `no session.update reached the ${realtime_model} engine`).toBeDefined();
    return update!.session as Record<string, unknown>;
  };

  const turnDetection = async (model: string): Promise<Record<string, unknown>> => {
    const s = await sessionFor(model);
    const audio = s.audio as { input?: { turn_detection?: Record<string, unknown> } };
    return audio?.input?.turn_detection ?? {};
  };

  const TUNED_SERVER_VAD = { type: 'server_vad', threshold: 0.7, prefix_padding_ms: 300, silence_duration_ms: 550 };

  it('redacts valid and malformed upstream error frames before logging', async () => {
    const { session } = newSession('realtime');
    await session.fetch(upgradeRequest());
    serverSockets.at(-1)!.receive({ type: 'start' });
    await flush();
    const upstream = upstreamSockets.at(-1)!;
    upstream.emit('open', {});
    await flush();

    const secret = 'realtime-secret-never-log';
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      upstream.receive({ type: 'error', error: { message: `reflected ${secret}` } });
      upstream.emit('message', { data: `not-json token=${secret}` });
      await flush();
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).toContain('provider response redacted');
      expect(logged).not.toContain(secret);
    } finally {
      errorLog.mockRestore();
    }
  });

  it('keeps gpt-realtime tiers on server VAD, splitting and all', async () => {
    // server_vad ends the caller's turn at a clause pause on this brain 10/10,
    // where a semantic detector splits 0/10 (McNemar p = 0.00195) — but
    // OpenAI's semantic detector costs a 4512 ms p90 end-of-turn, which is
    // worse on a phone call than an inaudible re-segmentation. The remedy that
    // is actually free is Azure's, and no Kataleptic tier pairs it with a
    // gpt-realtime brain. Asserted rather than left implicit so that flipping
    // it is a deliberate edit here and in TURN_DETECTION_BY_TIER.
    expect(await turnDetection('gpt-realtime-2')).toEqual(TUNED_SERVER_VAD);
  });

  it('keeps 2.1 on server VAD given the observed semantic detector tail', async () => {
    // A null paired median (+106 ms) did not exclude a measured TTFA p90
    // increase of 3490 ms in 20 pairs. This pins the configured detector;
    // it does not test a latency distribution or prove model equivalence.
    expect(await turnDetection('gpt-realtime-2.1')).toEqual(TUNED_SERVER_VAD);
  });

  it('keeps 2.1-mini on server VAD after incomplete split mitigation', async () => {
    // Semantic VAD left 4/12 observed splits with TTFA p90 5123 ms.
    expect(await turnDetection('gpt-realtime-2.1-mini')).toEqual(TUNED_SERVER_VAD);
  });

  it('gives a tier nobody has measured the tuned server VAD, not an untuned default', async () => {
    // A new tier id reaching the fallback must still get the settings that were
    // tuned against real ambient noise, not whatever the service defaults to
    // (Voice Live: 200 ms of silence; the GA surface: 500).
    expect(await turnDetection('gpt-realtime-9-unreleased')).toEqual(TUNED_SERVER_VAD);
  });

  it('never moves the HD tier off server VAD, which would fail every call at session start', async () => {
    // Probed live: `semantic_vad` here is translated by the gateway to
    // azure_semantic_vad_multilingual and then rejected — "Cannot change turn
    // detection type during session" — because the gateway's own injected
    // session.update has already set the type. This is not a preference; any
    // other detector type breaks the tier outright.
    expect(await turnDetection('kataleptic-realtime-hd')).toEqual(TUNED_SERVER_VAD);
  });

  it('never moves cascade tiers off server VAD, which would silently lose the tuning', async () => {
    // The worse failure of the two, because nothing errors. Probed live, the
    // cascade *accepts* `semantic_vad` and serves `server_vad` back at Azure's
    // defaults (0.5 / 500) — the call runs on settings nobody chose, and only
    // the session.updated echo shows it. A confirmed-different config must not
    // read as valid.
    expect(await turnDetection('kataleptic-realtime')).toEqual(TUNED_SERVER_VAD);
  });

  it('never asks for noise reduction, on any tier', async () => {
    // azure_deep_noise_suppression returns an empty transcript for ~32% of
    // English utterances and takes clean-audio WER from 4.8% to 47.8%, and
    // improves robustness nowhere. Not setting it is already correct; this is
    // what stops it being added later as an improvement.
    const keys = (v: unknown): string[] =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.entries(v as Record<string, unknown>).flatMap(([k, val]) => [k, ...keys(val)])
        : [];
    for (const model of ['gpt-realtime-2', 'kataleptic-realtime-hd', 'kataleptic-realtime']) {
      const offenders = keys(await sessionFor(model)).filter((k) => /noise/i.test(k));
      expect(offenders, `${model} session payload asks for noise reduction`).toEqual([]);
    }
  });
});

describe('session echo read-back', () => {
  // The gateway dials its upstream lazily and injects a session.update of its
  // own, which races with ours and wins about 1 session in 8 — the same race
  // that swapped the STT model on 22 of 25 turns in the latency benchmark. The
  // benchmark rejects those sessions; production cannot, so it re-asserts.
  type Sess = {
    instructions?: string;
    audio?: {
      input?: { turn_detection?: Record<string, unknown>; transcription?: Record<string, unknown> };
      output?: { voice?: string; format?: Record<string, unknown> };
    };
  };

  /** Start a realtime call and hand back the engine socket plus what we sent. */
  const started = async (realtime_model = '') => {
    const { session } = newSession('realtime', { realtime_model });
    await session.fetch(upgradeRequest());
    serverSockets.at(-1)!.receive({ type: 'start' });
    await flush();
    const up = upstreamSockets.at(-1)!;
    up.emit('open', {});
    await flush();
    const sent = up.messages().find((m) => m.type === 'session.update')!.session as Sess;
    return { up, sent };
  };

  const echo = (up: FakeSocket, session: Sess) => up.receive({ type: 'session.updated', session });
  const updatesSent = (up: FakeSocket) => up.messages().filter((m) => m.type === 'session.update').length;
  /** A copy of what we sent, with the turn detector quietly replaced. */
  const substituted = (sent: Sess): Sess => {
    const s = structuredClone(sent);
    s.audio!.input!.turn_detection = { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 200 };
    return s;
  };

  it('re-sends the payload when the engine applied a different turn detector', async () => {
    const { up, sent } = await started();
    echo(up, substituted(sent));
    await flush();
    expect(updatesSent(up)).toBe(2);
    // Byte-identical to the original, not a rebuild — a rebuild could differ
    // from what the comparison was made against.
    const [first, second] = up.messages().filter((m) => m.type === 'session.update');
    expect(second.session).toEqual(first.session);
  });

  it('stays quiet when the echo matches what we asked for', async () => {
    const { up, sent } = await started();
    // Services add their own defaults on top; extra fields are not a mismatch,
    // only fields we set coming back changed are.
    const s = structuredClone(sent);
    s.audio!.input!.turn_detection!.create_response = true;
    echo(up, s);
    await flush();
    expect(updatesSent(up)).toBe(1);
  });

  it('ignores the gateway session that is not ours', async () => {
    // The gateway's own injected update produces an echo of its own, and it
    // arrives first. Treating it as a failed read-back would re-send on every
    // single call — the discriminator is whose instructions came back.
    const { up, sent } = await started();
    const theirs = substituted(sent);
    theirs.instructions = 'gateway defaults';
    echo(up, theirs);
    await flush();
    expect(updatesSent(up)).toBe(1);
  });

  it('gives up rather than looping when the engine keeps substituting', async () => {
    const { up, sent } = await started();
    for (let i = 0; i < 6; i++) {
      echo(up, substituted(sent));
      await flush();
    }
    // Two re-sends, then it stops and complains. An unbounded read-back is a
    // message loop with an engine that has made its position clear.
    expect(updatesSent(up)).toBe(3);
  });

  it('says nothing about a voice the tier picked for itself', async () => {
    // gpt-realtime tiers are deliberately sent no voice ('' = tier default) and
    // echo back the one they chose (`marin`, live on all three). Diffing that
    // unconditionally reported a substitution on *every* native call — and a
    // diagnostic that fires on every call is one that gets filtered out within
    // a day, taking the real substitutions with it. "Absent counts as a
    // mismatch" is right when the echo dropped something we asked for, and
    // wrong when we deliberately asked for nothing.
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
    try {
      const { up, sent } = await started('gpt-realtime-2');
      expect(sent.audio?.output?.voice, 'the tier should be sent no voice at all').toBeUndefined();
      const s = structuredClone(sent);
      s.audio!.output = { ...s.audio!.output, voice: 'marin' };
      echo(up, s);
      await flush();
      expect(logged.filter((l) => l.includes('session echo differs'))).toEqual([]);
      expect(updatesSent(up)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('re-asserts the vocabulary prompt a native tier dropped', async () => {
    // The reason transcription moved from advisory to enforced. The gateway's
    // injected default lands after ours and replaces the whole transcription
    // object, taking `sttVocab` with it. It is a race, not an override — an
    // update sent after theirs keeps our config, 18/18 across the three native
    // tiers — so the read-back re-sends instead of writing it down.
    const { up, sent } = await started('gpt-realtime-2');
    expect(sent.audio?.input?.transcription?.prompt, 'native tiers send the vocab prompt').toBeTruthy();
    const s = structuredClone(sent);
    s.audio!.input!.transcription = { model: 'whisper', language: null, prompt: null };
    echo(up, s);
    await flush();
    expect(updatesSent(up)).toBe(2);
    const [first, second] = up.messages().filter((m) => m.type === 'session.update');
    expect(second.session).toEqual(first.session);
  });

  it('does not fight the HD tier over a transcription it cannot set', async () => {
    // HD is the one tier where re-sending provably loses: Azure Voice Live
    // latches `input_audio_transcription` on the first `session.update` of the
    // session and ignores every later one, and the gateway spends that first
    // update on its own voice default. 0/18 across three strategies. Enforcing
    // it here would burn both re-sends on every HD call and report a failure
    // nobody can act on.
    const { up, sent } = await started('kataleptic-realtime-hd');
    const s = structuredClone(sent);
    s.audio!.input!.transcription = { ...s.audio!.input!.transcription, model: 'azure-speech' };
    echo(up, s);
    await flush();
    expect(updatesSent(up)).toBe(1);
  });

  it('never re-sends on the cascade tier, which does not diverge', async () => {
    // "Should never fire" is what transcription's advisory status rested on,
    // and that premise turned out to be the losing half of a race — so pin it.
    // The cascade echoes the transcription config verbatim, 6/6 measured, and
    // sends no injected session.update of its own, so the enforced path must
    // stay dormant there for the whole life of the call.
    const { up, sent } = await started('llama-3.3-70b');
    expect(sent.audio?.input?.transcription?.prompt, 'the cascade gets the vocab prompt').toBeTruthy();
    echo(up, structuredClone(sent));
    await flush();
    // and a later echo of the same session must not start a re-send either
    echo(up, structuredClone(sent));
    await flush();
    expect(updatesSent(up)).toBe(1);
  });

  it('does not send the HD tier a vocabulary prompt it cannot apply', async () => {
    // Azure answers `prompt is not yet supported for azure-speech`, and the
    // latch above means it could not take effect even if it did. Sending it
    // would buy one advisory line per HD call about a field nobody can apply.
    const { sent } = await started('kataleptic-realtime-hd');
    expect(sent.audio?.input?.transcription).toBeTruthy();
    expect(sent.audio?.input?.transcription?.prompt).toBeUndefined();
  });

  it('re-sends when the echo drops the whole audio block, not just a leaf', async () => {
    // The widened comparison reports one ancestor divergence — `session.audio
    // absent — unverifiable` — where the per-path version reported one per
    // enforced path. Matching only at-or-below an enforced path made the worst
    // case (detector, formats and transcription all unverifiable at once) the
    // quietest: advisory, no re-send. Absence must not read as the weaker
    // signal.
    const { up, sent } = await started('gpt-realtime-2');
    const s = structuredClone(sent) as Sess & { audio?: unknown };
    delete s.audio;
    echo(up, s);
    await flush();
    expect(updatesSent(up)).toBe(2);
  });

  it('classifies by structure, not by how a divergence is worded', async () => {
    // The classification used to string-match `diffSession`'s human-readable
    // output against each enforced path, so a change to the message format
    // would silently move an enforced divergence into advisory and skip the
    // re-send. Pinned two ways, both independent of wording: a substitution
    // *under* an enforced path re-sends, and a substitution nowhere near one
    // does not — and the whole-block drop above covers the ancestor case that
    // the string matcher needed a special clause for.
    const { up, sent } = await started('gpt-realtime-2');
    const under = structuredClone(sent);
    under.audio!.input!.format = { type: 'audio/pcmu' };
    echo(up, under);
    await flush();
    expect(updatesSent(up), 'a substituted format is enforced').toBe(2);

    const { up: up2, sent: sent2 } = await started('gpt-realtime-2');
    const outside = structuredClone(sent2) as Sess & { instructions?: string; tools?: unknown[] };
    outside.tools = [];
    echo(up2, outside);
    await flush();
    expect(updatesSent(up2), 'tools are not worth a re-send').toBe(1);
  });

  it('reports a divergence outside the enforced subtrees without re-sending', async () => {
    // The read-back covers the whole payload now, not a list of subtrees
    // somebody remembered to add. Measured first: on all five tiers nothing
    // outside `transcription` diverges on a healthy call, so the wider net
    // costs no noise.
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
    try {
      const { up, sent } = await started('gpt-realtime-2');
      const s = structuredClone(sent) as Sess & { tool_choice?: string };
      s.tool_choice = 'none';
      echo(up, s);
      await flush();
      expect(updatesSent(up), 'tool_choice is not worth a re-send').toBe(1);
      expect(logged.some((l) => l.includes('session.tool_choice')), `expected an advisory line, got ${JSON.stringify(logged)}`).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps a superseded socket off the replacement connection', async () => {
    // Third instance of the same bug in this file: two sockets are alive during
    // a rotation, and per-connection state was being held per call. A late echo
    // from the outgoing socket was compared against the *replacement's* config,
    // spent the replacement's retry budget, and pushed a re-send at a socket
    // about to close.
    vi.useFakeTimers();
    const { up, sent } = await started();

    up.receive({ type: 'session.expiring' });
    await flush();
    const newUp = upstreamSockets.at(-1)!;

    // The handover itself: the replacement has just been configured, and the
    // outgoing socket has not been closed yet. Resume the fetch continuation
    // only; a full flush would finish recovery and erase the overlap window.
    newUp.emit('open', {});
    await Promise.resolve();
    expect(updatesSent(newUp)).toBe(1);
    expect(up.readyState).toBe(1); // still open, still serving the caller

    // A late, substituted echo from the connection being rotated out. It is
    // still serving the caller for the rest of the window, so it is answered —
    // on its own socket, out of its own budget.
    echo(up, substituted(sent));
    await flush();
    expect(updatesSent(up)).toBe(2); // answered where it came from
    expect(updatesSent(newUp)).toBe(1); // and nothing pushed at the replacement

    // The replacement's budget is untouched: it still has both its re-sends.
    const resumed = newUp.messages().find((m) => m.type === 'session.update')!.session as Sess;
    echo(newUp, substituted(resumed));
    await flush();
    echo(newUp, substituted(resumed));
    await flush();
    expect(updatesSent(newUp)).toBe(3);
  });

  it('re-asserts on the replacement connection after a rotation', async () => {
    // A rotation sends a fresh configuration, so it gets its own budget and
    // becomes what later echoes are compared against — and the re-send has to
    // reach the socket that answered, which mid-rotation is not the one the
    // exhausted budget belonged to.
    vi.useFakeTimers();
    const { up, sent } = await started();
    for (let i = 0; i < 3; i++) {
      echo(up, substituted(sent));
      await flush();
    }
    expect(updatesSent(up)).toBe(3); // budget spent on the outgoing connection

    up.receive({ type: 'session.expiring' });
    await flush();
    const newUp = upstreamSockets.at(-1)!;
    expect(newUp).not.toBe(up);
    newUp.emit('open', {});
    await flush();
    expect(updatesSent(newUp)).toBe(1);

    const resumed = newUp.messages().find((m) => m.type === 'session.update')!.session as Sess;
    echo(newUp, substituted(resumed));
    await flush();
    expect(updatesSent(newUp)).toBe(2); // fresh configuration, fresh budget
    expect(updatesSent(up)).toBe(3); // and nothing went to the old socket
  });
});

describe('upstream connect timeout', () => {
  it('cancels the pending upgrade and ignores a late synthetic completion', async () => {
    vi.useFakeTimers();
    const { session } = newSession('realtime');
    await session.fetch(upgradeRequest());
    const sock = serverSockets[0];

    sock.receive({ type: 'start' });
    await vi.advanceTimersByTimeAsync(6000); // past the 5 s connect timeout
    await flush();

    expect(upstreamSockets).toHaveLength(1);
    const zombie = upstreamSockets[0];
    expect(zombie.closed).not.toBeNull(); // fake fetch disposed its pending socket on abort

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

  it('recovers from a second engine drop, not just the first', async () => {
    // `reconnects` bounds attempts within one recovery episode; it was never
    // given back after a successful one, so it silently became a second,
    // stricter whole-call cap. A call that survived one drop was hung up on by
    // the next — which took the exhausted-budget branch without dialling at
    // all — while MAX_TOTAL_RECONNECTS still permitted several more.
    vi.useFakeTimers();
    const { session, callUpdates } = newSession('realtime');
    await session.fetch(upgradeRequest());
    const client = serverSockets[0];
    client.receive({ type: 'start' });
    await flush();
    upstreamSockets[0].emit('open', {});
    await flush();

    // First drop: recovery connects a replacement.
    upstreamSockets[0].close(1006, 'engine dropped');
    await flush();
    expect(upstreamSockets).toHaveLength(2);
    upstreamSockets[1].emit('open', {});
    await flush();
    expect(client.typesSent()).not.toContain('error');

    // Second drop, later in the same call: it must try again.
    upstreamSockets[1].close(1006, 'engine dropped again');
    await flush();
    expect(upstreamSockets).toHaveLength(3); // dialled, rather than giving up
    upstreamSockets[2].emit('open', {});
    await flush();

    expect(client.typesSent()).not.toContain('error');
    expect(client.readyState).toBe(1);
    expect(callUpdates()).toHaveLength(0); // the call is still going
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
        headers: new Headers(), body: jsonStream({
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
        headers: new Headers(), body: jsonStream({
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
      headers: new Headers(), body: jsonStream({
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
        headers: new Headers(), body: jsonStream({
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
        headers: new Headers(), body: jsonStream({
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


describe('telephone audio capabilities', () => {
  it('rejects a pipeline telephone call before advertising readiness', async () => {
    const { session, ctl, callUpdates } = newSession();
    ctl.channel = 'telnyx';
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush(100);
    expect(serverSockets[0].countOf('ready')).toBe(0);
    expect(serverSockets[0].countOf('ended')).toBe(1);
    expect(callUpdates().some(w => w.args.includes('failed'))).toBe(true);
  });

  it('does not fall back to browser pipeline when the realtime connection fails', async () => {
    const { session, ctl } = newSession('realtime');
    ctl.channel = 'telnyx';
    vi.spyOn(session as never, 'startRealtime').mockResolvedValue(false as never);
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush(100);
    expect(serverSockets[0].countOf('ready')).toBe(0);
    expect(serverSockets[0].countOf('ended')).toBe(1);
  });

  it('rejects a realtime tier whose greeting would require browser speech synthesis', async () => {
    const { session, ctl } = newSession('realtime');
    ctl.channel = 'telnyx';
    vi.spyOn(session as never, 'startRealtime').mockResolvedValue(true as never);
    vi.spyOn(session as never, 'engineGreets').mockReturnValue(false as never);
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush(100);
    expect(serverSockets[0].countOf('ready')).toBe(0);
    expect(serverSockets[0].countOf('ended')).toBe(1);
  });

  it('finalizes a telephone call when server synthesis returns empty audio', async () => {
    const { session, ctl, callUpdates } = newSession('realtime', {}, {DEFAULT_TTS_PROVIDER:'azure', AZURE_SPEECH_KEY:'synthetic-unit-test-key'});
    ctl.channel = 'telnyx';
    vi.spyOn(session as never, 'startRealtime').mockResolvedValue(true as never);
    vi.spyOn(session as never, 'engineGreets').mockReturnValue(false as never);
    globalThis.fetch = vi.fn(async () => ({ok:true, arrayBuffer:async () => new ArrayBuffer(0)})) as unknown as typeof fetch;
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush(100);
    expect(serverSockets[0].countOf('ended')).toBe(1);
    expect(serverSockets[0].binaryCount()).toBe(0);
    expect(serverSockets[0].countOf('ready')).toBe(0);
    expect(callUpdates().some(w => w.args.includes('Telephone greeting audio could not be generated.'))).toBe(true);
  });

  it('holds carrier readiness through delayed synthesis, then queues greeting immediately', async () => {
    const { session, ctl } = newSession('realtime', {}, {DEFAULT_TTS_PROVIDER:'azure', AZURE_SPEECH_KEY:'synthetic-unit-test-key'});
    ctl.channel = 'telnyx';
    vi.spyOn(session as never, 'startRealtime').mockResolvedValue(true as never);
    vi.spyOn(session as never, 'engineGreets').mockReturnValue(false as never);
    const audio = new ArrayBuffer(4800);
    let release!: (audio: ArrayBuffer) => void;
    const pending = new Promise<ArrayBuffer>(resolve => { release = resolve; });
    const synth = vi.fn(async () => ({ok:true, arrayBuffer: () => pending}));
    globalThis.fetch = synth as unknown as typeof fetch;
    await session.fetch(upgradeRequest());
    const socket = serverSockets[0];
    socket.receive({ type: 'start' });
    await flush(100);
    expect(synth).toHaveBeenCalledOnce();
    expect(socket.countOf('ready')).toBe(0);
    expect(socket.binaryCount()).toBe(0);
    // A ready consumer resumes on the next microtask: PCM must already be queued.
    const send = socket.send.bind(socket);
    let queuedAtReady = false;
    vi.spyOn(socket, 'send').mockImplementation(data => {
      send(data);
      if (typeof data === 'string' && JSON.parse(data).type === 'ready') {
        queueMicrotask(() => { const first = socket.sent[socket.sent.findIndex(value => typeof value === 'string' && JSON.parse(value).type === 'ready') + 1]; queuedAtReady = first instanceof ArrayBuffer && first.byteLength === audio.byteLength; });
      }
    });
    release(audio);
    await flush(100);
    expect(socket.countOf('ready')).toBe(1);
    expect(queuedAtReady).toBe(true);
    expect(socket.binaryCount()).toBe(1);
    socket.receive({type:'hangup'});
    await flush(100);
  });

  it('does not announce readiness or send late greeting after hangup during synthesis', async () => {
    const { session, ctl } = newSession('realtime', {}, {DEFAULT_TTS_PROVIDER:'azure', AZURE_SPEECH_KEY:'synthetic-unit-test-key'});
    ctl.channel = 'telnyx';
    vi.spyOn(session as never, 'startRealtime').mockResolvedValue(true as never);
    vi.spyOn(session as never, 'engineGreets').mockReturnValue(false as never);
    let release!: (audio: ArrayBuffer) => void;
    const pending = new Promise<ArrayBuffer>(resolve => { release = resolve; });
    globalThis.fetch = vi.fn(async () => ({ok:true, arrayBuffer: () => pending})) as unknown as typeof fetch;
    await session.fetch(upgradeRequest());
    const socket = serverSockets[0];
    socket.receive({type:'start'});
    await flush(100);
    socket.receive({type:'hangup'});
    await flush(100);
    release(new ArrayBuffer(4800));
    await flush(100);
    expect(socket.countOf('ready')).toBe(0);
    expect(socket.binaryCount()).toBe(0);
    expect(socket.countOf('ended')).toBe(1);
  });

  it('allows native realtime greeting audio without a browser TTS provider', async () => {
    const { session, ctl } = newSession('realtime');
    ctl.channel = 'telnyx';
    vi.spyOn(session as never, 'startRealtime').mockResolvedValue(true as never);
    vi.spyOn(session as never, 'engineGreets').mockReturnValue(true as never);
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush(100);
    const pending = (session as unknown as { nativeGreeting: { frames: ArrayBuffer[]; resolve: (ok: boolean) => void } }).nativeGreeting;
    pending.frames.push(new ArrayBuffer(4)); pending.resolve(true);
    await flush(80);
    expect(serverSockets[0].messages().find(m => m.type === 'ready')).toMatchObject({mode: 'realtime', greeting: ''});
    expect(serverSockets[0].countOf('ended')).toBe(0);
    serverSockets[0].receive({type:'hangup'});
    await flush(100);
  });
});

describe('direct OpenAI realtime independence', () => {
  const directSettings = {
    realtime_provider: 'openai', realtime_api_key: 'synthetic-openai-key',
    realtime_model: '', realtime_voice: 'marin',
    llm_base_url: 'https://api.openai.com/v1', llm_api_key: 'synthetic-text-key', llm_model: 'gpt-4o-mini',
  };
  it('runs greeting, PCM, interruption, tool hangup and persisted summary with gateway endpoints unavailable', async () => {
    vi.useFakeTimers();
    const upstream = new FakeSocket();
    const requests: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      requests.push({ url: String(url), init: init! });
      if (String(url) === 'https://api.openai.com/v1/realtime?model=gpt-realtime') return { status: 101, webSocket: upstream } as never;
      if (String(url) === 'https://api.openai.com/v1/chat/completions') return {
        ok: true, status: 200,
        headers: new Headers(), body: jsonStream({ choices: [{ message: { content: JSON.stringify({ summary: 'Caller requested a callback.', intent: 'message', message: 'Please call tomorrow.' }) } }] }),
      } as never;
      throw new Error('Non-OpenAI network destination blocked');
    });
    const { session, turnWrites, callUpdates } = newSession('realtime', directSettings, {
      REALTIME_BASE_URL: 'wss://unavailable.kataleptic.invalid/v1/realtime',
      DEFAULT_LLM_BASE_URL: 'https://unavailable.kataleptic.invalid/v1',
      DEFAULT_LLM_API_KEY: '', REALTIME_API_KEY: '', AZURE_SPEECH_KEY: '',
    });
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0];
    caller.receive({ type: 'start' });
    await flush(50);
    expect(upstreamSockets).toHaveLength(0); // direct path uses header-authenticated Worker upgrade
    expect(requests[0].init.headers).toEqual({ Upgrade: 'websocket', Authorization: 'Bearer synthetic-openai-key' });
    expect(requests[0].init.redirect).toBe('manual');
    const update = upstream.messages().find(m => m.type === 'session.update')!;
    expect(update.session).toMatchObject({ output_modalities: ['audio'], audio: { input: { transcription: { model: 'whisper-1' } }, output: { voice: 'marin', format: { type: 'audio/pcm', rate: 24000 } } } });
    expect(caller.countOf('ready')).toBe(0);
    expect(upstream.countOf('response.create')).toBe(0);
    upstream.receive({ type: 'session.updated', session: update.session });
    await flush();
    expect(caller.countOf('ready')).toBe(1);
    expect(upstream.countOf('response.create')).toBe(1);
    upstream.receive({ type: 'response.output_audio_transcript.done', transcript: 'Hello, how may I help?' });
    upstream.receive({ type: 'response.output_audio.delta', item_id: 'greeting-item', content_index: 0, delta: 'AAAAAA==' });
    await flush();
    expect(caller.binaryCount()).toBe(1);
    upstream.receive({ type: 'input_audio_buffer.speech_started' });
    expect(caller.countOf('flush')).toBe(1);
    expect(upstream.messages().find(m => m.type === 'conversation.item.truncate')).toMatchObject({ item_id: 'greeting-item', content_index: 0, audio_end_ms: 0 });
    upstream.receive({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Please call me tomorrow.' });
    await flush();
    upstream.receive({ type: 'response.output_audio_transcript.done', transcript: 'I will pass along your message. Goodbye.' });
    upstream.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' });
    upstream.receive({ type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'tool-1', arguments: '{}' });
    upstream.receive({ type: 'response.done' });
    await flush();
    expect(caller.countOf('ending')).toBe(1);
    caller.receive({ type: 'hangup' });
    await flush(100);
    expect(turnWrites()).toHaveLength(3);
    expect(callUpdates().some(w => w.args.includes('Caller requested a callback.'))).toBe(true);
    expect(caller.countOf('ended')).toBe(1);
    expect(requests).toHaveLength(2); // no greeting synthesis, STT catalog or gateway request
  });

  it.each(['startup', 'rotation'])('keeps pending direct application events inert during %s', async phase => {
    vi.useFakeTimers();
    const first = new FakeSocket();
    const replacement = new FakeSocket();
    let upgrades = 0;
    globalThis.fetch = vi.fn(async () => ({ status: 101, webSocket: upgrades++ === 0 ? first : replacement })) as unknown as typeof fetch;
    const { session, turnWrites } = newSession('realtime', directSettings);
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0];
    caller.receive({ type: 'start' });
    await flush(50);
    const acknowledge = (socket: FakeSocket) => socket.receive({
      type: 'session.updated', session: socket.messages().find(m => m.type === 'session.update')!.session,
    });
    if (phase === 'rotation') {
      acknowledge(first);
      await flush();
      first.receive({ type: 'session.expiring' });
      await flush(50);
    }
    const pending = phase === 'startup' ? first : replacement;
    pending.receive({ type: 'session.updated', session: { instructions: 'Unrelated configuration' } });
    pending.receive({ type: 'response.output_audio.delta', item_id: 'pending-audio', delta: 'AAAAAA==' });
    pending.receive({ type: 'response.output_audio_transcript.done', transcript: 'Unacknowledged assistant' });
    pending.receive({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Unacknowledged caller' });
    pending.receive({ type: 'input_audio_buffer.speech_started' });
    pending.receive({ type: 'response.function_call_arguments.done', name: 'end_call' });
    pending.receive({ type: 'response.output_item.done', item: { type: 'function_call', name: 'end_call' } });
    await flush(50);
    expect(caller.binaryCount()).toBe(0);
    expect(turnWrites()).toHaveLength(0);
    expect(caller.countOf('ready')).toBe(phase === 'startup' ? 0 : 1);
    expect(caller.countOf('ending')).toBe(0);
    expect(caller.countOf('flush')).toBe(0);
    if (phase === 'rotation') {
      expect(first.closed).toBeNull();
      first.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' });
      first.receive({ type: 'response.output_audio_transcript.done', transcript: 'Acknowledged old socket' });
      caller.receive({ type: 'text', text: 'Still here' });
      await flush(50);
      expect(caller.binaryCount()).toBe(1);
      expect(turnWrites()).toHaveLength(2);
      expect(first.messages().some(m => m.type === 'conversation.item.create')).toBe(true);
      expect(pending.messages().some(m => m.type === 'conversation.item.create')).toBe(false);
    }
    acknowledge(pending);
    await flush(50);
    pending.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' });
    pending.receive({ type: 'response.output_audio_transcript.done', transcript: 'Now acknowledged' });
    await flush(50);
    expect(caller.binaryCount()).toBe(phase === 'startup' ? 1 : 2);
    expect(turnWrites()).toHaveLength(phase === 'startup' ? 1 : 3);
    expect(caller.countOf('ready')).toBe(1);
    if (phase === 'rotation') expect(first.closed).not.toBeNull();
  });

  it.each(['error', 'timeout', 'oversized-json', 'oversized-audio'])('keeps the acknowledged socket when replacement handshake fails by %s', async failure => {
    vi.useFakeTimers();
    const old = new FakeSocket();
    const replacement = new FakeSocket();
    let upgrades = 0;
    globalThis.fetch = vi.fn(async () => ({ status: 101, webSocket: upgrades++ === 0 ? old : replacement })) as unknown as typeof fetch;
    const { session, turnWrites } = newSession('realtime', directSettings);
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0];
    caller.receive({ type: 'start' });
    await flush(50);
    old.receive({ type: 'session.updated', session: old.messages().find(m => m.type === 'session.update')!.session });
    await flush();
    old.receive({ type: 'session.expiring' });
    await flush(50);
    replacement.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' });
    replacement.receive({ type: 'response.function_call_arguments.done', name: 'end_call' });
    if (failure === 'error') replacement.receive({ type: 'error' });
    else if (failure === 'oversized-json') replacement.emit('message', { data: ' '.repeat(1024 * 1024 + 1) });
    else if (failure === 'oversized-audio') replacement.receive({ type: 'response.output_audio.delta', delta: 'A'.repeat(640004) });
    else await vi.advanceTimersByTimeAsync(5001);
    await flush(50);
    expect(replacement.closed).not.toBeNull();
    expect(old.closed).toBeNull();
    expect(caller.binaryCount()).toBe(0);
    expect(caller.countOf('ending')).toBe(0);
    expect(caller.countOf('ended')).toBe(0);
    old.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' });
    old.receive({ type: 'response.output_audio_transcript.done', transcript: 'Still connected' });
    caller.receive({ type: 'text', text: 'Thank you' });
    await flush(50);
    expect(caller.binaryCount()).toBe(1);
    expect(turnWrites()).toHaveLength(2);
    expect(old.messages().some(m => m.type === 'conversation.item.create')).toBe(true);
    expect(upgrades).toBe(2);
  });

  it.each(['pending-json', 'pending-audio', 'ready-audio', 'ready-json', 'greeting-audio'])('fails closed before forwarding oversized %s', async phase => {
    const up = new FakeSocket();
    globalThis.fetch = vi.fn(async () => ({ status: 101, webSocket: up })) as unknown as typeof fetch;
    const { session, ctl, callUpdates } = newSession('realtime', directSettings);
    if (phase === 'greeting-audio') ctl.channel = 'telnyx';
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0]; caller.receive({ type: 'start' });
    await flush(50);
    if (!phase.startsWith('pending')) {
      up.receive({ type: 'session.updated', session: up.messages().find(m => m.type === 'session.update')!.session });
      await flush(50);
    }
    const parse = vi.spyOn(JSON, 'parse');
    const decode = vi.spyOn(globalThis, 'atob');
    const payload = phase.endsWith('json') ? ' '.repeat(1024 * 1024 + 1)
      : JSON.stringify({ type: 'response.output_audio.delta', delta: 'A'.repeat(640004) });
    let parses = 0, decodes = 0;
    try {
      up.emit('message', { data: payload });
      parses = parse.mock.calls.length; decodes = decode.mock.calls.length;
    } finally { parse.mockRestore(); decode.mockRestore(); }
    expect(decodes).toBe(0);
    if (phase.endsWith('json')) expect(parses).toBe(0);
    // A same-tick subsequent valid audio event cannot escape after rejection.
    up.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' });
    await flush(100);
    expect(caller.binaryCount()).toBe(0);
    if (!phase.startsWith('ready')) expect(caller.countOf('ready')).toBe(0);
    expect(up.closed).not.toBeNull();
    expect(callUpdates().some(write => write.args[0] === 'failed')).toBe(true);
  });

  it.each(['conversation.item.input_audio_transcription.completed', 'response.output_audio_transcript.done'])('rejects oversized transcript before forwarding/history/write: %s', async type => {
    const up = new FakeSocket();
    globalThis.fetch = vi.fn(async () => ({ status: 101, webSocket: up })) as unknown as typeof fetch;
    const { session, turnWrites, callUpdates } = newSession('realtime', directSettings);
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0]; caller.receive({ type: 'start' });
    await flush(50);
    up.receive({ type: 'session.updated', session: up.messages().find(m => m.type === 'session.update')!.session });
    await flush(50);
    const transcript = '€'.repeat(2731);
    up.receive({ type, transcript });
    await flush(100);
    expect(turnWrites()).toHaveLength(0);
    expect(caller.messages().filter(m => m.type === 'agent_text' || m.type === 'transcript')).toHaveLength(0);
    expect((session as unknown as { history: { content: string }[] }).history.some(m => m.content === transcript)).toBe(false);
    expect(callUpdates().some(w => w.args[0] === 'failed')).toBe(true);
  });

  it('reserves transcript bytes across burst events and rotation before any await', async () => {
    const old = new FakeSocket(), replacement = new FakeSocket();
    let upgrades = 0;
    globalThis.fetch = vi.fn(async () => ({ status: 101, webSocket: upgrades++ === 0 ? old : replacement })) as unknown as typeof fetch;
    const { session, turnWrites, callUpdates } = newSession('realtime', directSettings);
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0]; caller.receive({ type: 'start' });
    await flush(50);
    old.receive({ type: 'session.updated', session: old.messages().find(m => m.type === 'session.update')!.session });
    await flush(50);
    const transcript = '€'.repeat(2730) + 'xx';
    for (let i = 0; i < 16; i++) old.receive({ type: 'response.output_audio_transcript.done', transcript });
    await flush(100);
    old.receive({ type: 'session.expiring' }); await flush(50);
    replacement.receive({ type: 'session.updated', session: replacement.messages().find(m => m.type === 'session.update')!.session });
    await flush(50);
    // A burst with no awaits fills the remaining128KiB exactly.
    for (let i = 0; i < 16; i++) replacement.receive({ type: 'response.output_audio_transcript.done', transcript });
    await flush(100);
    expect(turnWrites()).toHaveLength(32);
    expect(caller.countOf('agent_text')).toBe(32);
    expect(old.closed).not.toBeNull();
    replacement.receive({ type: 'response.output_audio_transcript.done', transcript: 'x' });
    await flush(100);
    expect(turnWrites()).toHaveLength(32);
    expect(caller.countOf('agent_text')).toBe(32);
    const history = (session as unknown as { history: { content: string }[] }).history.slice(1);
    expect(history.reduce((sum, m) => sum + new TextEncoder().encode(m.content).length, 0)).toBe(256 * 1024);
    expect(callUpdates().some(w => w.args[0] === 'failed')).toBe(true);
  });

  it.each(['reject', 'redirect', 'session-error', 'session-mismatch', 'session-timeout'])('fails closed on %s without pipeline fallback', async failure => {
    vi.useFakeTimers();
    const up = new FakeSocket();
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async url => {
      requests.push(String(url));
      if (failure === 'reject') throw new Error('Authorization: private material');
      return { status: failure === 'redirect' ? 302 : 101, webSocket: failure === 'redirect' ? null : up } as never;
    });
    const { session, callUpdates } = newSession('realtime', directSettings);
    await session.fetch(upgradeRequest());
    serverSockets[0].receive({ type: 'start' });
    await flush(50);
    if (failure === 'session-error') up.receive({ type: 'error', error: { message: 'private material' } });
    if (failure === 'session-mismatch') {
      const sent = up.messages().find(m => m.type === 'session.update')!.session as Record<string, unknown>;
      up.receive({ type: 'session.updated', session: { ...sent, audio: {} } });
    }
    if (failure === 'session-timeout') await vi.advanceTimersByTimeAsync(5001);
    await flush(80);
    expect(serverSockets[0].countOf('ready')).toBe(0);
    expect(serverSockets[0].countOf('ended')).toBe(1);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(callUpdates())).not.toContain('private material');
  });
});

describe('native greeting admission boundary', () => {
  it.each(['web', 'telnyx'])('connects direct realtime without text keys for %s startup', async channel => {
    vi.useFakeTimers();
    const up = new FakeSocket();
    const fetcher = vi.fn(async () => ({ status: 101, webSocket: up }));
    globalThis.fetch = fetcher as unknown as typeof fetch;
    const { session, ctl } = newSession('realtime', {
      realtime_provider: 'openai', realtime_api_key: 'synthetic-direct', realtime_model: '',
      llm_base_url: '', llm_api_key: '', llm_model: '',
    }, { DEFAULT_LLM_API_KEY: '', REALTIME_API_KEY: '', DEFAULT_LLM_BASE_URL: 'https://api.openai.com/v1' });
    ctl.channel = channel;
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0]; caller.receive({ type: 'start' });
    await flush(80);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.openai.com/v1/realtime?model=gpt-realtime');
    const sent = up.messages().find(m => m.type === 'session.update')!.session;
    up.receive({ type: 'session.updated', session: sent });
    up.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' });
    await flush(80);
    expect(caller.countOf('ready')).toBe(1);
    expect(caller.binaryCount()).toBe(1);
    expect(caller.countOf('error')).toBe(0);
    caller.receive({ type: 'hangup' }); await flush(80);
  });

  it('withholds carrier ready and buffered input until delayed native greeting audio exists', async () => {
    vi.useFakeTimers();
    const { session, ctl } = newSession('realtime', { realtime_model: 'gpt-realtime-2' });
    ctl.channel = 'telnyx';
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0];
    const send = caller.send.bind(caller);
    caller.send = data => {
      send(data);
      // Emulate the carrier's preReady queue, which releases on ready.
      if (typeof data === 'string' && JSON.parse(data).type === 'ready') caller.emit('message', { data: new ArrayBuffer(960) });
    };
    caller.receive({ type: 'start' }); await flush(80);
    const up = upstreamSockets[0]; up.emit('open', {}); await flush(80);
    await vi.advanceTimersByTimeAsync(1000);
    expect(up.countOf('response.create')).toBe(1);
    expect(caller.countOf('ready')).toBe(0);
    expect(up.countOf('input_audio_buffer.append')).toBe(0);
    up.receive({ type: 'response.output_audio.delta', delta: '' }); await flush();
    expect(caller.countOf('ready')).toBe(0);
    up.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' }); await flush(80);
    expect(caller.countOf('ready')).toBe(1);
    expect(caller.binaryCount()).toBe(1);
    const index = caller.sent.findIndex(data => typeof data === 'string' && JSON.parse(data).type === 'ready');
    expect(caller.sent[index + 1]).toBeInstanceOf(ArrayBuffer);
    expect(up.countOf('input_audio_buffer.append')).toBe(1);
    up.receive({ type: 'input_audio_buffer.speech_started' });
    expect(caller.countOf('flush')).toBe(1); // normal barge-in after greeting starts
    caller.receive({ type: 'hangup' }); await flush(80);
  });
});


describe('native carrier greeting failure', () => {
  it.each(['timeout', 'hangup', 'upstream-close', 'upstream-close-with-audio'])('does not announce ready after %s while waiting for native audio', async failure => {
    vi.useFakeTimers();
    const { session, ctl, callUpdates } = newSession('realtime', { realtime_model: 'gpt-realtime-2' });
    ctl.channel = 'telnyx';
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0]; caller.receive({ type: 'start' }); await flush(80);
    const up = upstreamSockets[0]; up.emit('open', {}); await flush(80);
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(5001);
    else if (failure.startsWith('upstream-close')) {
      if (failure === 'upstream-close-with-audio') up.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' });
      up.close();
    }
    else caller.receive({ type: 'hangup' });
    await flush(100);
    up.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' }); await flush();
    expect(caller.countOf('ready')).toBe(0);
    expect(caller.binaryCount()).toBe(0);
    expect(caller.countOf('ended')).toBe(1);
    expect(up.closed).not.toBeNull();
    if (failure === 'timeout') expect(callUpdates().some(w => w.args.includes('The realtime provider did not produce usable greeting audio.'))).toBe(true);
  });
});


describe('finalization duration on SQLite', () => {
  let db: SqliteD1;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T12:01:00Z'));
    db = new SqliteD1();
    applyMigrations(db, 1, 9);
    db.exec(`INSERT INTO users (id,email,password_hash) VALUES ('duration-user','duration@test.invalid','hash');
      INSERT INTO businesses (id,user_id,slug,name) VALUES ('biz-1','duration-user','duration','Duration');`);
  });
  afterEach(() => db.close());
  function seed(channel: string, connectedAt: string | null, status = 'active', duration: number | null = null) {
    db.database.prepare(`INSERT INTO calls (id,business_id,channel,status,started_at,connected_at,duration_s,outcome)
      VALUES ('call-1','biz-1',?,?,'2026-09-12 12:00:00',?,?,?)`)
      .run(channel, status, connectedAt, duration, status === 'failed' ? 'failed' : null);
    const session = newSession('pipeline', {}, { DB: db as unknown as D1Database });
    session.storage.map.set('callId', 'call-1');
    session.storage.map.set('hardDeadline', Date.now() - 1);
    return session;
  }
  const row = () => db.database.prepare('SELECT status,outcome,duration_s,ended_at FROM calls WHERE id=?').get('call-1');

  it.each(['telnyx', 'asterisk', 'web'])('excludes setup delay for connected %s calls', async channel => {
    const { session } = seed(channel, '2026-09-12 12:00:40');
    await session.alarm();
    expect(row()).toMatchObject({ status: 'completed', outcome: 'answered', duration_s: 20, ended_at: '2026-09-12 12:01:00' });
  });
  it.each(['telnyx', 'asterisk', 'web'])('preserves the unconnected %s fallback', async channel => {
    const { session } = seed(channel, null);
    await session.alarm();
    expect(row()).toMatchObject({ status: 'completed', outcome: 'answered', duration_s: 60 });
  });
  it('clamps a connection timestamp after the frozen end to zero', async () => {
    const { session } = seed('asterisk', '2026-09-12 12:01:01');
    await session.alarm();
    expect(row()).toMatchObject({ duration_s: 0 });
  });
  it.each(['completed', 'failed'])('preserves already %s carrier projections', async status => {
    const { session } = seed('asterisk', '2026-09-12 12:00:40', status, 7);
    await session.alarm();
    expect(row()).toMatchObject({ status, duration_s: 7, outcome: status === 'failed' ? 'failed' : null });
  });
  it('does not add retry delay after eviction to connected talk time', async () => {
    const { session, evictAndRebuild } = seed('telnyx', '2026-09-12 12:00:40');
    db.hook = sql => { if (sql.includes('UPDATE calls SET status')) throw new Error('write unavailable'); };
    await session.alarm();
    expect(row()).toMatchObject({ status: 'active', duration_s: null });
    db.hook = null;
    vi.setSystemTime(new Date('2026-09-12T12:11:00Z'));
    await evictAndRebuild().alarm();
    expect(row()).toMatchObject({ status: 'completed', duration_s: 20, ended_at: '2026-09-12 12:01:00' });
  });
  function carrierFailure() {
    db.database.exec("UPDATE calls SET status='failed',outcome='failed',ended_at='2026-09-12 12:00:55',carrier_released_at='2026-09-12 12:00:55',failure_code='asterisk_socket_error',failure_message='Socket failed' WHERE id='call-1'");
  }
  function conversation(session: CallSession) {
    Object.assign(session, { history: [{ role: 'system', content: 'Receptionist' }, { role: 'user', content: 'Please call tomorrow' }, { role: 'assistant', content: 'Certainly' }] });
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: jsonStream({ choices: [{ message: { content: JSON.stringify({ summary: 'Callback requested', intent: 'message', message: 'Please call tomorrow' }) } }] }) }) as never);
  }
  const details = () => db.database.prepare('SELECT * FROM calls WHERE id=?').get('call-1');
  const failedDetails = { status: 'failed', outcome: 'failed', ended_at: '2026-09-12 12:00:55', failure_code: 'asterisk_socket_error', failure_message: 'Socket failed', duration_s: 15, summary: 'Callback requested', intent: 'message' };
  it.each(['before lookup', 'during summary'])('recovers failed Asterisk conversation %s without changing its verdict', async when => {
    const { session } = seed('asterisk', '2026-09-12 12:00:40');
    conversation(session);
    if (when === 'before lookup') carrierFailure();
    else {
      const summarize = globalThis.fetch;
      globalThis.fetch = vi.fn(async (...args) => { carrierFailure(); return summarize(...args); });
    }
    await session.alarm();
    expect(details()).toMatchObject(failedDetails);
    expect(JSON.parse(details()!.message_json as string).message).toBe('Please call tomorrow');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await session.alarm();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
  it('retries failed Asterisk content projection after eviction without resummarizing or adding retry delay', async () => {
    const { session, evictAndRebuild } = seed('asterisk', '2026-09-12 12:00:40');
    conversation(session); carrierFailure();
    db.hook = sql => { if (sql.includes('UPDATE calls SET duration_s')) throw Error('content write unavailable'); };
    await session.alarm();
    expect(details()).toMatchObject({ status: 'failed', duration_s: null });
    db.hook = null;
    vi.setSystemTime(new Date('2026-09-12T12:11:00Z'));
    await evictAndRebuild().alarm();
    expect(details()).toMatchObject(failedDetails);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves completed conversation content when carrier failure arrives after finalization', async () => {
    const { session, evictAndRebuild } = seed('asterisk', '2026-09-12 12:00:40');
    conversation(session);
    await session.alarm();
    expect(details()).toMatchObject({ status: 'completed', duration_s: 20, summary: 'Callback requested' });
    carrierFailure();
    await evictAndRebuild().alarm();
    expect(details()).toMatchObject({ ...failedDetails, duration_s: 20 });
    expect(JSON.parse(details()!.message_json as string).message).toBe('Please call tomorrow');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
  it('fills only absent failed Asterisk content fields', async () => {
    const { session } = seed('asterisk', '2026-09-12 12:00:40');
    conversation(session); carrierFailure();
    db.database.exec(`UPDATE calls SET duration_s=0,summary='Prior',intent='booking',message_json='{"message":"Prior message"}'`);
    await session.alarm();
    expect(details()).toMatchObject({ ...failedDetails, duration_s: 0, summary: 'Prior', intent: 'booking', message_json: '{"message":"Prior message"}' });
  });
  it.each(['telnyx', 'unready', 'unreleased', 'other failure', 'abandoned'])('does not generate a fresh summary for %s terminal rows', async kind => {
    const { session } = seed(kind === 'telnyx' ? 'telnyx' : 'asterisk', kind === 'unready' ? null : '2026-09-12 12:00:40');
    conversation(session); carrierFailure();
    if (kind === 'unreleased') db.database.exec('UPDATE calls SET carrier_released_at=NULL');
    if (kind === 'other failure') db.database.exec("UPDATE calls SET failure_code='session_error'");
    if (kind === 'abandoned') db.database.exec("UPDATE calls SET status='abandoned'");
    await session.alarm();
    expect(details()).toMatchObject({ duration_s: null, summary: null, message_json: null });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('does not overwrite a carrier failure racing the final UPDATE', async () => {
    const { session } = seed('asterisk', '2026-09-12 12:00:40');
    db.hook = sql => {
      if (sql.includes('UPDATE calls SET status')) {
        db.database.exec("UPDATE calls SET status='failed',outcome='failed',duration_s=9 WHERE id='call-1'");
      }
    };
    await session.alarm();
    expect(row()).toMatchObject({ status: 'failed', outcome: 'failed', duration_s: 9 });
  });
});


describe('persisted transcript byte budget on SQLite', () => {
  let db: SqliteD1;
  beforeEach(() => {
    db = new SqliteD1(); applyMigrations(db, 1, 9);
    db.exec(`INSERT INTO users (id,email,password_hash) VALUES ('u','budget@test.invalid','hash');
      INSERT INTO businesses (id,user_id,slug,name) VALUES ('biz-1','u','budget','Budget');
      INSERT INTO agent_settings (business_id) VALUES ('biz-1');
      INSERT INTO calls (id,business_id) VALUES ('call-1','biz-1'),('other','biz-1');`);
  });
  afterEach(() => db.close());
  function budgetSession() {
    const value = newSession('realtime', {}, { DB: db as unknown as D1Database });
    const internals = value.session as unknown as {
      callId: string; persistedTranscriptBytes: number;
      loadCall(): Promise<void>; reserveTranscript(text: string): void;
      saveTurn(role: string, text: string): Promise<void>;
      rehydrateHistory(businessId: string, assistantId: string | null): Promise<void>;
      history: { content: string }[];
    };
    internals.callId = 'call-1';
    return { ...value, internals };
  }
  const insert = (text: string, id = 'call-1') => db.database.prepare('INSERT INTO call_turns (call_id,role,text) VALUES (?, ?, ?)').run(id, 'agent', text);
  it('reloads persisted bytes after eviction without counting another call', async () => {
    for (let i = 0; i < 31; i++) insert('x'.repeat(8192));
    insert('y'.repeat(8192), 'other');
    const { internals } = budgetSession(); await internals.loadCall();
    expect(internals.persistedTranscriptBytes).toBe(31 * 8192);
    internals.reserveTranscript('€'.repeat(2730) + 'xx');
    await internals.saveTurn('caller', '€'.repeat(2730) + 'xx');
    const rebuilt = budgetSession().internals; await rebuilt.loadCall();
    expect(() => rebuilt.reserveTranscript('x')).toThrow();
    expect(rebuilt.persistedTranscriptBytes).toBe(256 * 1024);
  });
  it('atomically refuses a stale writer at the exact persisted byte limit', async () => {
    const { internals } = budgetSession(); await internals.loadCall();
    // Another writer fills the budget after this instance loaded its counter.
    for (let i = 0; i < 32; i++) insert('x'.repeat(8192));
    await expect(internals.saveTurn('agent', 'x')).rejects.toThrow();
    const row = db.database.prepare('SELECT COUNT(*) AS n,SUM(length(CAST(text AS BLOB))) AS bytes FROM call_turns WHERE call_id=?').get('call-1');
    expect(row).toMatchObject({ n: 32, bytes: 256 * 1024 });
  });
  it('bounds historical rehydration before D1 materializes whole turns', async () => {
    for (let i = 0; i < 40; i++) insert('€'.repeat(2730) + 'xx');
    insert('x'.repeat(900000));
    const { internals } = budgetSession();
    await internals.rehydrateHistory('biz-1', null);
    expect(internals.history).toHaveLength(33);
    expect(internals.history.slice(1).reduce((n, row) => n + new TextEncoder().encode(row.content).length, 0)).toBe(256 * 1024);
  });
});


describe('transcript budget preserves native farewell ordering', () => {
  it('arms the caller farewell before an immediately following agent transcript', async () => {
    const { session, ctl } = newSession('realtime');
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0]; caller.receive({ type: 'start' });
    await flush(50);
    const up = upstreamSockets[0]; up.emit('open', {});
    await flush(50);
    up.receive({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Do you have parking?' });
    await flush(50);
    up.receive({ type: 'response.output_audio_transcript.done', transcript: 'Yes, parking is available.' });
    await flush(50);
    let release!: () => void;
    ctl.callerTurnGate = new Promise<void>(resolve => { release = resolve; });
    up.receive({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Thanks, goodbye.' });
    up.receive({ type: 'response.output_audio_transcript.done', transcript: 'Goodbye.' });
    up.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' });
    up.receive({ type: 'response.done' });
    await flush(100);
    expect(caller.countOf('ending')).toBe(1);
    expect(caller.countOf('transcript')).toBe(1); // caller insert is still pending
    release(); await flush(100);
    expect(caller.countOf('transcript')).toBe(2);
    expect(caller.countOf('agent_text')).toBe(2);
  });
});

describe('established realtime provider error policy', () => {
  async function connected(protocol: 'openai' | 'gateway' = 'openai', carrier = false, firstAudio = true) {
    const sockets = [new FakeSocket(), new FakeSocket()]; let connects = 0;
    if (protocol === 'openai') globalThis.fetch = vi.fn(async () => ({ status: 101, webSocket: sockets[connects++] })) as unknown as typeof fetch;
    const backing = newSession('realtime', protocol === 'openai'
      ? { realtime_provider: 'openai', realtime_api_key: 'synthetic-key', realtime_model: '', realtime_voice: 'marin' } as never
      : { realtime_model: 'gpt-realtime-2' });
    backing.ctl.channel = carrier ? 'telnyx' : 'web';
    await backing.session.fetch(upgradeRequest());
    const caller = serverSockets[0]; caller.receive({ type: 'start' }); await flush(50);
    const up = protocol === 'openai' ? sockets[0] : upstreamSockets[0];
    if (protocol === 'openai') up.receive({ type: 'session.updated', session: up.messages().find(m => m.type === 'session.update')!.session });
    else up.emit('open', {});
    await flush(50);
    if (carrier && firstAudio) { up.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' }); await flush(50); }
    return { ...backing, caller, up, replacement: sockets[1] };
  }
  function cancel(up: FakeSocket): string {
    // Exercise the actual vocabulary-echo cancellation path, not a test-only API.
    up.receive({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Riverside Dental' });
    return up.messages().filter(m => m.type === 'response.cancel').at(-1)!.event_id as string;
  }
  const raceError = (eventId: string) => ({ type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', event_id: eventId, message: 'synthetic private cancellation details' } });

  it.each(['openai', 'gateway'] as const)('fails established %s errors without leaking payload or waiting for close', async protocol => {
    const { up, caller, callUpdates } = await connected(protocol);
    const secret = 'private-provider-error-detail';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      up.receive({ type: 'error', error: { type: secret, code: secret, message: secret.repeat(1000), param: secret, event_id: secret } });
      // The provider leaves its socket open; our code must stop subsequent output.
      up.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' });
      await flush(100);
      expect(caller.countOf('error')).toBe(1); expect(caller.countOf('ended')).toBe(1);
      expect(up.closed).not.toBeNull(); expect(caller.binaryCount()).toBe(0);
      const update = callUpdates().find(w => w.args[0] === 'failed'); expect(update).toBeDefined();
      expect(String(update!.args[3]).length).toBeLessThan(256);
      expect(JSON.stringify([caller.messages(), callUpdates(), log.mock.calls])).not.toContain(secret);
    } finally { log.mockRestore(); }
  });

  it.each(['openai', 'gateway'] as const)('fails a %s error during firstPCM wait before ready', async protocol => {
    const { up, caller, callUpdates } = await connected(protocol, true, false);
    up.receive({ type: 'error', error: { code: 'rate_limit_exceeded' } });
    up.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' });
    await flush(100);
    expect(caller.countOf('ready')).toBe(0); expect(caller.binaryCount()).toBe(0);
    expect(callUpdates().some(w => w.args[0] === 'failed')).toBe(true);
  });

  it.each(['openai', 'gateway'] as const)('keeps %s alive for a correlated benign cancel race', async protocol => {
    const { up, caller, callUpdates } = await connected(protocol);
    const id = cancel(up); expect(id.length).toBeLessThan(128);
    up.receive(raceError(id)); up.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' });
    await flush(50);
    expect(caller.countOf('error')).toBe(0); expect(up.closed).toBeNull(); expect(caller.binaryCount()).toBe(1);
    caller.receive({ type: 'hangup' }); await flush(100);
    expect(callUpdates().some(w => w.args[0] === 'completed')).toBe(true);
  });

  it.each(['unmatched', 'expired', 'replayed', 'evicted', 'different-error'])('does not exempt %s cancellation metadata', async reason => {
    vi.useFakeTimers();
    const { up, caller, callUpdates } = await connected();
    let id = cancel(up);
    if (reason === 'unmatched') id = 'not-locally-issued';
    if (reason === 'expired') await vi.advanceTimersByTimeAsync(10001);
    if (reason === 'replayed') { up.receive(raceError(id)); await flush(); }
    if (reason === 'evicted') for (let i = 0; i < 4; i++) cancel(up);
    const event = raceError(id);
    if (reason === 'different-error') event.error.code = 'server_error';
    up.receive(event); await flush(100);
    expect(caller.countOf('error')).toBe(1);
    expect(callUpdates().some(w => w.args[0] === 'failed')).toBe(true);
  });

  it('does not carry a cancellation exemption across an acknowledged rotation', async () => {
    const { up, replacement, caller, callUpdates } = await connected();
    const id = cancel(up);
    up.receive({ type: 'session.expiring' }); await flush(50);
    replacement.receive({ type: 'session.updated', session: replacement.messages().find(m => m.type === 'session.update')!.session });
    await flush(50); expect(up.closed).not.toBeNull();
    replacement.receive(raceError(id)); await flush(100);
    expect(caller.countOf('error')).toBe(1);
    expect(callUpdates().some(w => w.args[0] === 'failed')).toBe(true);
  });
});


describe('synthesized carrier greeting size admission', () => {
  it.each(['telnyx', 'asterisk'])('admits exact ten-second %s greeting only after synthesis, with ready then PCM in one turn', async channel => {
    const { session, ctl } = newSession('realtime', {}, { DEFAULT_TTS_PROVIDER: 'azure', AZURE_SPEECH_KEY: 'synthetic-unit-test-key' });
    ctl.channel = channel;
    vi.spyOn(session as never, 'startRealtime').mockResolvedValue(true as never);
    vi.spyOn(session as never, 'engineGreets').mockReturnValue(false as never);
    let release!: (audio: ArrayBuffer) => void;
    const pending = new Promise<ArrayBuffer>(resolve => { release = resolve; });
    globalThis.fetch = vi.fn(async () => ({ ok: true, arrayBuffer: () => pending })) as unknown as typeof fetch;
    await session.fetch(upgradeRequest());
    const socket = serverSockets[0]; socket.receive({ type: 'start' }); await flush(100);
    expect(socket.countOf('ready')).toBe(0); expect(socket.binaryCount()).toBe(0);
    vi.useFakeTimers();
    const ended = vi.fn(); let carrierFrames = 0;
    const adapter = channel === 'asterisk'
      ? new (await import('../src/asterisk-media')).AsteriskMediaAdapter({
        carrierSend: data => { if (data instanceof ArrayBuffer) { expect(data.byteLength).toBe(160); carrierFrames++; } },
        sessionSend() {}, onEnd: ended,
      })
      : new (await import('../src/telnyx-media')).TelnyxMediaAdapter({
        expected: { callControlId: 'c', callSessionId: 's', callLegId: 'l', authToken: 'token' },
        carrierSend: data => { const message = JSON.parse(data); if (message.event === 'media') { expect(atob(message.media.payload).length).toBe(160); carrierFrames++; } },
        sessionSend() {}, onEnd: ended,
      });
    if (channel === 'asterisk') await adapter.carrierMessage(JSON.stringify({ event: 'MEDIA_START', connection_id: 's', channel: 'test', format: 'ulaw', optimal_frame_size: 160, ptime: 20 }));
    else {
      await adapter.carrierMessage(JSON.stringify({ event: 'connected', version: '1.0.0', connected: { 'x-telnyx-streaming-auth-token': 'token' } }));
      await adapter.carrierMessage(JSON.stringify({ event: 'start', stream_id: 's', sequence_number: '1', start: { call_control_id: 'c', call_session_id: 's', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } }));
    }
    const audio = new ArrayBuffer(480000);
    const send = socket.send.bind(socket); let queuedAtReady = false;
    vi.spyOn(socket, 'send').mockImplementation(data => {
      send(data); adapter.sessionMessage(data);
      if (typeof data === 'string' && JSON.parse(data).type === 'ready') {
        queueMicrotask(() => { const first = socket.sent[socket.sent.findIndex(value => typeof value === 'string' && JSON.parse(value).type === 'ready') + 1]; queuedAtReady = first instanceof ArrayBuffer && first.byteLength === 24000; });
      }
    });
    release(audio); await flush(100);
    expect(socket.countOf('ready')).toBe(1); expect(socket.binaryCount()).toBe(1);
    expect(queuedAtReady).toBe(true); expect(socket.countOf('error')).toBe(0);
    expect(ended).not.toHaveBeenCalled(); expect(carrierFrames).toBe(0);
    vi.advanceTimersByTime(20);
    expect(carrierFrames).toBeGreaterThan(0); expect(carrierFrames).toBeLessThanOrEqual(5);
    await vi.advanceTimersByTimeAsync(10000);
    expect(carrierFrames).toBeGreaterThanOrEqual(499); expect(carrierFrames).toBeLessThanOrEqual(500);
    expect(ended).not.toHaveBeenCalled(); adapter.close();
    socket.receive({ type: 'hangup' }); await flush(100);
  });
  it.each([
    ['telnyx', 480002], ['asterisk', 480002],
    ['telnyx', 479999], ['asterisk', 479999],
  ])('rejects invalid %s synthesized greeting of %i bytes before ready or any PCM', async (channel, bytes) => {
    const { session, ctl, callUpdates } = newSession('realtime', {}, { DEFAULT_TTS_PROVIDER: 'azure', AZURE_SPEECH_KEY: 'synthetic-unit-test-key' });
    ctl.channel = channel as string;
    vi.spyOn(session as never, 'startRealtime').mockResolvedValue(true as never);
    vi.spyOn(session as never, 'engineGreets').mockReturnValue(false as never);
    globalThis.fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(bytes as number) })) as unknown as typeof fetch;
    await session.fetch(upgradeRequest()); const socket = serverSockets[0];
    socket.receive({ type: 'start' }); await flush(100);
    expect(socket.countOf('ready')).toBe(0); expect(socket.binaryCount()).toBe(0);
    expect(socket.countOf('error')).toBe(1); expect(socket.countOf('ended')).toBe(1);
    expect(callUpdates().some(w => w.args.includes('failed'))).toBe(true);
    expect(callUpdates().some(w => w.args.includes('Telephone greeting audio must be valid PCM and no longer than 10 seconds. Shorten the greeting and retry.'))).toBe(true);
  });
  it('preserves browser synthesized audio above the carrier frame limit', async () => {
    vi.useFakeTimers();
    const { session } = newSession('realtime', {}, { DEFAULT_TTS_PROVIDER: 'azure', AZURE_SPEECH_KEY: 'synthetic-unit-test-key' });
    vi.spyOn(session as never, 'startRealtime').mockResolvedValue(true as never);
    vi.spyOn(session as never, 'engineGreets').mockReturnValue(false as never);
    const audio = new ArrayBuffer(480002);
    globalThis.fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => audio })) as unknown as typeof fetch;
    await session.fetch(upgradeRequest()); const socket = serverSockets[0];
    socket.receive({ type: 'start' }); await flush(100);
    expect(socket.countOf('ready')).toBe(1); expect(socket.binaryCount()).toBe(1);
    expect(socket.countOf('error')).toBe(0);
    await vi.advanceTimersByTimeAsync(10500);
    expect(socket.sent.reduce<number>((n, value) => n + (value instanceof ArrayBuffer ? value.byteLength : 0), 0)).toBe(audio.byteLength);
    socket.receive({ type: 'hangup' }); await flush(100);
  });
});

it('hangup aborts slow transcription without a late transcript or failed-call verdict', async () => {
  vi.useFakeTimers();
  const { session, callUpdates } = newSession('pipeline');
  await session.fetch(upgradeRequest());
  const caller = serverSockets[0]; caller.receive({ type: 'start' }); await flush(100);
  const previousFetch = globalThis.fetch;
  let signal: AbortSignal | undefined;
  globalThis.fetch = vi.fn((url, init) => {
    if (String(url).endsWith('/audio/transcriptions')) {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }
    return previousFetch(url, init);
  });
  caller.emit('message', { data: new ArrayBuffer(2) }); await flush(100);
  expect(signal?.aborted).toBe(false);
  caller.receive({ type: 'hangup' }); await flush(150);
  expect(signal?.aborted).toBe(true);
  expect(caller.countOf('error')).toBe(0);
  expect(caller.countOf('transcript')).toBe(0);
  expect(callUpdates().some(w => w.args[0] === 'failed')).toBe(false);
  await vi.advanceTimersByTimeAsync(120000);
  expect(caller.countOf('error')).toBe(0);
});

describe('realtime output cumulative and receipt bounds', () => {
  beforeEach(() => vi.useFakeTimers());
  const pcmBytes = (caller: FakeSocket) => caller.sent.reduce<number>((n, value) => n + (value instanceof ArrayBuffer ? value.byteLength : 0), 0);
  const large = 'A'.repeat(640000); // exactly 480000 decoded PCM bytes
  async function connected(protocol: 'openai' | 'gateway' = 'openai', carrier = false) {
    const sockets = [new FakeSocket(), new FakeSocket()]; let connects = 0;
    if (protocol === 'openai') globalThis.fetch = vi.fn(async () => ({ status: 101, webSocket: sockets[connects++] })) as unknown as typeof fetch;
    const backing = newSession('realtime', protocol === 'openai'
      ? { realtime_provider: 'openai', realtime_api_key: 'synthetic-key', realtime_model: '', realtime_voice: 'marin' } as never
      : { realtime_model: 'gpt-realtime-2' });
    backing.ctl.channel = carrier ? 'telnyx' : 'web';
    await backing.session.fetch(upgradeRequest());
    const caller = serverSockets[0]; caller.receive({ type: 'start' }); await flush(50);
    const up = protocol === 'openai' ? sockets[0] : upstreamSockets[0];
    if (protocol === 'openai') up.receive({ type: 'session.updated', session: up.messages().find(m => m.type === 'session.update')!.session });
    else up.emit('open', {});
    await flush(50);
    return { ...backing, caller, up, replacement: sockets[1] };
  }
  function delta(up: FakeSocket, value = large, item = 'output') {
    up.receive({ type: 'response.output_audio.delta', item_id: item, delta: value });
  }
  function receipts(caller: FakeSocket) { return caller.messages().filter(m => m.type === 'audio_receipt'); }

  it('closing guard: tool-only ending generates one farewell before permitting playback completion', async () => {
    const { caller, up } = await connected();
    up.receive({ type: 'response.created', response: { id: 'tool-response' } });
    up.receive({ type: 'response.function_call_arguments.done', name: 'end_call', response_id: 'tool-response', call_id: 'tool-call' });
    expect(caller.countOf('ending')).toBe(0);
    up.receive({ type: 'response.done', response: { id: 'tool-response', status: 'completed' } }); await flush(100);
    const requests = up.messages().filter(m => m.type === 'response.create' && m.response?.tool_choice === 'none');
    expect(requests).toHaveLength(1);
    up.receive({ type: 'response.created', response: { id: 'farewell' } });
    up.receive({ type: 'response.output_audio.delta', response_id: 'farewell', delta: 'A'.repeat(6400) });
    up.receive({ type: 'response.output_audio_transcript.done', response_id: 'farewell', transcript: 'Hasta luego.' });
    expect(caller.countOf('ending')).toBe(0);
    up.receive({ type: 'response.done', response: { id: 'farewell', status: 'completed' } }); await flush(100);
    const ending = caller.messages().find(m => m.type === 'ending');
    expect(ending?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(caller.closed).toBeNull();
    caller.receive({ type: 'playback_complete', id: ending!.id }); await flush(100);
    expect(caller.countOf('ended')).toBe(1);
  });

  it('closing guard: waits for audio that arrives after the hangup tool', async () => {
    const { caller, up } = await connected();
    up.receive({ type: 'response.created', response: { id: 'goodbye' } });
    up.receive({ type: 'response.function_call_arguments.done', name: 'end_call', response_id: 'goodbye' });
    expect(caller.countOf('ending')).toBe(0);
    await vi.advanceTimersByTimeAsync(1500);
    up.receive({ type: 'response.output_audio.delta', response_id: 'goodbye', delta: 'A'.repeat(6400) });
    up.receive({ type: 'response.output_audio_transcript.done', response_id: 'goodbye', transcript: 'Auf Wiederhören.' });
    up.receive({ type: 'response.done', response: { id: 'goodbye', status: 'completed' } }); await flush(100);
    expect(caller.countOf('ending')).toBe(1);
    expect(up.messages().filter(m => m.type === 'response.create' && m.response?.tool_choice === 'none')).toHaveLength(0);
    caller.receive({ type: 'hangup' }); await flush(100);
  });

  it('closing guard: missing generation is bounded and records why it ended', async () => {
    const { caller, up } = await connected();
    const log = vi.spyOn(console, 'info');
    up.receive({ type: 'response.created', response: { id: 'missing' } });
    up.receive({ type: 'response.function_call_arguments.done', name: 'end_call', response_id: 'missing' });
    await vi.advanceTimersByTimeAsync(30001); await flush(100);
    expect(caller.countOf('ending')).toBe(0);
    expect(caller.countOf('ended')).toBe(1);
    const record = log.mock.calls.map(([raw]) => { try { return JSON.parse(String(raw)); } catch { return {}; } }).find(m => m.event === 'call_closing');
    expect(record).toMatchObject({ trigger: 'model_tool', result: 'generation_timeout' });
    expect(record.endedAt).toBeGreaterThanOrEqual(record.requestedAt + 30000);
    log.mockRestore();
  });

  it('closing guard: wrong playback markers cannot acknowledge the goodbye', async () => {
    const { caller, up } = await connected();
    up.receive({ type: 'response.output_audio.delta', response_id: 'bye', delta: 'A'.repeat(6400) });
    up.receive({ type: 'response.output_audio_transcript.done', response_id: 'bye', transcript: 'Goodbye.' });
    up.receive({ type: 'response.done', response: { id: 'bye', status: 'completed' } });
    up.receive({ type: 'response.function_call_arguments.done', name: 'end_call', response_id: 'bye' }); await flush(100);
    expect(caller.countOf('ending')).toBe(1);
    caller.receive({ type: 'playback_complete', id: 'wrong' }); await flush(100);
    expect(caller.closed).toBeNull();
    await vi.advanceTimersByTimeAsync(25001); await flush(100);
    expect(caller.countOf('ended')).toBe(1);
  });

  it('does not rotate away from the farewell when an earlier reconnect becomes ready', async () => {
    const { caller, up, replacement } = await connected();
    up.receive({ type: 'session.expiring' }); await flush(100);
    up.receive({ type: 'response.created', response: { id: 'bye' } });
    up.receive({ type: 'response.function_call_arguments.done', name: 'end_call', response_id: 'bye' });
    replacement.receive({ type: 'session.updated', session: replacement.messages().find(m => m.type === 'session.update')!.session }); await flush(100);
    expect(replacement.closed).not.toBeNull();
    expect(up.closed).toBeNull();
    up.receive({ type: 'response.output_audio.delta', response_id: 'bye', delta: 'A'.repeat(6400) });
    up.receive({ type: 'response.output_audio_transcript.done', response_id: 'bye', transcript: 'Goodbye.' });
    up.receive({ type: 'response.done', response: { id: 'bye', status: 'completed' } }); await flush(100);
    expect(caller.countOf('ending')).toBe(1);
    caller.receive({ type: 'playback_complete', id: caller.messages().find(m => m.type === 'ending')!.id }); await flush(100);
    expect(caller.countOf('ended')).toBe(1);
  });

  it.each([false, true])('closing provider disconnect preserves only complete generation: %s', async complete => {
    const { caller, up } = await connected();
    up.receive({ type: 'response.created', response: { id: 'bye' } });
    up.receive({ type: 'response.function_call_arguments.done', name: 'end_call', response_id: 'bye' });
    if (complete) {
      up.receive({ type: 'response.output_audio.delta', response_id: 'bye', delta: 'A'.repeat(64000) });
      up.receive({ type: 'response.output_audio_transcript.done', response_id: 'bye', transcript: 'Goodbye.' });
      up.receive({ type: 'response.done', response: { id: 'bye', status: 'completed' } });
      await flush(100);
    }
    up.close(); await flush(100);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    if (complete) {
      expect(caller.closed).toBeNull();
      await vi.advanceTimersByTimeAsync(1500); await flush(100);
      expect(caller.countOf('ending')).toBe(1);
      caller.receive({ type: 'playback_complete', id: caller.messages().find(m => m.type === 'ending')!.id }); await flush(100);
    }
    expect(caller.countOf('ended')).toBe(1);
  });

  it('paces a fast thirty-second answer without terminating or dropping queued PCM', async () => {
    vi.useFakeTimers();
    const { caller, up } = await connected();
    for (let i = 0; i < 3; i++) delta(up);
    up.receive({ type: 'response.done' });
    await flush(100);
    const bytes = () => caller.sent.reduce((n, value) => n + (value instanceof ArrayBuffer ? value.byteLength : 0), 0);
    expect(caller.countOf('error')).toBe(0);
    expect(bytes()).toBeLessThanOrEqual(24000);
    await vi.advanceTimersByTimeAsync(30500);
    expect(bytes()).toBe(1440000);
    expect(caller.countOf('error')).toBe(0);
    caller.receive({ type: 'hangup' }); await flush(100);
  });

  it('discards queued speech on interruption and waits for queued goodbye before ending', async () => {
    vi.useFakeTimers();
    const { caller, up } = await connected();
    delta(up);
    up.receive({ type: 'input_audio_buffer.speech_started' });
    const before = caller.binaryCount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(caller.binaryCount()).toBe(before);
    delta(up);
    up.receive({ type: 'response.output_audio_transcript.done', transcript: 'Goodbye.' });
    up.receive({ type: 'response.function_call_arguments.done', name: 'end_call' });
    up.receive({ type: 'response.done' });
    await flush(100);
    expect(caller.countOf('ending')).toBe(0);
    await vi.advanceTimersByTimeAsync(10500);
    expect(caller.countOf('ending')).toBe(1);
    caller.receive({ type: 'hangup' }); await flush(100);
  });

  it('releases queued PCM and timers on caller hangup', async () => {
    const { caller, up } = await connected();
    delta(up); delta(up);
    caller.receive({ type: 'hangup' }); await flush(100);
    const delivered = pcmBytes(caller);
    await vi.advanceTimersByTimeAsync(90000);
    expect(pcmBytes(caller)).toBe(delivered);
    expect(caller.countOf('error')).toBe(0);
    expect(up.closed).not.toBeNull();
  });

  it.each(['openai', 'gateway'] as const)('negative control: refuses a same-turn %s exact-limit flood before seventh decode', async protocol => {
    const { caller, up, callUpdates } = await connected(protocol);
    const decode = vi.spyOn(globalThis, 'atob');
    try {
      for (let i = 0; i < 8; i++) delta(up);
      expect(decode).toHaveBeenCalledTimes(6);
      expect(pcmBytes(caller)).toBe(24000);
      expect(up.closed).not.toBeNull();
      await flush(100);
      expect(caller.countOf('error')).toBe(1);
      expect(callUpdates().some(w => w.args[0] === 'failed')).toBe(true);
    } finally { decode.mockRestore(); }
  });

  it('negative control: cannot mint credit with done, flush or changing item IDs', async () => {
    const { caller, up } = await connected();
    for (let i = 0; i < 6; i++) delta(up, large, String(i));
    up.receive({ type: 'response.done' });
    up.receive({ type: 'input_audio_buffer.speech_started' });
    delta(up, 'AAAAAA==', 'third');
    expect(pcmBytes(caller)).toBe(24000);
    expect(up.closed).not.toBeNull();
    await flush(100);
  });

  it('negative control: bounds tiny outstanding frames even without bufferedAmount', async () => {
    const { caller, up } = await connected();
    caller.autoAudioReceipts = false;
    expect('bufferedAmount' in caller).toBe(false);
    for (let i = 0; i < 130; i++) delta(up, 'AAAAAA==');
    expect(caller.binaryCount()).toBe(128);
    expect(up.closed).not.toBeNull();
    await flush(100);
  });

  it('negative control: refuses advertised transport backpressure before decoding', async () => {
    const { caller, up } = await connected();
    Object.assign(caller, { bufferedAmount: 960000 });
    const decode = vi.spyOn(globalThis, 'atob');
    try {
      delta(up, 'AAAAAA==');
      expect(decode).not.toHaveBeenCalled(); expect(caller.binaryCount()).toBe(0);
      expect(up.closed).not.toBeNull(); await flush(100);
    } finally { decode.mockRestore(); }
  });

  it('negative control: closes a stalled receiver at the oldest receipt deadline', async () => {
    vi.useFakeTimers();
    const { caller, up, callUpdates } = await connected();
    caller.autoAudioReceipts = false;
    delta(up, 'AAAAAA=='); await flush(50);
    await vi.advanceTimersByTimeAsync(10001);
    expect(up.closed).not.toBeNull();
    expect(callUpdates().some(w => w.args[0] === 'failed')).toBe(true);
  });

  it.each(['wrong', 'out-of-order', 'replayed', 'expired'])('rejects %s receipt identity without returning credit', async kind => {
    vi.useFakeTimers();
    const { caller, up } = await connected();
    caller.autoAudioReceipts = false;
    delta(up, 'AAAAAA=='); delta(up, 'AAAAAA==');
    const ids = receipts(caller).map(m => m.id);
    expect(ids).toHaveLength(2);
    let id = kind === 'out-of-order' ? ids[1] : kind === 'wrong' ? 'private-reflected-value' : ids[0];
    if (kind === 'replayed') { caller.receive({ type: 'audio_received', id }); await flush(); }
    if (kind === 'expired') vi.setSystemTime(Date.now() + 10001);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      caller.receive({ type: 'audio_received', id }); await flush(100);
      expect(up.closed).not.toBeNull();
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-reflected-value');
    } finally { log.mockRestore(); }
  });

  it('negative control: retains admission across pending and successful replacement', async () => {
    const { caller, up, replacement } = await connected();
    caller.autoAudioReceipts = false;
    delta(up);
    up.receive({ type: 'session.expiring' }); await flush(50);
    delta(replacement); // still unacknowledged: no decode, output or budget charge
    expect(caller.binaryCount()).toBe(1); expect(up.closed).toBeNull();
    for (let i = 0; i < 5; i++) delta(up); // old socket remains usable during replacement handshake
    replacement.receive({ type: 'session.updated', session: replacement.messages().find(m => m.type === 'session.update')!.session });
    await flush(50);
    delta(replacement, 'AAAAAA==');
    expect(pcmBytes(caller)).toBe(24000); expect(replacement.closed).not.toBeNull();
    await flush(100);
  });

  it('admits normal multi-response audio beyond a whole-call cap with timely receipts', async () => {
    vi.useFakeTimers();
    const { caller, up } = await connected();
    for (let i = 0; i < 20; i++) {
      delta(up); await flush(50);
      up.receive({ type: 'response.done' });
      await vi.advanceTimersByTimeAsync(10000);
    }
    expect(pcmBytes(caller)).toBe(20 * 480000); expect(caller.countOf('error')).toBe(0);
    caller.receive({ type: 'hangup' }); await flush(100);
  });

  it('negative control: bounds one long response despite timely receipt and normal pacing', async () => {
    vi.useFakeTimers();
    const { caller, up } = await connected();
    for (let i = 0; i < 6; i++) {
      delta(up); await flush(50); await vi.advanceTimersByTimeAsync(10000);
    }
    delta(up, 'AAAAAA==');
    expect(pcmBytes(caller)).toBe(6 * 480000); expect(up.closed).not.toBeNull();
    await flush(100);
  });

  it('negative control: closes a control-only stalled caller without unlimited flush writes', async () => {
    const { caller, up } = await connected(); caller.autoAudioReceipts = false;
    for (let i = 0; i < 130; i++) up.receive({ type: 'input_audio_buffer.speech_started' });
    expect(caller.countOf('flush')).toBeLessThanOrEqual(64);
    expect(caller.countOf('speaking')).toBeLessThanOrEqual(64);
    expect(up.closed).not.toBeNull(); await flush(100);
  });

  it.each(['telnyx', 'asterisk'] as const)('pairs actual %s receiver receipts with sender through greeting, flush and ending', async channel => {
    vi.useFakeTimers();
    const { caller, up, callUpdates } = await connected('openai', true);
    caller.autoAudioReceipts = false;
    const ended = vi.fn();
    const carrier: (string | ArrayBuffer)[] = [];
    let adapter: { sessionMessage(raw: unknown): void; carrierMessage(raw: unknown): void | Promise<void>; close(): void };
    const sessionSend = (raw: string | ArrayBuffer) => {
      if (typeof raw === 'string') caller.receive(JSON.parse(raw));
      else caller.emit('message', { data: raw });
    };
    const carrierSend = (raw: string | ArrayBuffer) => {
      carrier.push(raw);
      if (typeof raw !== 'string') return;
      const message = JSON.parse(raw);
      if (message.event === 'mark') queueMicrotask(() => void adapter.carrierMessage(JSON.stringify({ event: 'mark', stream_id: 's', mark: message.mark })));
      if (message.command === 'MARK_MEDIA') queueMicrotask(() => void adapter.carrierMessage(JSON.stringify({ event: 'MEDIA_MARK_PROCESSED', correlation_id: message.correlation_id })));
    };
    if (channel === 'telnyx') {
      const { TelnyxMediaAdapter } = await import('../src/telnyx-media');
      adapter = new TelnyxMediaAdapter({ expected: { callControlId: 'c', callSessionId: 's', callLegId: 'l', authToken: 'token' }, sessionSend, carrierSend, onEnd: ended });
      await adapter.carrierMessage(JSON.stringify({ event: 'connected', version: '1.0.0', connected: { 'x-telnyx-streaming-auth-token': 'token' } }));
      await adapter.carrierMessage(JSON.stringify({ event: 'start', stream_id: 's', sequence_number: '1', start: { call_control_id: 'c', call_session_id: 's', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } }));
    } else {
      const { AsteriskMediaAdapter } = await import('../src/asterisk-media');
      adapter = new AsteriskMediaAdapter({ sessionSend, carrierSend, onEnd: ended });
      await adapter.carrierMessage(JSON.stringify({ event: 'MEDIA_START', connection_id: 's', channel: 'test', format: 'ulaw', optimal_frame_size: 160, ptime: 20 }));
    }
    const send = caller.send.bind(caller);
    vi.spyOn(caller, 'send').mockImplementation(raw => { send(raw); adapter.sessionMessage(raw); });
    delta(up, 'A'.repeat(6400)); await flush(100);
    expect(caller.countOf('ready')).toBe(1); expect(caller.countOf('audio_receipt')).toBe(1);
    up.receive({ type: 'input_audio_buffer.speech_started' });
    delta(up, 'A'.repeat(6400)); await flush(100);
    expect(caller.countOf('control_receipt')).toBe(2);
    up.receive({ type: 'response.output_audio_transcript.done', transcript: 'Goodbye.' });
    up.receive({ type: 'response.function_call_arguments.done', name: 'end_call' });
    up.receive({ type: 'response.done' });
    await vi.advanceTimersByTimeAsync(500); await flush(100);
    expect(ended).toHaveBeenCalledOnce();
    expect(caller.countOf('error')).toBe(0);
    expect(callUpdates().some(w => w.args[0] === 'completed')).toBe(true);
    expect(JSON.stringify(carrier)).not.toContain('audio_receipt');
    expect(JSON.stringify(carrier)).not.toContain('control_receipt');
  });

  it('negative control: counts empty delta floods as bounded event work', async () => {
    const { caller, up } = await connected();
    for (let i = 0; i < 401; i++) delta(up, '');
    expect(caller.binaryCount()).toBe(0); expect(up.closed).not.toBeNull();
    await flush(100);
  });

  it('negative control: refuses a tiny-frame native greeting burst before carrier readiness', async () => {
    const { caller, up } = await connected('openai', true);
    for (let i = 0; i < 129; i++) delta(up, 'AAAAAA==');
    await flush(100);
    expect(caller.binaryCount()).toBe(0); expect(caller.countOf('ready')).toBe(0);
    expect(up.closed).not.toBeNull();
  });
});

describe('gateway header transport contract', () => {
  const gatewaySettings = { realtime_model: 'gpt-realtime-2', realtime_voice: 'marin' };
  const gatewayEnv = {
    REALTIME_BASE_URL: 'wss://stub.invalid/v1/realtime?token=old-a&api_key=old-b&route=synthetic',
    REALTIME_API_KEY: 'synthetic-gateway-key',
    DEFAULT_LLM_API_KEY: '',
  };
  function forbidConstructor() {
    const constructor = vi.fn(() => { throw new Error('query-auth constructor is forbidden'); });
    globalThis.WebSocket = constructor as unknown as typeof WebSocket;
    return constructor;
  }
  function expectHeaderRequest(index: number) {
    const { url, init } = gatewayRequests[index];
    expect(url).toBe('https://stub.invalid/v1/realtime?route=synthetic&model=gpt-realtime-2');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-gateway-key');
    expect(new Headers(init.headers).get('Upgrade')).toBe('websocket');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
  async function cleanup(caller: FakeSocket) {
    // Release owned pending fake fetches even if the test's first assertion
    // fails. This cleanup does not claim native network teardown evidence.
    for (const dispose of gatewayDisposals) dispose();
    caller.receive({ type: 'hangup' });
    await flush(100);
  }

  it('keeps an upgraded realtime socket alive beyond the HTTP connection deadline', async () => {
    vi.useFakeTimers();
    const { session } = newSession('realtime', gatewaySettings, gatewayEnv);
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0];
    try {
      caller.receive({ type: 'start' }); await flush(100);
      const signal = gatewayRequests[0].init.signal!;
      const up = upstreamSockets[0];
      // Native workerd retains the request signal after WebSocket Upgrade.
      signal.addEventListener('abort', () => up.close(1000, 'request aborted'));
      up.emit('open', {}); await flush(100);
      expect(caller.countOf('ready')).toBe(1);
      await vi.advanceTimersByTimeAsync(6000); await flush(100);
      expect(signal.aborted).toBe(false);
      expect(up.closed).toBeNull();
      up.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' }); await flush(100);
      expect(caller.binaryCount()).toBe(1);
      expect(gatewayRequests).toHaveLength(1);
    } finally { await cleanup(caller); }
  });

  it.each(['web', 'telnyx'])('[gateway-header-negative] starts %s through header Upgrade with gateway readiness and PCM', async channel => {
    vi.useFakeTimers();
    const constructor = forbidConstructor();
    const { session, ctl } = newSession('realtime', gatewaySettings, gatewayEnv);
    ctl.channel = channel;
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0];
    try {
      caller.receive({ type: 'start' }); await flush(100);
      expect(gatewayRequests).toHaveLength(1); // original first failure: constructor path, no header fetch
      expectHeaderRequest(0);
      expect(caller.countOf('ready')).toBe(0);
      const up = upstreamSockets[0]; up.emit('open', {}); await flush(100);
      const update = up.messages().find(m => m.type === 'session.update')!.session as {
        output_modalities?: unknown; audio: { output: { voice: string; format: { rate: number } } };
      };
      expect(update.output_modalities).toBeUndefined(); // gateway payload, not direct GA policy
      expect(update.audio.output.voice).toBe('marin');
      expect(update.audio.output.format.rate).toBe(24000);
      expect(up.countOf('response.create')).toBe(1); // gateway needs no direct session.updated acknowledgement
      expect(caller.countOf('ready')).toBe(channel === 'telnyx' ? 0 : 1);
      up.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' }); await flush(100);
      expect(caller.countOf('ready')).toBe(1);
      expect(caller.binaryCount()).toBe(1);
      expect(caller.countOf('error')).toBe(0);
      caller.emit('message', { data: new ArrayBuffer(8) }); await flush(100);
      expect(up.countOf('input_audio_buffer.append')).toBe(1);
      expect(constructor).not.toHaveBeenCalled();
      expect(gatewayRequests).toHaveLength(1);
    } finally { await cleanup(caller); }
  });

  it.each([401, 302, 'reject', 'timeout'] as const)('refuses gateway %s at pickup without query downgrade', async failure => {
    vi.useFakeTimers();
    const constructor = forbidConstructor();
    gatewayOutcomes = [failure === 'timeout' ? 'pending' : failure];
    const { session, ctl, callUpdates } = newSession('realtime', gatewaySettings, gatewayEnv);
    ctl.channel = 'telnyx';
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0];
    try {
      caller.receive({ type: 'start' }); await flush(100);
      expect(gatewayRequests).toHaveLength(1);
      expectHeaderRequest(0);
      if (failure === 'timeout') {
        await vi.advanceTimersByTimeAsync(4999); await flush(100);
        expect(gatewayRequests[0].init.signal!.aborted).toBe(false);
        expect(caller.countOf('error')).toBe(0);
        await vi.advanceTimersByTimeAsync(1); await flush(100);
        expect(gatewayRequests[0].init.signal!.aborted).toBe(true);
      }
      expect(caller.countOf('ready')).toBe(0);
      expect(caller.binaryCount()).toBe(0);
      expect(caller.countOf('error')).toBe(1);
      expect(caller.countOf('ended')).toBe(1);
      expect(callUpdates().some(w => w.args[0] === 'failed')).toBe(true);
      expect(gatewayRequests).toHaveLength(1);
      expect(constructor).not.toHaveBeenCalled();
    } finally { await cleanup(caller); }
  });

  it.each(['success', 401, 302, 'timeout'] as const)('preserves old gateway audio during a %s replacement', async outcome => {
    vi.useFakeTimers();
    const constructor = forbidConstructor();
    gatewayOutcomes = ['pending', typeof outcome === 'number' ? outcome : 'pending'];
    const { session, callUpdates } = newSession('realtime', gatewaySettings, gatewayEnv);
    await session.fetch(upgradeRequest());
    const caller = serverSockets[0];
    try {
      caller.receive({ type: 'start' }); await flush(100);
      expect(gatewayRequests).toHaveLength(1);
      const old = upstreamSockets[0]; old.emit('open', {}); await flush(100);
      expect(caller.countOf('ready')).toBe(1);
      old.receive({ type: 'session.expiring' }); await flush(100);
      expect(gatewayRequests).toHaveLength(2);
      expectHeaderRequest(0); expectHeaderRequest(1);
      expect(old.closed).toBeNull();
      const before = caller.binaryCount();
      old.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' }); await flush(100);
      expect(caller.binaryCount()).toBe(before + 1);
      const inputBefore = old.countOf('input_audio_buffer.append');
      caller.emit('message', { data: new ArrayBuffer(8) }); await flush(100);
      expect(old.countOf('input_audio_buffer.append')).toBe(inputBefore + 1);
      if (outcome === 'success') {
        const replacement = upstreamSockets[1];
        expect(replacement.sent).toHaveLength(0);
        replacement.emit('open', {}); await flush(100);
        expect(old.closed).not.toBeNull();
        expect(replacement.countOf('session.update')).toBe(1);
        expect(replacement.countOf('response.create')).toBe(0); // no repeated greeting
        const after = caller.binaryCount();
        old.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' });
        replacement.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' }); await flush(100);
        expect(caller.binaryCount()).toBe(after + 1);
      } else {
        if (outcome === 'timeout') { await vi.advanceTimersByTimeAsync(5000); await flush(100); }
        expect(old.closed).toBeNull();
        old.receive({ type: 'response.output_audio.delta', delta: 'AAAAAA==' }); await flush(100);
        expect(caller.binaryCount()).toBe(before + 2);
      }
      expect(caller.countOf('error')).toBe(0);
      expect(caller.countOf('ended')).toBe(0);
      expect(callUpdates()).toHaveLength(0);
      expect(gatewayRequests).toHaveLength(2);
      expect(constructor).not.toHaveBeenCalled();
    } finally { await cleanup(caller); }
  });
});
