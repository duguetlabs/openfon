import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import mainWorker from '../src/index';
import { CallSession } from '../src/call-session';
import { Hono } from 'hono';
import { registerTelnyxRoutes } from '../src/telnyx-routes';
let mediaApp: Hono<{ Bindings: Env; Variables: { userId: string } }>;
const worker = { fetch(request: Request, env: Env, ctx: ExecutionContext) {
  return new URL(request.url).pathname.startsWith('/ws/telnyx/')
    ? mediaApp.fetch(request, env, ctx) : mainWorker.fetch(request, env, ctx);
} };
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
  failDelete = false;
  failDeleteAlarm = false;
  failCommit = false;
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.data.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { if (this.failPut) throw new Error('storage unavailable'); this.data.set(key, structuredClone(value)); }
  async delete(key: string) { if (this.failDelete) throw new Error('storage unavailable'); return this.data.delete(key); }
  async setAlarm(time: number) { this.alarm = time; }
  async deleteAll() { this.data.clear(); }
  async deleteAlarm() { if (this.failDeleteAlarm) throw new Error('alarm unavailable'); this.alarm = null; }
  async transaction<T>(callback: (txn: Storage) => Promise<T>): Promise<T> {
    const data = structuredClone(this.data), alarm = this.alarm;
    try {
      const result = await callback(this);
      if (this.failCommit) throw new Error('commit interrupted');
      return result;
    } catch (error) { this.data = data; this.alarm = alarm; throw error; }
  }
}
function owner(storage = new Storage()) {
  const pending: Promise<unknown>[] = [];
  const state = { storage, waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as DurableObjectState;
  const object = new TelnyxCall(state, env);
  return { object, storage, pending, async drain() { while (pending.length) await pending.shift(); },
    event(type: string, id = crypto.randomUUID()) {
      const event: TelnyxControlEvent = { id, type, callId, call: correlation, ...(type === 'call.hangup' ? { normalHangup: true } : {}), ...(type === 'call.initiated' ? { to: '+12025550101', from: '+12025550100' } : {}) };
      return object.fetch(new Request('https://internal/events', { method: 'POST', body: JSON.stringify(event) }));
    },
  };
}
async function occupied() {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM calls WHERE business_id='biz' AND environment='live' AND ${OCCUPIED_CALL_SQL}`).first<{n:number}>())!.n;
}
function webhook(type: string, patch: Record<string, unknown> = {}) {
  const payload = { call_control_id: correlation.callControlId, call_leg_id: correlation.callLegId, call_session_id: correlation.callSessionId, connection_id: correlation.connectionId, direction: 'incoming', from: '+12025550100', to: '+12025550101', hangup_cause: 'normal_clearing', ...patch };
  const body = JSON.stringify({ data: { record_type: 'event', event_type: type, id: crypto.randomUUID(), occurred_at: new Date().toISOString(), payload } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request('https://openfon.test/api/telnyx/webhooks', { method: 'POST', body, headers: {
    'Content-Type': 'application/json', 'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': sign(null, Buffer.from(`${timestamp}|${body}`), keys.privateKey).toString('base64'),
  } });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
  mediaApp = new Hono(); registerTelnyxRoutes(mediaApp);
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES ('owner','owner@example.invalid','hash');
    INSERT INTO businesses(id,user_id,slug,name,description,max_concurrent_calls,max_calls_per_day) VALUES ('biz','owner','public-one','Workshop','Repairs',1,100);
    INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language,engine,realtime_model) VALUES ('assistant','biz','public-one','active','Alex','Helpful','en','realtime','gpt-realtime-test');
    INSERT INTO telnyx_number_routes(connection_id,phone_number,business_id,assistant_id,enabled) VALUES ('connection-one','+12025550101','biz','assistant',1);`);
  env = { ...fakeEnv(), DB: db as unknown as D1Database, TELNYX_ENABLED: 'true', TELNYX_API_KEY: 'synthetic-api-key', TELNYX_PUBLIC_KEY: publicKey, TELNYX_CONNECTION_ID: 'connection-one', TELNYX_PUBLIC_ORIGIN: 'https://openfon.test' };
  env.DEFAULT_LLM_API_KEY = 'synthetic-realtime-key';
  env.REALTIME_BASE_URL = 'wss://realtime.test/v1/realtime';
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { requests.push({ url: String(url), init }); return Response.json({ data: { result: 'ok' } }); }));
  callId = await telnyxLocalCallId(correlation);
});
afterEach(() => { db.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('carrier admission and isolation', () => {
  it('admits workspace OpenAI with no instance provider credentials or Azure greeting', async () => {
    env.DEFAULT_LLM_API_KEY = ''; env.REALTIME_API_KEY = ''; env.AZURE_SPEECH_KEY = '';
    db.exec("INSERT INTO provider_settings(business_id,realtime_provider,realtime_api_key) VALUES('biz','openai','synthetic-direct-key'); UPDATE assistants SET realtime_model='';");
    expect(await reserveTelnyxCall(env, callId, correlation, '+12025550101', 'caller')).toBe(true);
  });
  it('rejects a workspace direct provider missing its own key despite a valid instance key', async () => {
    db.exec("INSERT INTO provider_settings(business_id,realtime_provider) VALUES('biz','openai'); UPDATE assistants SET realtime_model='';");
    expect(await reserveTelnyxCall(env, callId, correlation, '+12025550101', 'caller')).toBe(false);
  });
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

  it.each(['socket-first', 'webhook-first'])('reconciles normal hangup without false failure: %s', async order => {
    let o = owner(); await o.event('call.initiated'); await o.drain();
    db.database.prepare("UPDATE calls SET status='completed',outcome='answered',connected_at=datetime('now') WHERE id=?").run(callId);
    const endSocket = () => (o.object as unknown as { terminate(reason: string): Promise<void> }).terminate('socket_closed');
    const hangup = async () => {
      env.TELNYX_CALL = { idFromName: (n:string) => n, get: () => ({ fetch: (r:Request) => o.object.fetch(r) }) } as unknown as DurableObjectNamespace;
      expect((await worker.fetch(webhook('call.hangup', { hangup_cause: 'normal_clearing' }), env, fakeCtx)).status).toBe(200);
      await o.drain();
    };
    if (order === 'socket-first') {
      await endSocket(); await o.object.alarm();
      expect(await occupied()).toBe(1); // accepted command is not confirmed release
      expect(db.database.prepare('SELECT failure_code FROM calls WHERE id=?').get(callId)).toEqual({failure_code:null});
      o = owner(o.storage); // provisional reason must survive restart
      await hangup();
    } else { await hangup(); await endSocket(); }
    await o.object.alarm();
    expect(await occupied()).toBe(0);
    expect(db.database.prepare('SELECT status,outcome,failure_code FROM calls WHERE id=?').get(callId)).toEqual({status:'completed',outcome:'answered',failure_code:null});
    vi.setSystemTime(Date.now()+36*60_000); await o.object.alarm();
    expect([...o.storage.data]).toEqual([['retired',true]]);
    o = owner(o.storage); await o.event('call.initiated'); await o.drain(); await o.object.alarm();
    expect([...o.storage.data]).toEqual([['retired',true]]); expect(o.storage.alarm).toBeNull();
  });

  it.each([
    ['socket_closed', 'user_busy'], ['socket_closed', undefined],
    ['socket_error', 'normal_clearing'], ['session_socket_closed', 'normal_clearing'],
    ['session_error', 'normal_clearing'],
  ])('preserves abnormal failure %s with hangup cause %s', async (reason, cause) => {
    const o = owner(); await o.event('call.initiated'); await o.drain();
    db.database.prepare("UPDATE calls SET status='completed',outcome='answered',connected_at=datetime('now') WHERE id=?").run(callId);
    await (o.object as unknown as {terminate(reason:string):Promise<void>}).terminate(reason!);
    await o.object.alarm(); expect(await occupied()).toBe(1);
    env.TELNYX_CALL = {idFromName:(n:string)=>n,get:()=>({fetch:(r:Request)=>o.object.fetch(r)})} as unknown as DurableObjectNamespace;
    expect((await worker.fetch(webhook('call.hangup',{hangup_cause:cause}),env,fakeCtx)).status).toBe(200);
    await o.drain(); expect(await occupied()).toBe(0);
    expect(db.database.prepare('SELECT status,outcome,failure_code FROM calls WHERE id=?').get(callId)).toEqual({status:'failed',outcome:'failed',failure_code:reason === 'socket_closed' ? 'carrier_hangup_failed' : reason});
  });

  it.each(['user_busy', undefined, 'unrecognized-private-cause'].flatMap(cause =>
    ['webhook-first', 'socket-first'].map(order => [cause, order])))('classifies signed abnormal/unknown hangup %s: %s', async (cause, order) => {
    let o = owner(); await o.event('call.initiated'); await o.drain();
    db.database.prepare("UPDATE calls SET connected_at=datetime('now') WHERE id=?").run(callId);
    const endSocket = () => (o.object as unknown as {terminate(reason:string):Promise<void>}).terminate('socket_closed');
    env.TELNYX_CALL = {idFromName:(n:string)=>n,get:()=>({fetch:(r:Request)=>o.object.fetch(r)})} as unknown as DurableObjectNamespace;
    if (order === 'socket-first') {await endSocket();await o.object.alarm();}
    expect(await occupied()).toBe(1);
    expect((await worker.fetch(webhook('call.hangup',{hangup_cause:cause}),env,fakeCtx)).status).toBe(200);
    await o.drain(); if (order === 'webhook-first') await endSocket();
    expect(await occupied()).toBe(0);
    // Shared finalization can race; durable reconciliation restores the failure.
    db.database.prepare("UPDATE calls SET status='completed',outcome='answered',failure_code=NULL WHERE id=?").run(callId);
    o = owner(o.storage); await o.object.alarm();
    expect(db.database.prepare('SELECT status,outcome,failure_code FROM calls WHERE id=?').get(callId)).toEqual({status:'failed',outcome:'failed',failure_code:'carrier_hangup_failed'});
    vi.setSystemTime(Date.now()+36*60_000); await o.object.alarm();
    expect([...o.storage.data]).toEqual([['retired',true]]);
    await o.event('call.initiated');await o.drain();await o.object.alarm();
    expect(o.storage.alarm).toBeNull(); expect([...o.storage.data]).toEqual([['retired',true]]);
  });

  it.each(['playback_complete', 'session_error', 'carrier_stream_failed', 'socket_closed'])('status-only release preserves existing reason without inventing cause: %s', async reason => {
    let o=owner(); await o.event('call.initiated'); await o.drain();
    db.database.prepare("UPDATE calls SET status='completed',outcome='answered',connected_at=datetime('now') WHERE id=?").run(callId);
    await (o.object as unknown as {terminate(reason:string):Promise<void>}).terminate(reason);
    await o.object.alarm(); expect(await occupied()).toBe(1);
    vi.mocked(fetch).mockImplementation(async (url,init) => {
      requests.push({url:String(url),init:init!});
      return Response.json(init?.method === 'POST' ? {data:{result:'ok'}} : {data:{record_type:'call',is_alive:false,call_control_id:correlation.callControlId,call_leg_id:correlation.callLegId,call_session_id:correlation.callSessionId}});
    });
    vi.setSystemTime(Date.now()+30_000); await o.object.alarm();
    expect(requests.some(r=>!r.init.method)).toBe(true);
    expect(await occupied()).toBe(0);
    expect(await o.storage.get('control')).toMatchObject({terminal:true,reason});
    o=owner(o.storage); await o.object.alarm();
    const failure=reason==='playback_complete'?null:reason;
    expect(db.database.prepare('SELECT status,outcome,failure_code FROM calls WHERE id=?').get(callId)).toEqual({status:failure?'failed':'completed',outcome:failure?'failed':'answered',failure_code:failure});
    // A later signed missing cause is still conservative after status release.
    env.TELNYX_CALL={idFromName:(n:string)=>n,get:()=>({fetch:(r:Request)=>o.object.fetch(r)})} as unknown as DurableObjectNamespace;
    await worker.fetch(webhook('call.hangup',{hangup_cause:undefined}),env,fakeCtx); await o.drain();
    expect(db.database.prepare('SELECT failure_code FROM calls WHERE id=?').get(callId)).toEqual({failure_code:reason==='playback_complete'||reason==='socket_closed'?'carrier_hangup_failed':reason});
    vi.setSystemTime(Date.now()+36*60_000); await o.object.alarm();
    expect([...o.storage.data]).toEqual([['retired',true]]);
    await o.event('call.initiated');await o.drain();await o.object.alarm();expect(o.storage.alarm).toBeNull();
  });

  it('does not downgrade explicit stream failure after provisional close', async () => {
    const o = owner(); await o.event('call.initiated'); await o.drain();
    await (o.object as unknown as {terminate(reason:string):Promise<void>}).terminate('socket_closed');
    await o.event('streaming.failed'); await o.drain();
    env.TELNYX_CALL = {idFromName:(n:string)=>n,get:()=>({fetch:(r:Request)=>o.object.fetch(r)})} as unknown as DurableObjectNamespace;
    await worker.fetch(webhook('call.hangup',{hangup_cause:'normal_clearing'}),env,fakeCtx); await o.drain();
    expect(db.database.prepare('SELECT failure_code FROM calls WHERE id=?').get(callId)).toEqual({failure_code:'carrier_stream_failed'});
    expect(await occupied()).toBe(0);
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

  it.each([
    ['carrier-first', null], ['session-first', null],
    ['carrier-first', 'Session failed'], ['session-first', 'Session failed'],
  ] as const)('preserves carrier classification across actual session finalization: %s / %s', async (order, sessionFailure) => {
    const o = owner(); await o.event('call.initiated'); await o.drain();
    db.database.prepare("UPDATE calls SET connected_at=datetime('now') WHERE id=?").run(callId);
    const sessionStorage = new Storage();
    const session = new CallSession({ storage: sessionStorage } as unknown as DurableObjectState, env);
    // Begin at finalization with a memoized conversation: no external AI request.
    Object.assign(session, { callId, history: [{ role: 'system', content: '' }], failure: sessionFailure,
      summarized: { summary: 'Caller requested a callback.', intent: 'question', messageJson: '{"message":"Call back"}' } });
    const finalize = () => (session as unknown as { finalize(): Promise<void> }).finalize();
    const failCarrier = async () => { await o.event('streaming.failed'); await o.drain(); await o.event('call.hangup'); await o.drain(); };
    if (order === 'carrier-first') {
      // Interleave the owner after the session's active-row SELECT, immediately
      // before its final UPDATE; stale read/preflight checks cannot pass this.
      let arrived!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { arrived = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const sessionEnv = { ...env, DB: { prepare(sql: string) {
        const statement = db.prepare(sql);
        return { bind(...args: Parameters<typeof statement.bind>) {
          const bound = statement.bind(...args);
          return { first: () => bound.first(), all: () => bound.all(), async run() {
            if (sql.includes('duration_s = ?')) { arrived(); await gate; }
            return bound.run();
          } };
        } };
      } } } as unknown as Env;
      Object.assign(session, { env: sessionEnv });
      const pending = finalize();
      await entered;
      try { await failCarrier(); } finally { release(); }
      await pending;
    } else { await finalize(); await failCarrier(); }
    const row = db.database.prepare('SELECT status,outcome,failure_code,failure_message,summary,message_json,ended_at,carrier_released_at FROM calls WHERE id=?').get(callId);
    expect(row).toMatchObject({ status: 'failed', outcome: 'failed', failure_code: 'carrier_stream_failed',
      failure_message: 'The telephone audio connection failed. Please review the call and retry.', message_json: '{"message":"Call back"}' });
    expect(String(row!.summary)).toContain('Caller requested a callback.');
    expect(row!.ended_at).not.toBeNull(); expect(row!.carrier_released_at).not.toBeNull();
    expect(await occupied()).toBe(0);
    const control = await o.storage.get<{cleanupAt:number}>('control');
    expect(o.storage.alarm).toBe(control!.cleanupAt);
    // A reconstructed finalizer and an explicit owner reconcile cannot undo it.
    const rebuilt = new CallSession({ storage: sessionStorage } as unknown as DurableObjectState, env);
    Object.assign(rebuilt, { callId });
    await (rebuilt as unknown as { finalize(): Promise<void> }).finalize();
    await o.object.fetch(new Request('https://internal/reconcile', { method: 'POST' })); await o.object.alarm();
    expect(db.database.prepare('SELECT status,outcome,failure_code FROM calls WHERE id=?').get(callId))
      .toEqual({ status: 'failed', outcome: 'failed', failure_code: 'carrier_stream_failed' });
  });

  it.each(['telnyx', 'web', 'asterisk'])('keeps normal session finalization semantics for %s', async channel => {
    await reserveTelnyxCall(env, callId, correlation, '+12025550101', 'caller');
    db.database.prepare("UPDATE calls SET channel=?, connected_at=datetime('now') WHERE id=?").run(channel, callId);
    const session = new CallSession({ storage: new Storage() } as unknown as DurableObjectState, env);
    Object.assign(session, { callId, history: [{role:'system',content:''}],
      summarized: {summary:'Callback saved',intent:'question',messageJson:'{"message":"Call back"}'} });
    await (session as unknown as { finalize(): Promise<void> }).finalize();
    expect(db.database.prepare('SELECT status,outcome,failure_code,failure_message FROM calls WHERE id=?').get(callId))
      .toEqual({status:'completed',outcome:'message_taken',failure_code:null,failure_message:null});
  });

  it('preserves carrier failure through a failed final UPDATE and rebuilt session retry', async () => {
    const o=owner(); await o.event('call.initiated'); await o.drain();
    db.database.prepare("UPDATE calls SET connected_at=datetime('now') WHERE id=?").run(callId);
    await o.event('streaming.failed'); await o.drain(); await o.event('call.hangup'); await o.drain();
    const storage=new Storage();
    const state={storage} as unknown as DurableObjectState;
    const session=new CallSession(state,env);
    Object.assign(session,{callId,history:[{role:'system',content:''}],
      summarized:{summary:'Retry saved content',intent:'question',messageJson:'{"message":"Call back"}'}});
    db.hook=sql=>{if(sql.includes('duration_s = ?')) throw new Error('synthetic final update failure');};
    await expect((session as unknown as {finalize():Promise<void>}).finalize()).rejects.toThrow('synthetic final update failure');
    db.hook=null;
    const rebuilt=new CallSession(state,env); Object.assign(rebuilt,{callId,history:[{role:'system',content:''}]});
    await (rebuilt as unknown as {finalize():Promise<void>}).finalize();
    expect(db.database.prepare('SELECT status,outcome,failure_code,summary,message_json FROM calls WHERE id=?').get(callId))
      .toEqual({status:'failed',outcome:'failed',failure_code:'carrier_stream_failed',summary:'Retry saved content',message_json:'{"message":"Call back"}'});
  });

  it.each(['web','asterisk'])('does not preserve stale carrier-like columns on %s rows', async channel => {
    await reserveTelnyxCall(env,callId,correlation,'+12025550101','caller');
    db.database.prepare("UPDATE calls SET channel=?,failure_code='old_failure',failure_message='old',outcome='failed' WHERE id=?").run(channel,callId);
    const session=new CallSession({storage:new Storage()} as unknown as DurableObjectState,env);
    Object.assign(session,{callId,history:[{role:'system',content:''}]});
    await (session as unknown as {finalize():Promise<void>}).finalize();
    expect(db.database.prepare('SELECT status,outcome,failure_code,failure_message FROM calls WHERE id=?').get(callId))
      .toEqual({status:'completed',outcome:'answered',failure_code:null,failure_message:null});
  });

  it.each(['terminal-first', 'normal', 'failed'])('schedules terminal cleanup directly, preserving explicit reconciliation: %s', async kind => {
    const o=owner();
    if(kind!=='terminal-first') {await o.event('call.initiated');await o.drain();}
    if(kind==='failed') {await o.event('streaming.failed');await o.drain();}
    await o.event('call.hangup');await o.drain();
    const s=await o.storage.get<{cleanupAt:number}>('control');
    expect(s!.cleanupAt).toBe(Date.now()+35*60_000);
    expect(o.storage.alarm).toBe(s!.cleanupAt);
    vi.setSystemTime(Date.now()+30_000);
    expect(o.storage.alarm).toBe(s!.cleanupAt); // no periodic 30-second wake
    expect((await o.object.fetch(new Request('https://internal/reconcile',{method:'POST'}))).status).toBe(204);
    expect(o.storage.alarm).toBe(Date.now()+1);
    await o.object.alarm();expect(o.storage.alarm).toBe(s!.cleanupAt);
    await o.event('call.answered');await o.drain(); // concrete late inbox is consumed
    expect(await o.storage.get('control')).toMatchObject({inbox:[]});
    expect(o.storage.alarm).toBe(s!.cleanupAt);
    vi.setSystemTime(s!.cleanupAt);await o.object.alarm();
    expect([...o.storage.data]).toEqual([['retired',true]]);expect(o.storage.alarm).toBeNull();
  });

  it('keeps terminal D1 failure retry earlier than cleanup and returns to cleanup after recovery', async () => {
    const o=owner();await o.event('call.initiated');await o.drain();
    await o.event('streaming.failed');await o.drain();await o.event('call.hangup');await o.drain();
    const s=await o.storage.get<{cleanupAt:number}>('control');
    db.hook=()=>{throw new Error('synthetic D1 unavailable');};
    await o.object.alarm();expect(o.storage.alarm).toBe(Date.now()+60_000);
    db.hook=null;vi.setSystemTime(Date.now()+60_000);await o.object.alarm();
    expect(o.storage.alarm).toBe(s!.cleanupAt);
    expect(db.database.prepare('SELECT failure_code FROM calls WHERE id=?').get(callId)).toEqual({failure_code:'carrier_stream_failed'});
  });

  it('compacts terminal state only after its cleanup deadline and finalizes the released row', async () => {
    const o = owner(); await o.event('call.initiated'); await o.drain();
    await o.event('call.answered'); await o.drain();
    await o.event('call.hangup'); await o.drain();
    const control = await o.storage.get<{cleanupAt:number}>('control');
    vi.setSystemTime(control!.cleanupAt - 1); await o.object.alarm();
    expect(o.storage.data.has('control')).toBe(true);
    expect(o.storage.data.has('retired')).toBe(false);
    vi.setSystemTime(control!.cleanupAt); await o.object.alarm();
    expect([...o.storage.data]).toEqual([['retired', true]]);
    expect(o.storage.alarm).toBeNull();
    expect(await occupied()).toBe(0);
    expect(db.database.prepare('SELECT status FROM calls WHERE id=?').get(callId)).toEqual({status:'abandoned'});
  });

  it.each(['terminal-first', 'admitted', 'deleted-account'])('rejects late initiation/replay after compaction and restart (%s)', async scenario => {
    const o = owner();
    if (scenario !== 'terminal-first') { await o.event('call.initiated', 'initial'); await o.drain(); }
    await o.event('call.hangup', 'terminal'); await o.drain();
    vi.setSystemTime(Date.now() + 36 * 60_000); await o.object.alarm();
    const count = requests.length;
    // Replay protection must not depend on retaining the business/account row.
    if (scenario === 'deleted-account') db.exec('DELETE FROM users');
    const restarted = owner(o.storage);
    for (const [type, id] of [['call.initiated','initial'], ['call.initiated','fresh-retry'], ['call.hangup','terminal'], ['call.answered','late-answer']]) {
      expect((await restarted.event(type, id)).status).toBe(204); await restarted.drain();
    }
    expect([...o.storage.data]).toEqual([['retired', true]]);
    expect(requests).toHaveLength(count);
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM calls').get()).toEqual({n:scenario === 'admitted' ? 1 : 0});
    expect(await occupied()).toBe(0);
    expect(o.storage.alarm).toBeNull();
  });

  it('rejects retired media and leaves reconcile/alarm wakeups compact after restart', async () => {
    const o = owner(); await o.event('call.hangup'); await o.drain();
    vi.setSystemTime(Date.now() + 36 * 60_000); await o.object.alarm();
    const restarted = owner(o.storage);
    const response = await restarted.object.fetch(new Request('https://internal/media', {headers:{Upgrade:'websocket','x-telnyx-streaming-auth-token':'a'.repeat(64)}}));
    expect(response.status).toBe(403);
    expect((await restarted.object.fetch(new Request('https://internal/reconcile', {method:'POST'}))).status).toBe(204);
    await restarted.object.alarm();
    expect([...o.storage.data]).toEqual([['retired', true]]);
    expect(o.storage.alarm).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it.each(['database', 'marker', 'delete', 'alarm', 'commit'])('retries interrupted compaction safely: %s failure', async failure => {
    const o = owner(); await o.event('call.hangup'); await o.drain();
    vi.setSystemTime(Date.now() + 36 * 60_000);
    if (failure === 'database') db.hook = () => { throw new Error('D1 unavailable'); };
    if (failure === 'marker') o.storage.failPut = true;
    if (failure === 'delete') o.storage.failDelete = true;
    if (failure === 'alarm') o.storage.failDeleteAlarm = true;
    if (failure === 'commit') o.storage.failCommit = true;
    await o.object.alarm();
    expect(o.storage.data.has('control')).toBe(true);
    expect(o.storage.data.has('retired')).toBe(false);
    expect(o.storage.alarm).toBeGreaterThan(Date.now());
    db.hook = null; o.storage.failPut = false; o.storage.failDelete = false; o.storage.failDeleteAlarm = false; o.storage.failCommit = false;
    const restarted = owner(o.storage);
    // Ingress can race the retry; it must never restart carrier admission.
    await restarted.event('call.initiated'); await restarted.drain();
    await restarted.object.alarm();
    expect([...o.storage.data]).toEqual([['retired', true]]);
    expect(o.storage.alarm).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('compacts a legacy terminal cleanupAt=null record when reconciliation wakes it', async () => {
    const o = owner(); await o.event('call.hangup'); await o.drain();
    const s = await o.storage.get<Record<string, unknown>>('control');
    await o.storage.put('control', {...s, cleanupAt:null, streamToken:'expired-capability'});
    await o.storage.deleteAlarm();
    const restarted = owner(o.storage);
    await restarted.object.fetch(new Request('https://internal/reconcile', {method:'POST'}));
    await restarted.object.alarm();
    expect([...o.storage.data]).toEqual([['retired', true]]);
    expect(o.storage.alarm).toBeNull();
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

describe('bounded media session connection', () => {
  async function pendingMedia() {
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
    const o = owner();
    await o.event('call.initiated'); await o.drain();
    await o.event('call.answered'); await o.drain();
    const control = await o.storage.get<{streamToken:string}>('control');
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const stubFetch = vi.fn(() => new Promise<Response>((yes, no) => {resolve=yes;reject=no;}));
    env.CALL_SESSION = {idFromName:()=>callId,get:()=>({fetch:stubFetch})} as unknown as DurableObjectNamespace;
    const request = () => new Request('https://internal/media', {headers:{Upgrade:'websocket','x-telnyx-streaming-auth-token':control!.streamToken}});
    let settled = false;
    const pending = o.object.fetch(request()).then(response => {settled=true;return response;});
    for (let i=0;i<100 && !stubFetch.mock.calls.length;i++) await Promise.resolve();
    expect(stubFetch).toHaveBeenCalledOnce();
    const socket = {readyState:1,accept:vi.fn(),close:vi.fn()};
    const reply = () => resolve({status:101,webSocket:socket} as unknown as Response);
    return {o,pending,stubFetch,request,socket,reply,reject,settled:()=>settled};
  }

  it('processes signed hangup while stub fetch is pending, then closes its late upgrade', async () => {
    const f = await pendingMedia();
    env.TELNYX_CALL = {idFromName:()=>callId,get:()=>({fetch:(r:Request)=>f.o.object.fetch(r)})} as unknown as DurableObjectNamespace;
    expect((await worker.fetch(webhook('call.hangup'),env,fakeCtx)).status).toBe(200);
    await f.o.drain();
    expect(f.settled()).toBe(false);
    expect(await occupied()).toBe(0);
    const terminal = await f.o.storage.get('control');
    f.reply();
    expect((await f.pending).status).toBe(502);
    expect(f.socket.accept).toHaveBeenCalledOnce();
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(await f.o.storage.get('control')).toEqual(terminal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs the setup alarm and carrier hangup command without waiting for the session', async () => {
    const f = await pendingMedia();
    vi.setSystemTime(Date.now()+61_000);
    await f.o.object.alarm();
    expect(f.settled()).toBe(false);
    expect(requests.at(-1)!.url).toContain('/hangup');
    expect(await occupied()).toBe(1); // accepted command is not carrier release
    f.reply(); expect((await f.pending).status).toBe(502);
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(await f.o.storage.get('control')).toMatchObject({reason:'media_setup_timeout',ending:true});
  });

  it('rejects a duplicate upgrade immediately while the claimed session fetch is pending', async () => {
    const f = await pendingMedia();
    expect((await f.o.object.fetch(f.request())).status).toBe(409);
    expect(f.stubFetch).toHaveBeenCalledOnce();
    expect(f.settled()).toBe(false);
    f.reject(new Error('unavailable'));
    expect((await f.pending).status).toBe(502);
    expect(await occupied()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out after five seconds, retains reservation, and closes an upgrade returned after timeout', async () => {
    const f = await pendingMedia();
    await vi.advanceTimersByTimeAsync(4999); expect(f.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await f.pending).status).toBe(502);
    expect((f.stubFetch.mock.calls[0][0] as Request).signal.aborted).toBe(true);
    expect(await f.o.storage.get('control')).toMatchObject({ending:true,reason:'media_bridge_failed'});
    expect(await occupied()).toBe(1);
    f.reply(); for(let i=0;i<30;i++) await Promise.resolve();
    expect(f.socket.accept).toHaveBeenCalledOnce();
    expect(f.socket.close).toHaveBeenCalledOnce();
    await f.o.object.alarm();
    expect(requests.at(-1)!.url).toContain('/hangup');
    await f.o.event('call.hangup'); await f.o.drain();
    expect(await occupied()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['route','assistant','flag','token','deadline','socket'])('revalidates %s before installing a returned session', async change => {
    const f = await pendingMedia();
    if(change==='route') db.exec('UPDATE telnyx_number_routes SET enabled=0');
    if(change==='assistant') db.exec("UPDATE assistants SET state='paused'");
    if(change==='flag') env.TELNYX_ENABLED='false';
    if(change==='token') {
      const s=await f.o.storage.get<Record<string,unknown>>('control');
      await f.o.storage.put('control',{...s,streamToken:'b'.repeat(64)});
    }
    if(change==='deadline') vi.setSystemTime(Date.now()+61_000);
    if(change==='socket') f.socket.readyState=3;
    f.reply(); expect((await f.pending).status).toBe(502);
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(await occupied()).toBe(1);
    expect(await f.o.storage.get('control')).toMatchObject({ending:true,mediaValidated:false});
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not recreate retired state when the pending fetch eventually returns', async () => {
    const f=await pendingMedia();
    await f.o.event('call.hangup'); await f.o.drain();
    vi.setSystemTime(Date.now()+36*60_000); await f.o.object.alarm();
    expect([...f.o.storage.data]).toEqual([['retired',true]]);
    f.reply(); expect((await f.pending).status).toBe(502);
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect([...f.o.storage.data]).toEqual([['retired',true]]);
    expect(f.o.storage.alarm).toBeNull();
  });

  describe('post-connect failure reason provenance', () => {
    const publicFailureMessage = 'The telephone audio connection failed. Please review the call and retry.';
    const row = () => db.database.prepare('SELECT status, outcome, failure_code, failure_message, connected_at, carrier_released_at FROM calls WHERE id=?').get(callId);
    const eligibilityQuery = (sql: string) => sql.includes('JOIN telnyx_number_routes route ON route.connection_id=link.connection_id');
    async function signedHangup(f: Awaited<ReturnType<typeof pendingMedia>>) {
      env.TELNYX_CALL = { idFromName: () => callId, get: () => ({ fetch: (request: Request) => f.o.object.fetch(request) }) } as unknown as DurableObjectNamespace;
      expect((await worker.fetch(webhook('call.hangup'), env, fakeCtx)).status).toBe(200);
      await f.o.drain();
    }
    async function disposePending(f: Awaited<ReturnType<typeof pendingMedia>>) {
      db.hook = null;
      f.reply(); // Settled gates ignore this; still-pending sessions are released.
      await f.pending;
      await f.o.drain();
    }

    it.each(['assistant', 'route', 'engine'] as const)('preserves post-connect boolean eligibility loss: %s', async changed => {
      const f = await pendingMedia();
      try {
        if (changed === 'assistant') db.exec("UPDATE assistants SET state='paused'");
        if (changed === 'route') db.exec('UPDATE telnyx_number_routes SET enabled=0');
        if (changed === 'engine') db.exec("UPDATE assistants SET engine='pipeline'");
        f.reply(); const response = await f.pending;
        expect(response.status).toBe(502);
        expect(f.socket.accept).toHaveBeenCalledOnce(); expect(f.socket.close).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0); expect(await occupied()).toBe(1);
        const control = await f.o.storage.get<Record<string, unknown>>('control');
        expect(control).toMatchObject({ ending: true, terminal: false, mediaClaimed: true, mediaValidated: false });
        console.info('ELIGIBILITY_REASON_BEFORE_ASSERTION', JSON.stringify({ changed, responseStatus: response.status, reason: control?.reason, mediaValidated: control?.mediaValidated, socketCloseCalls: f.socket.close.mock.calls.length }));
        expect(control?.reason).toBe('assistant_unavailable');
        expect(row()).toMatchObject({ status: 'active', connected_at: null, carrier_released_at: null });
        // A transient projection error must leave the stored reason available to the alarm retry.
        let projectionAttempts = 0;
        db.hook = sql => { if (sql.includes('failure_code=?')) { projectionAttempts++; throw Error('synthetic projection unavailable'); } };
        await f.o.object.alarm();
        expect(projectionAttempts).toBe(1); expect(f.o.storage.alarm).toBe(Date.now() + 60_000);
        expect(row()).toMatchObject({ failure_code: null });
        db.hook = null;
        await f.o.object.alarm();
        expect(row()).toMatchObject({ status: 'active', outcome: 'failed', failure_code: 'assistant_unavailable', failure_message: publicFailureMessage, connected_at: null, carrier_released_at: null });
        expect(requests.at(-1)!.url).toContain('/hangup'); expect(await occupied()).toBe(1);
        await signedHangup(f);
        expect(row()).toMatchObject({ status: 'failed', outcome: 'failed', failure_code: 'assistant_unavailable', failure_message: publicFailureMessage, connected_at: null });
        expect(row()?.carrier_released_at).not.toBeNull(); expect(await occupied()).toBe(0);
      } finally { await disposePending(f); }
    });

    it.each(['connect', 'query', 'pair', 'carrier-accept'] as const)('does not promote thrown assistant_unavailable text: %s', async source => {
      const f = await pendingMedia();
      const construction = vi.fn(), carrier = { accept: vi.fn(() => { throw Error('assistant_unavailable'); }), close: vi.fn() };
      let queryAttempts = 0;
      try {
        if (source === 'query') db.hook = sql => { if (eligibilityQuery(sql)) { queryAttempts++; throw Error('assistant_unavailable'); } };
        if (source === 'pair' || source === 'carrier-accept') vi.stubGlobal('WebSocketPair', class {
          0 = {}; 1 = carrier;
          constructor() { construction(); if (source === 'pair') throw Error('assistant_unavailable'); }
        });
        if (source === 'connect') f.reject(Error('assistant_unavailable')); else f.reply();
        expect((await f.pending).status).toBe(502);
        expect(await f.o.storage.get('control')).toMatchObject({ ending: true, reason: 'media_bridge_failed', mediaValidated: false });
        expect(f.socket.close).toHaveBeenCalledTimes(source === 'connect' ? 0 : 1);
        if (source === 'query') expect(queryAttempts).toBe(1);
        if (source === 'pair' || source === 'carrier-accept') expect(construction).toHaveBeenCalledOnce();
        expect(carrier.close).toHaveBeenCalledTimes(source === 'carrier-accept' ? 1 : 0);
        expect(vi.getTimerCount()).toBe(0); expect(await occupied()).toBe(1);
        db.hook = null;
        await f.o.object.alarm();
        expect(row()).toMatchObject({ outcome: 'failed', failure_code: 'media_bridge_failed', failure_message: publicFailureMessage, connected_at: null, carrier_released_at: null });
      } finally { await disposePending(f); }
    });

    it('retains first-check unavailable403 without connecting a session', async () => {
      const o = owner(); await o.event('call.initiated'); await o.drain(); await o.event('call.answered'); await o.drain();
      const control = await o.storage.get<{ streamToken: string }>('control');
      const sessionFetch = vi.fn(async () => new Response(null, { status: 503 }));
      env.CALL_SESSION = { idFromName: () => callId, get: () => ({ fetch: sessionFetch }) } as unknown as DurableObjectNamespace;
      db.exec("UPDATE assistants SET state='paused'");
      const response = await o.object.fetch(new Request('https://internal/media', { headers: { Upgrade: 'websocket', 'x-telnyx-streaming-auth-token': control!.streamToken } }));
      expect(response.status).toBe(403); expect(sessionFetch).not.toHaveBeenCalled();
      expect(await o.storage.get('control')).toMatchObject({ ending: true, reason: 'assistant_unavailable', mediaClaimed: false, mediaValidated: false });
      expect(await occupied()).toBe(1);
    });

    it.each(['ending', 'terminal', 'retired'] as const)('preserves earlier %s state before late session reply', async prior => {
      const f = await pendingMedia();
      try {
        if (prior === 'ending') {
          vi.setSystemTime(Date.now() + 61_000); await f.o.object.alarm();
          expect(await f.o.storage.get('control')).toMatchObject({ reason: 'media_setup_timeout', ending: true });
        } else {
          await signedHangup(f);
          if (prior === 'retired') { vi.setSystemTime(Date.now() + 36 * 60_000); await f.o.object.alarm(); }
        }
        db.exec("UPDATE assistants SET state='paused'");
        const stored = structuredClone([...f.o.storage.data]); const persistedRow = row();
        f.reply(); expect((await f.pending).status).toBe(502);
        expect(f.socket.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
        expect([...f.o.storage.data]).toEqual(stored); expect(row()).toEqual(persistedRow);
        expect(await occupied()).toBe(prior === 'ending' ? 1 : 0);
      } finally { await disposePending(f); }
    });
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

  it('rejects invented, released and inactive carrier IDs before DO dispatch', async () => {
    const get = vi.fn(); env.TELNYX_CALL = { idFromName: (n: string) => n, get } as unknown as DurableObjectNamespace;
    const request = () => new Request(`https://openfon.test/ws/telnyx/${callId}`, { headers: {
      Upgrade: 'websocket', 'x-telnyx-streaming-auth-token': 'a'.repeat(64),
    } });
    expect((await worker.fetch(request(), env, fakeCtx)).status).toBe(404);
    await reserveTelnyxCall(env, callId, correlation, '+12025550101', '+12025550100');
    db.exec("UPDATE calls SET carrier_released_at=datetime('now')");
    expect((await worker.fetch(request(), env, fakeCtx)).status).toBe(404);
    db.exec("UPDATE calls SET carrier_released_at=NULL,status='completed'");
    expect((await worker.fetch(request(), env, fakeCtx)).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects well-formed invented call IDs without any D1 writes or DO dispatch', async () => {
    const get=vi.fn();
    env.TELNYX_CALL={idFromName:(n:string)=>n,get} as unknown as DurableObjectNamespace;
    const before=db.database.prepare('SELECT total_changes() AS n').get();
    for(let i=0;i<125;i++) {
      const id='tnx_'+i.toString(16).padStart(64,'0');
      const response=await worker.fetch(new Request(`https://openfon.test/ws/telnyx/${id}`,{headers:{
        Upgrade:'websocket','x-telnyx-streaming-auth-token':'a'.repeat(64),'CF-Connecting-IP':`192.0.2.${i+1}`,
      }}),env,fakeCtx);
      expect(response.status).toBe(404);
      vi.setSystemTime(Date.now() + 500); // exercise all rejected lookups within admission budget
    }
    expect(db.database.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(get).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it('rejects bogus tokens for a real active call without D1 or durable writes', async () => {
    const o=owner(); await o.event('call.initiated'); await o.drain();
    await o.event('call.answered'); await o.drain();
    const get=vi.fn(()=>({fetch:(r:Request)=>o.object.fetch(r)}));
    env.TELNYX_CALL={idFromName:(n:string)=>n,get} as unknown as DurableObjectNamespace;
    const state=await o.storage.get<{streamToken:string}>('control');
    const bogus=state!.streamToken==='a'.repeat(64)?'b'.repeat(64):'a'.repeat(64);
    const before=db.database.prepare('SELECT total_changes() AS n').get();
    const beforeStorage=structuredClone([...o.storage.data]), beforeAlarm=o.storage.alarm;
    const beforeCommands=requests.length;
    for(let i=0;i<125;i++) {
      const response=await worker.fetch(new Request(`https://openfon.test/ws/telnyx/${callId}`,{headers:{
        Upgrade:'websocket','x-telnyx-streaming-auth-token':bogus,'CF-Connecting-IP':`192.0.2.${i+1}`,
      }}),env,fakeCtx);
      expect(response.status).toBe(403);
      vi.setSystemTime(Date.now() + 500);
    }
    expect(get).toHaveBeenCalledTimes(125); // real owner performed authentication
    expect(db.database.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect([...o.storage.data]).toEqual(beforeStorage);
    expect(o.storage.alarm).toBe(beforeAlarm);
    expect(requests).toHaveLength(beforeCommands);
  });

  it('preserves authenticated single media claim and signed hangup through the public route', async () => {
    const o=owner(); await o.event('call.initiated'); await o.drain();
    await o.event('call.answered'); await o.drain();
    env.TELNYX_CALL={idFromName:(n:string)=>n,get:()=>({fetch:(r:Request)=>o.object.fetch(r)})} as unknown as DurableObjectNamespace;
    let reject!: (error:Error)=>void;
    const stub=vi.fn(()=>new Promise<Response>((_,no)=>{reject=no;}));
    env.CALL_SESSION={idFromName:(n:string)=>n,get:()=>({fetch:stub})} as unknown as DurableObjectNamespace;
    const state=await o.storage.get<{streamToken:string}>('control');
    const request=()=>new Request(`https://openfon.test/ws/telnyx/${callId}`,{headers:{
      Upgrade:'websocket','x-telnyx-streaming-auth-token':state!.streamToken,
    }});
    const first=worker.fetch(request(),env,fakeCtx);
    try {
      for(let i=0;i<200&&!stub.mock.calls.length;i++) await Promise.resolve();
      expect(stub).toHaveBeenCalledOnce();
      const before=db.database.prepare('SELECT total_changes() AS n').get();
      const beforeStorage=structuredClone([...o.storage.data]);
      expect((await worker.fetch(request(),env,fakeCtx)).status).toBe(409);
      expect(stub).toHaveBeenCalledOnce();
      expect(db.database.prepare('SELECT total_changes() AS n').get()).toEqual(before);
      expect([...o.storage.data]).toEqual(beforeStorage);
      expect(await occupied()).toBe(1);
      expect((await worker.fetch(webhook('call.hangup'),env,fakeCtx)).status).toBe(200);
      await o.drain(); expect(await occupied()).toBe(0);
    } finally {reject(new Error('test connection ended'));await first;}
    expect((await worker.fetch(request(),env,fakeCtx)).status).toBe(404);
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
