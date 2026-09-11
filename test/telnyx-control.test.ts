import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import worker from '../src/index';
import { TelnyxCall, sendTelnyxCommand, telnyxCallEnded, equalStreamToken, type TelnyxControlEvent } from '../src/telnyx-control';
import { OCCUPIED_CALL_SQL, reserveTelnyxCall, telnyxLocalCallId, telnyxMediaAllowed } from '../src/telnyx-admission';
import { applyMigrations, SqliteD1 } from './sqlite-d1';
import { fakeCtx, fakeEnv } from './fake-d1';
import type { Env } from '../src/types';
import type { TelnyxCallCorrelation } from '../src/telnyx-webhook';

let db: SqliteD1;
let env: Env;
let requests: Array<{ url: string; init: RequestInit }>;
const correlation: TelnyxCallCorrelation = { callControlId: 'v3:synthetic/control', callLegId: 'leg-one', callSessionId: 'session-one', connectionId: 'connection-one' };
let callId: string;
const keys = generateKeyPairSync('ed25519');
const publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');

class Storage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  failPut = false;
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.data.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { if (this.failPut) throw new Error('storage unavailable'); this.data.set(key, structuredClone(value)); }
  async setAlarm(time: number) { this.alarm = time; }
  async deleteAlarm() { this.alarm = null; }
}
function owner(storage = new Storage()) {
  const pending: Promise<unknown>[] = [];
  const state = { storage, waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as DurableObjectState;
  const object = new TelnyxCall(state, env);
  return { object, storage, pending, async drain() { while (pending.length) await pending.shift(); },
    event(type: string, id = crypto.randomUUID()) {
      const event: TelnyxControlEvent = { id, type, callId, call: correlation, ...(type === 'call.initiated' ? { to: '+12025550101', from: '+12025550100' } : {}) };
      return object.fetch(new Request('https://internal/events', { method: 'POST', body: JSON.stringify(event) }));
    },
  };
}
async function occupied() {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM calls WHERE business_id='biz' AND environment='live' AND ${OCCUPIED_CALL_SQL}`).first<{n:number}>())!.n;
}
function webhook(type: string, patch: Record<string, unknown> = {}) {
  const payload = { call_control_id: correlation.callControlId, call_leg_id: correlation.callLegId, call_session_id: correlation.callSessionId, connection_id: correlation.connectionId, direction: 'incoming', from: '+12025550100', to: '+12025550101', ...patch };
  const body = JSON.stringify({ data: { record_type: 'event', event_type: type, id: crypto.randomUUID(), occurred_at: new Date().toISOString(), payload } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request('https://openfon.test/api/telnyx/webhooks', { method: 'POST', body, headers: {
    'Content-Type': 'application/json', 'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': sign(null, Buffer.from(`${timestamp}|${body}`), keys.privateKey).toString('base64'),
  } });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES ('owner','owner@example.invalid','hash');
    INSERT INTO businesses(id,user_id,slug,name,description,max_concurrent_calls,max_calls_per_day) VALUES ('biz','owner','public-one','Workshop','Repairs',1,100);
    INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language,engine,realtime_model) VALUES ('assistant','biz','public-one','active','Alex','Helpful','en','realtime','gpt-realtime-test');
    INSERT INTO telnyx_number_routes(connection_id,phone_number,business_id,assistant_id,enabled) VALUES ('connection-one','+12025550101','biz','assistant',1);`);
  env = { ...fakeEnv(), DB: db as unknown as D1Database, TELNYX_ENABLED: 'true', TELNYX_API_KEY: 'synthetic-api-key', TELNYX_PUBLIC_KEY: publicKey, TELNYX_CONNECTION_ID: 'connection-one', TELNYX_PUBLIC_ORIGIN: 'https://openfon.test' };
  env.DEFAULT_LLM_API_KEY = 'synthetic-realtime-key';
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { requests.push({ url: String(url), init }); return Response.json({ data: { result: 'ok' } }); }));
  callId = await telnyxLocalCallId(correlation);
});
afterEach(() => { db.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('carrier admission and isolation', () => {
  it('reserves before pickup and shares capacity with browser calls', async () => {
    expect(await reserveTelnyxCall(env, callId, correlation, '+12025550101', '+12025550100')).toBe(true);
    expect(await occupied()).toBe(1);
    expect(await reserveTelnyxCall(env, 'second', { ...correlation, callLegId: 'second' }, '+12025550101', 'caller')).toBe(false);
    expect(db.database.prepare('SELECT connected_at FROM calls WHERE id=?').get(callId)).toMatchObject({ connected_at: null });
  });

  it('does not reuse carrier capacity merely because the AI session finalized', async () => {
    await reserveTelnyxCall(env, callId, correlation, '+12025550101', 'caller');
    db.database.prepare("UPDATE calls SET status='completed', connected_at=datetime('now') WHERE id=?").run(callId);
    expect(await occupied()).toBe(1);
    db.database.prepare("UPDATE calls SET carrier_released_at=datetime('now') WHERE id=?").run(callId);
    expect(await occupied()).toBe(0);
  });

  it('refuses a carrier reservation when a browser already owns the only slot', async () => {
    db.exec("INSERT INTO calls(id,business_id,connected_at) VALUES ('browser','biz',datetime('now'))");
    expect(await reserveTelnyxCall(env, callId, correlation, '+12025550101', 'caller')).toBe(false);
  });

  it('retries an admitted identity without creating another row', async () => {
    expect(await reserveTelnyxCall(env, callId, correlation, '+12025550101', 'caller')).toBe(true);
    expect(await reserveTelnyxCall(env, callId, correlation, '+12025550101', 'caller')).toBe(true);
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM calls').get()).toMatchObject({ n: 1 });
  });

  it('enforces the daily cap atomically with reservation creation', async () => {
    db.exec("UPDATE businesses SET max_calls_per_day=1; INSERT INTO calls(id,business_id,status) VALUES ('prior','biz','completed')");
    expect(await reserveTelnyxCall(env, callId, correlation, '+12025550101', 'caller')).toBe(false);
  });

  it.each(['pipeline', 'paused', 'disabled', 'no-realtime-key', 'missing-greeting-tts'])('rejects unsupported configuration before answering: %s', async condition => {
    if (condition === 'pipeline') db.exec("UPDATE assistants SET engine='pipeline'");
    if (condition === 'paused') db.exec("UPDATE assistants SET state='paused'");
    if (condition === 'disabled') db.exec('UPDATE telnyx_number_routes SET enabled=0');
    if (condition === 'no-realtime-key') { delete env.DEFAULT_LLM_API_KEY; delete env.REALTIME_API_KEY; }
    if (condition === 'missing-greeting-tts') { db.exec("UPDATE assistants SET realtime_model='kataleptic-realtime-hd'"); env.DEFAULT_TTS_PROVIDER = 'browser'; }
    expect(await reserveTelnyxCall(env, callId, correlation, '+12025550101', 'caller')).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('requires the specific dialed number to remain enabled', async () => {
    await reserveTelnyxCall(env, callId, correlation, '+12025550101', 'caller');
    expect(await telnyxMediaAllowed(env, callId)).toBe(true);
    db.exec("UPDATE telnyx_number_routes SET enabled=0; INSERT INTO telnyx_number_routes VALUES ('connection-one','+12025550102','biz','assistant',1)");
    expect(await telnyxMediaAllowed(env, callId)).toBe(false);
  });

  it('does not allow cross-workspace number assignment', () => {
    db.exec("INSERT INTO users(id,email,password_hash) VALUES ('other','other@example.invalid','hash'); INSERT INTO businesses(id,user_id,slug,name) VALUES ('other','other','other','Other')");
    expect(() => db.exec("INSERT INTO telnyx_number_routes VALUES ('connection-one','+12025550102','other','assistant',1)")).toThrow();
  });

  it('does not let a known carrier call ID use the browser socket endpoint', async () => {
    await reserveTelnyxCall(env, callId, correlation, '+12025550101', 'caller');
    const response = await worker.fetch(new Request(`https://openfon.test/ws/call/${callId}`, { headers: { Upgrade: 'websocket' } }), env, fakeCtx);
    expect(response.status).toBe(404);
    expect(db.database.prepare('SELECT connected_at FROM calls WHERE id=?').get(callId)).toMatchObject({ connected_at: null });
  });
});

describe('durable carrier control', () => {
  it('reconciles owner-visible carrier failures after session finalization without retaining capacity', async () => {
    const o = owner();
    await o.event('call.initiated'); await o.drain();
    await o.event('streaming.failed'); await o.drain();
    expect(db.database.prepare('SELECT failure_code,outcome FROM calls WHERE id=?').get(callId)).toMatchObject({ failure_code: 'carrier_stream_failed', outcome: 'failed' });
    await o.event('call.hangup'); await o.drain();
    expect(await occupied()).toBe(0);
    db.database.prepare("UPDATE calls SET status='completed',outcome='answered',failure_code=NULL,failure_message=NULL WHERE id=?").run(callId);
    vi.setSystemTime(Date.now() + 30_000); await o.object.alarm();
    expect(db.database.prepare('SELECT status,failure_code,outcome FROM calls WHERE id=?').get(callId)).toEqual({ status: 'failed', failure_code: 'carrier_stream_failed', outcome: 'failed' });
  });

  it('keeps normal carrier hangup free of failure classification', async () => {
    const o = owner(); await o.event('call.initiated'); await o.drain();
    await o.event('call.hangup'); await o.drain();
    expect(db.database.prepare('SELECT failure_code FROM calls WHERE id=?').get(callId)).toEqual({ failure_code: null });
  });

  it('persists admission then answers once across duplicate event deliveries', async () => {
    const o = owner();
    expect((await o.event('call.initiated', 'same-event')).status).toBe(204); await o.drain();
    expect(await occupied()).toBe(1); expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.telnyx.com/v2/calls/v3%3Asynthetic%2Fcontrol/actions/answer');
    await o.event('call.initiated', 'same-event'); await o.drain();
    expect(requests).toHaveLength(1);
  });

  it('stores stable command IDs and bodies across a crash/retry', async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => { requests.push({ url: String(url), init: init! }); return new Response(null, { status: 503 }); });
    const original = owner(); await original.event('call.initiated'); await original.drain();
    const next = owner(original.storage); vi.setSystemTime(Date.now() + 2000); await next.object.alarm();
    expect(requests).toHaveLength(2);
    expect(requests[1].init.body).toBe(requests[0].init.body);
    expect(JSON.parse(requests[0].init.body as string).command_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('starts one authenticated PCMU stream after answer and never re-plans it on streaming.started', async () => {
    const o = owner(); await o.event('call.initiated'); await o.drain(); await o.event('call.answered'); await o.drain();
    const body = JSON.parse(requests[1].init.body as string);
    expect(body).toMatchObject({ stream_codec: 'PCMU', stream_bidirectional_sampling_rate: 8000, stream_bidirectional_mode: 'rtp' });
    expect(body.stream_auth_token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.stream_url).not.toContain(body.stream_auth_token);
    await o.event('streaming.started'); await o.drain(); await o.object.alarm();
    expect(requests).toHaveLength(2);
  });

  it('preserves answered-before-initiation ordering without sending answer twice', async () => {
    const o = owner(); await o.event('call.answered'); await o.drain(); expect(requests).toHaveLength(0);
    await o.event('call.initiated'); await o.drain(); expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('/streaming_start');
  });

  it.each(['call.answered', 'streaming.stopped', 'streaming.failed'])('never commands an unowned/outgoing leg observed as %s', async type => {
    const o = owner(); await o.event(type); await o.drain();
    vi.setSystemTime(Date.now() + 61_000); await o.object.alarm();
    expect(requests).toHaveLength(0); expect(await occupied()).toBe(0);
  });

  it('does not resurrect a terminal-first event when initiation arrives later', async () => {
    const o = owner(); await o.event('call.hangup'); await o.drain(); await o.event('call.initiated'); await o.drain();
    expect(requests).toHaveLength(0); expect(await occupied()).toBe(0);
  });

  it('keeps the carrier reservation after accepted hangup until terminal confirmation', async () => {
    const o = owner(); await o.event('call.initiated'); await o.drain(); await o.event('streaming.failed'); await o.drain();
    expect(requests.at(-1)!.url).toContain('/hangup'); expect(await occupied()).toBe(1);
    await o.event('call.hangup'); await o.drain(); expect(await occupied()).toBe(0);
  });

  it('does not hot-loop expired setup deadlines while a hangup retry is scheduled', async () => {
    const o = owner(); await o.event('call.initiated'); await o.drain();
    vi.setSystemTime(Date.now() + 61_000); await o.object.alarm();
    expect(o.storage.alarm).toBeGreaterThan(Date.now() + 1000);
    const before = requests.length; await o.object.alarm(); expect(requests).toHaveLength(before);
  });

  it('cleans up a lost media owner after restart', async () => {
    const o = owner(); await o.event('call.initiated'); await o.drain();
    const state = await o.storage.get<Record<string, unknown>>('control'); state!.mediaClaimed = true; state!.mediaValidated = true;
    await o.storage.put('control', state);
    await owner(o.storage).object.alarm();
    expect(requests.at(-1)!.url).toContain('/hangup');
  });

  it('does not acknowledge an inbox whose durable write failed', async () => {
    const o = owner(); o.storage.failPut = true;
    await expect(o.event('call.initiated')).rejects.toThrow('storage unavailable');
    expect(requests).toHaveLength(0); expect(o.storage.data.size).toBe(0);
    o.storage.failPut = false; await o.event('call.initiated'); await o.drain(); expect(requests).toHaveLength(1);
  });

  it('re-arms recovery if D1 fails after durable acknowledgment', async () => {
    const o = owner(); db.hook = () => { throw new Error('D1 temporarily unavailable'); };
    expect((await o.event('call.initiated')).status).toBe(204); await o.drain();
    expect(o.storage.alarm).toBe(Date.now() + 60_000); expect(requests).toHaveLength(0);
    db.hook = null; await o.object.alarm(); expect(requests).toHaveLength(1);
  });

  it('keeps accepting terminal confirmation after the rollout flag is disabled', async () => {
    const o = owner(); env.TELNYX_CALL = { idFromName: () => callId, get: () => ({ fetch: (r: Request) => o.object.fetch(r) }) } as unknown as DurableObjectNamespace;
    await o.event('call.initiated'); await o.drain(); env.TELNYX_ENABLED = 'false';
    expect((await worker.fetch(webhook('call.hangup'), env, fakeCtx)).status).toBe(200); await o.drain();
    expect(await occupied()).toBe(0);
    const empty = owner(); await empty.event('call.initiated'); await empty.drain(); expect(empty.storage.data.size).toBe(0);
  });

  it('does not hold the durable inbox lock across a slow carrier command', async () => {
    let finish!: () => void;
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = () => resolve(new Response(null, { status: 200 })); }));
    const o = owner(); await o.event('call.initiated'); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect((await o.event('call.hangup')).status).toBe(204);
    finish(); await o.drain(); expect(await occupied()).toBe(0);
  });

  it('rejects missing/wrong media authorization without opening a session', async () => {
    const o = owner(); await o.event('call.initiated'); await o.drain(); await o.event('call.answered'); await o.drain();
    const result = await o.object.fetch(new Request('https://internal/media', { headers: { Upgrade: 'websocket', 'x-telnyx-streaming-auth-token': '0'.repeat(64) } }));
    expect(result.status).toBe(403);
  });
});

describe('signed ingress and provider API contract', () => {
  it('never touches a DO or carrier for invalid signatures or another application', async () => {
    const get = vi.fn(); env.TELNYX_CALL = { idFromName: (n: string) => n, get } as unknown as DurableObjectNamespace;
    const invalid = webhook('call.initiated'); invalid.headers.set('telnyx-signature-ed25519', 'invalid');
    expect((await worker.fetch(invalid, env, fakeCtx)).status).toBe(401);
    expect((await worker.fetch(webhook('call.initiated', { connection_id: 'someone-else' }), env, fakeCtx)).status).toBe(403);
    expect(get).not.toHaveBeenCalled(); expect(requests).toHaveLength(0);
  });

  it('ignores outgoing initiation instead of taking ownership', async () => {
    const get = vi.fn(); env.TELNYX_CALL = { idFromName: (n: string) => n, get } as unknown as DurableObjectNamespace;
    expect((await worker.fetch(webhook('call.initiated', { direction: 'outgoing' }), env, fakeCtx)).status).toBe(200);
    expect(get).not.toHaveBeenCalled();
  });

  it('requires durable acceptance before successful acknowledgment', async () => {
    env.TELNYX_CALL = { idFromName: (n: string) => n, get: () => ({ fetch: () => new Response(null, { status: 503 }) }) } as unknown as DurableObjectNamespace;
    expect((await worker.fetch(webhook('call.initiated'), env, fakeCtx)).status).toBe(503);
  });

  it('bounds streamed body data without trusting Content-Length', async () => {
    env.TELNYX_CALL = {} as DurableObjectNamespace;
    const request = new Request('https://openfon.test/api/telnyx/webhooks', { method: 'POST', body: 'x'.repeat(131073), headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } });
    expect((await worker.fetch(request, env, fakeCtx)).status).toBe(413);
    expect(requests).toHaveLength(0);
  });

  it('uses fixed origin, escaped control token, and fails closed on redirects/errors', async () => {
    await sendTelnyxCommand(env, 'a/b?private#fragment', { action: 'hangup', body: { command_id: 'stable' } });
    expect(requests[0].url).toBe('https://api.telnyx.com/v2/calls/a%2Fb%3Fprivate%23fragment/actions/hangup');
    expect(requests[0].init.redirect).toBe('manual');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://other.invalid' } }));
    expect(await sendTelnyxCommand(env, 'control', { action: 'hangup', body: {} })).toBe(false);
    expect(requests[0].init.headers).toMatchObject({ Authorization: 'Bearer synthetic-api-key' });
  });

  it('requires authenticated ended status with every identity matching', async () => {
    const data = { record_type: 'call', is_alive: false, call_control_id: correlation.callControlId, call_leg_id: correlation.callLegId, call_session_id: correlation.callSessionId };
    vi.mocked(fetch).mockImplementation(async () => Response.json({ data }));
    expect(await telnyxCallEnded(env, correlation)).toBe(true);
    data.call_leg_id = 'unrelated'; expect(await telnyxCallEnded(env, correlation)).toBe(false);
    vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 404 }));
    expect(await telnyxCallEnded(env, correlation)).toBe(false);
  });

  it('rejects stream token length/content mismatches', () => {
    expect(equalStreamToken(null, 'a'.repeat(64))).toBe(false);
    expect(equalStreamToken('a'.repeat(63), 'a'.repeat(64))).toBe(false);
    expect(equalStreamToken('a'.repeat(63) + 'b', 'a'.repeat(64))).toBe(false);
    expect(equalStreamToken('a'.repeat(64), 'a'.repeat(64))).toBe(true);
  });
});
