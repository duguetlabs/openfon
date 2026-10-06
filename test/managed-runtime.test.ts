import { readFileSync } from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  GptLiveEngine,
  type GptLiveHost,
  type GptLiveSessionOptions,
} from '../src/gpt-live';
import { CallSession } from '../src/call-session';
import { resolveRealtime, gptLiveConnection } from '../src/realtime-providers';
import { azureUsageObservation } from '../src/azure-usage';
import type { Env } from '../src/types';
const env = {
  OPENFON_MANAGED_WEB: 'true',
  AZURE_OPENAI_ENDPOINT: 'https://fixture.cognitiveservices.azure.com',
  AZURE_OPENAI_API_KEY: 'synthetic-key',
} as Env;
class Socket {
  listeners = new Map<string, Array<(event: any) => void>>();
  sent: any[] = [];
  closed = false;
  accept() {}
  addEventListener(name: string, fn: (event: any) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  receive(event: unknown) {
    for (const fn of this.listeners.get('message') ?? [])
      fn({ data: JSON.stringify(event) });
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.closed = true;
    for (const fn of this.listeners.get('close') ?? []) fn({});
  }
}
const options: GptLiveSessionOptions = {
  instructions: 'Business facts',
  voice: 'marin',
  delegationModel: 'gpt-5.4-mini',
  delegationInstructions: 'Delegate',
  greeting: null,
};
const microtasks = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function connected() {
  const socket = new Socket(),
    seen: Record<string, unknown>[] = [];
  const host: GptLiveHost = {
    debug: null,
    admitAudio: () => null,
    audioPaused: () => {},
    playAudio: () => {},
    turn: () => {},
    closeRequested: () => {},
    readyToHangUp: () => {},
    failed: vi.fn(),
    disconnected: vi.fn(),
    providerEvent: (e) => seen.push(e),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ status: 101, webSocket: socket }))
  );
  const engine = new GptLiveEngine(resolveRealtime(env, null), host);
  const started = engine.start(options);
  await microtasks();
  socket.receive({
    type: 'session.started',
    session: {
      id: 'sess_1',
      model: 'gpt-live-1',
      delegation: { responses: { model: 'gpt-5.4-mini' } },
      audio: {
        format: { type: 'audio/pcm', rate: 24000 },
        output: { voice: 'marin' },
      },
    },
  });
  expect(await started).toBe(true);
  return { engine, socket, host, seen };
}
describe('direct Azure carrier and customer disclosure boundary', () => {
  it('uses only operator Azure authentication and preserved live protocol', () => {
    expect(gptLiveConnection(resolveRealtime(env, null))).toEqual({
      url: 'https://fixture.cognitiveservices.azure.com/openai/v1/live/sessions',
      headers: { Upgrade: 'websocket', 'api-key': 'synthetic-key' },
    });
  });
  it('ends after two seconds when provider sends no final usage and never closes', async () => {
    vi.useFakeTimers();
    const { engine, socket } = await connected();
    let completed = false;
    const closing = engine.closeAndDrain().then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(socket.closed).toBe(true);
    expect(socket.sent.filter((e) => e.type === 'session.close')).toHaveLength(
      1
    );
  });
  it('drains a late terminal usage frame once before closing; repeated close never reopens', async () => {
    vi.useFakeTimers();
    const { engine, socket, seen } = await connected();
    const closing = engine.closeAndDrain();
    await vi.advanceTimersByTimeAsync(1500);
    socket.receive({ type: 'session.closed', usage: { seconds: 1.5 } });
    await closing;
    await engine.closeAndDrain();
    expect(seen.filter((e) => e.type === 'session.closed')).toHaveLength(1);
    expect(socket.sent.filter((e) => e.type === 'session.close')).toHaveLength(
      1
    );
  });
  it('provider error content never reaches a managed customer or its persisted failure', async () => {
    const { engine, socket, host } = await connected();
    socket.receive({
      type: 'error',
      error: {
        code: 'invalid',
        message: 'SECRET_MARKER endpoint provider-model',
      },
    });
    const error = vi.mocked(host.failed).mock.calls[0]![0];
    expect(error.message).not.toContain('SECRET_MARKER');
    const outgoing: string[] = [];
    const session = new CallSession({} as DurableObjectState, env) as any;
    session.ws = { send: (s: string) => outgoing.push(s) };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    session.gptLiveHost().failed(error);
    expect(outgoing.join('')).toContain('Please try again');
    expect(outgoing.join('')).not.toMatch(/GPT|provider|Azure|SECRET_MARKER/);
    expect(session.failure).not.toMatch(/GPT|provider|Azure|SECRET_MARKER/);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('SECRET_MARKER');
    engine.close();
  });
  it('tracks missing and late usage without fabricating zero seconds or changing repeated identity', async () => {
    const unknown = await azureUsageObservation('c', 'j', 's', {
      type: 'openfon.usage.unreported',
    });
    expect(unknown).toMatchObject({ final: false, metrics: {} });
    const first = await azureUsageObservation('c', 'j', 's', {
        type: 'session.closed',
        usage: { seconds: 2.125 },
      }),
      repeat = await azureUsageObservation('c', 'j', 's', {
        type: 'session.closed',
        usage: { seconds: 2.125 },
      });
    expect(first?.eventId).toBe(repeat?.eventId);
    expect(first?.metrics.voiceSessionSeconds).toBe('2.125');
    expect(first?.eventId).not.toBe(unknown?.eventId);
  });
});
it('carrier queues only usage events and retries failed durable writes without dropping subsequent records', async () => {
  const values = new Map<string, unknown>();
  let fail = true;
  const storage = {
    get: async (k: string) => values.get(k),
    list: async ({ prefix }: { prefix: string }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
    put: async (k: string, v: unknown) => {
      if (fail) {
        fail = false;
        throw Error('temporary storage failure');
      }
      values.set(k, v);
    },
  };
  const session = new CallSession(
    { storage, waitUntil: () => {} } as unknown as DurableObjectState,
    env
  ) as any;
  session.callId = 'c';
  session.ended = true;
  session.captureCarrierUsage({
    type: 'session.started',
    session: { id: 's' },
  });
  for (let i = 0; i < 2000; i++)
    session.captureCarrierUsage({
      type: 'session.output_audio.delta',
      delta: 'not retained',
    });
  expect(session.carrierPendingWrites.size).toBe(0);
  session.captureCarrierUsage({
    type: 'session.usage.updated',
    usage: { seconds: 1 },
  });
  session.captureCarrierUsage({
    type: 'session.closed',
    usage: { seconds: 2 },
  });
  await session.flushCarrierUsage();
  expect(values.size).toBe(2);
  expect(session.carrierPendingWrites.size).toBe(0);
  expect(
    [...values.values()]
      .map((v: any) => v.observation.metrics.voiceSessionSeconds)
      .sort()
  ).toEqual(['1', '2']);
});
it('selected Azure preview returns PCM WAV and preserves terminal usage; missing closure stays bounded and unknown', async () => {
  vi.useFakeTimers();
  const { azureVoicePreview } = await import('../src/managed-voice-preview');
  const socket = new Socket(),
    observations: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ status: 101, webSocket: socket }))
  );
  const sample = azureVoicePreview(
    env,
    { voice: 'cedar', language: 'en' },
    new AbortController().signal,
    async (usage) => {
      observations.push(usage);
    }
  );
  await microtasks();
  expect(socket.sent[0].session.audio.output.voice).toBe('cedar');
  socket.receive({
    type: 'session.started',
    session: {
      id: 'preview_1',
      model: 'gpt-live-1',
      audio: {
        format: { type: 'audio/pcm', rate: 24000 },
        output: { voice: 'cedar' },
      },
    },
  });
  const speech = Buffer.alloc(4800);
  for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(6000, i);
  socket.receive({
    type: 'session.output_audio.delta',
    delta: speech.toString('base64'),
  });
  for (let i = 0; i < 8; i++)
    socket.receive({
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(4800).toString('base64'),
    });
  await vi.advanceTimersByTimeAsync(3000);
  const wav = await sample;
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
  expect(observations).toEqual([{ sessionId: 'preview_1', final: false }]);
  expect(socket.closed).toBe(true);
});
it('unconfirmed setup failures finish without a fictitious billed interval, while failed connected service is idempotently metered', async () => {
  const { SqliteD1, applyMigrations } = await import('./sqlite-d1');
  const db = new SqliteD1();
  try {
    applyMigrations(db);
    db.exec(readFileSync('migrations/0027_commercial.sql', 'utf8'));
    db.exec(
      "INSERT INTO users(id,email,password_hash) VALUES('u','u@example.invalid','unused');INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','Business');INSERT INTO calls(id,business_id,status) VALUES('setup','b','failed');INSERT INTO calls(id,business_id,status,connected_at) VALUES('service','b','failed','2026-10-05 00:00:00')"
    );
    const values = new Map<string, unknown>([['managed-service-start', 1000]]);
    const storage = {
      get: async (k: string) => values.get(k),
      list: async () => new Map(),
    };
    const session = new CallSession(
      { storage } as unknown as DurableObjectState,
      { ...env, DB: db as unknown as D1Database }
    ) as any;
    session.callId = 'setup';
    await session.finishManagedAccounting(2000);
    expect(
      db.database.prepare('SELECT COUNT(*) n FROM commercial_call_usage').get()
    ).toEqual({ n: 0 });
    session.callId = 'service';
    await session.finishManagedAccounting(2000);
    await session.finishManagedAccounting(2000);
    expect(
      db.database.prepare('SELECT duration_ms FROM commercial_call_usage').get()
    ).toEqual({ duration_ms: 1000 });
  } finally {
    db.close();
  }
});

describe('managed cancellation admission cutoff', () => {
  async function fixture(termEnd: string) {
    const { SqliteD1, applyMigrations } = await import('./sqlite-d1');
    const db = new SqliteD1();
    applyMigrations(db);
    db.exec(readFileSync('migrations/0027_commercial.sql', 'utf8'));
    db.exec("INSERT INTO users(id,email,password_hash) VALUES('u','u@example.invalid','unused'); INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','Business'); INSERT INTO calls(id,business_id,channel,connected_at) VALUES('c','b','web','1999-12-31 23:59:59')");
    db.database.prepare("INSERT INTO commercial_cancellations VALUES('b',?,'uncertain','1999-12-31T00:00:00Z')").run(termEnd);
    const media = {callId:'c',room:'room',caller:'caller',callback:'callback',instructions:'Instructions',greeting:'Hello',voice:'marin',language:'en',startupDeadline:Date.now()+60000};
    const values = new Map<string, unknown>([['livekit',media]]);
    const storage = {get:async(k:string)=>structuredClone(values.get(k)),put:async(k:string,v:unknown)=>{values.set(k,structuredClone(v));}};
    const session = new CallSession({storage} as unknown as DurableObjectState,{...env,DB:db as unknown as D1Database,LIVEKIT_AGENT_SERVICE_TOKEN:'synthetic-service'}) as any;
    const context = (jobId='job')=>session.livekitRequest(new Request('https://internal/livekit/context?call=c',{method:'POST',headers:{Authorization:'Bearer synthetic-service','Content-Type':'application/json'},body:JSON.stringify({room:'room',jobId})}));
    return {db,session,context,values};
  }
  it('refuses a first job after expiry without recording it', async () => {
    const {db,context,values}=await fixture('2000-01-01T00:00:00Z');
    try {
      expect((await context()).status).toBe(410);
      expect((values.get('livekit') as any).jobId).toBeUndefined();
    } finally {db.close();}
  });
  it('admits before expiry and preserves same-job polling after expiry, while rejecting replacement jobs', async () => {
    const {db,context,values}=await fixture('2999-01-01T00:00:00Z');
    try {
      expect((await context()).status).toBe(200);
      db.exec("UPDATE commercial_cancellations SET term_end='2000-01-01T00:00:00Z'");
      expect((await context()).status).toBe(200);
      expect((await context('replacement')).status).toBe(409);
      expect((values.get('livekit') as any).jobId).toBe('job');
    } finally {db.close();}
  });
  it('does not apply the managed job cutoff to self-hosted calls', async () => {
    const {db,session,context}=await fixture('2000-01-01T00:00:00Z');
    try {
      session.env.OPENFON_MANAGED_WEB='false';
      expect((await context()).status).toBe(200);
    } finally {db.close();}
  });
  it('blocks new call startup after expiry but preserves a connected carrier startup', async () => {
    const {db,session}=await fixture('2000-01-01T00:00:00Z');
    try {
      session.callId='c';
      session.loadSettings=async()=>{session.settings={};};
      await expect(session.loadCall()).rejects.toThrow('subscription ends');
      db.exec("UPDATE calls SET channel='telnyx',connected_at=NULL");
      await expect(session.loadCall()).rejects.toThrow('subscription ends');
      db.exec("UPDATE calls SET connected_at='1999-12-31 23:59:59'");
      await expect(session.loadCall()).resolves.toBeUndefined();
    } finally {db.close();}
  });
});

it('failed cached extraction cannot project legacy actions at finalization, while keeping summary and charged usage', async () => {
  const {SqliteD1,applyMigrations}=await import('./sqlite-d1');
  const db=new SqliteD1();
  try {
    applyMigrations(db);
    db.exec(readFileSync('migrations/0026_business_actions.sql','utf8'));
    db.exec(readFileSync('migrations/0027_commercial.sql','utf8'));
    db.exec("INSERT INTO users(id,email,password_hash) VALUES('u','u@example.invalid','unused'); INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','Business'); INSERT INTO calls(id,business_id,channel) VALUES('c','b','web')");
    const cached={summary:{summary:'Useful call notes',intent:'booking',caller_name:'Alex',caller_phone:null,message:'Call me back',actions:[],responseId:'resp_partial',model:'gpt-5.4-mini',usage:{inputTokens:7},processingFailed:true},observation:{eventId:'summary_resp_partial',source:'azure_text',providerSessionId:'resp_partial',providerResponseId:'resp_partial',observedAt:new Date().toISOString(),final:true,metrics:{inputTokens:7},model:'gpt-5.4-mini'}};
    const values=new Map<string,unknown>([['managed-summary',cached]]);
    const storage={get:async(k:string)=>values.get(k),put:async(k:string,v:unknown)=>{values.set(k,v);},list:async()=>new Map(),deleteAlarm:async()=>{},deleteAll:async()=>{}};
    const session=new CallSession({storage} as unknown as DurableObjectState,{...env,DB:db as unknown as D1Database}) as any;
    session.callId='c';session.history=[{role:'system',content:''},{role:'user',content:'Please call me back'},{role:'assistant',content:'Goodbye'}];session.settings={language:'en'};
    await session.finalize();
    expect(db.database.prepare('SELECT count(*) n FROM action_items').get()).toEqual({n:0});
    expect(db.database.prepare('SELECT count(*) n FROM call_action_extractions').get()).toEqual({n:0});
    expect(db.database.prepare('SELECT status,summary,intent,message_json,outcome FROM calls').get()).toEqual({status:'completed',summary:'Useful call notes',intent:null,message_json:null,outcome:'answered'});
    expect(db.database.prepare('SELECT count(*) n FROM commercial_provider_observations').get()).toEqual({n:1});
  }finally{db.close();}
});

describe('complete managed transcript extraction boundary', () => {
  for (const count of [200, 201]) it(`${count} final turns cannot seal a truncated action snapshot`, async () => {
    const {SqliteD1,applyMigrations}=await import('./sqlite-d1');
    const db=new SqliteD1();
    try {
      applyMigrations(db);
      db.exec(readFileSync('migrations/0026_business_actions.sql','utf8'));
      db.exec(readFileSync('migrations/0027_commercial.sql','utf8'));
      db.exec("INSERT INTO users(id,email,password_hash) VALUES('u','u@example.invalid','unused'); INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','Business'); INSERT INTO calls(id,business_id,channel) VALUES('c','b','web')");
      for(let i=0;i<count;i++)db.database.prepare("INSERT INTO call_turns(call_id,role,text,source_final) VALUES('c','caller',?,1)").run(`Please call me back ${i}`);
      const fetchMock=vi.fn(async()=>Response.json({id:'resp_complete',model:'gpt-5.4-mini',status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Complete notes',intent:'booking',caller_name:'Alex',caller_phone:null,message:'Please call',actions:[{kind:'callback',source_turn_id:1,content:'Please call me back'}]})}]}],usage:{input_tokens:7}}));
      vi.stubGlobal('fetch',fetchMock);
      const values=new Map<string,unknown>();
      const storage={get:async(k:string)=>values.get(k),put:async(k:string,v:unknown)=>{values.set(k,v);},list:async()=>new Map(),deleteAlarm:async()=>{},deleteAll:async()=>{}};
      const makeSession=()=>{
        const session=new CallSession({storage} as unknown as DurableObjectState,{...env,DB:db as unknown as D1Database}) as any;
        session.callId='c';session.history=[{role:'system',content:''},{role:'user',content:'Please call me back'},{role:'assistant',content:'Goodbye'}];session.settings={language:'en'};
        return session;
      };
      await makeSession().finalize();
      expect(fetchMock).toHaveBeenCalledTimes(count===200?1:0);
      expect(db.database.prepare('SELECT count(*) n FROM call_turns').get()).toEqual({n:count});
      expect(db.database.prepare('SELECT count(*) n FROM call_action_extractions').get()).toEqual({n:count===200?1:0});
      if(count===201){
        expect(values.has('managed-summary')).toBe(false);
        expect(values.get('managed-summary-attempted')).toBe(true);
        expect(db.database.prepare('SELECT count(*) n FROM action_items').get()).toEqual({n:0});
        expect(db.database.prepare('SELECT status,summary,intent,message_json FROM calls').get()).toEqual({status:'completed',summary:'Call notes could not be prepared from the complete conversation. The full transcript is available.',intent:null,message_json:null});
        // A new object retry must neither infer a partial result nor revive legacy actions.
        await makeSession().finalize();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(db.database.prepare('SELECT count(*) n FROM action_items').get()).toEqual({n:0});
      }
    }finally{db.close();}
  });
});
it('summary cache-write diagnostics omit secret canaries and keep attempted inference non-replayable',async()=>{
 const {SqliteD1,applyMigrations}=await import('./sqlite-d1');const db=new SqliteD1();const logs=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  applyMigrations(db);db.exec(readFileSync('migrations/0026_business_actions.sql','utf8'));db.exec(readFileSync('migrations/0027_commercial.sql','utf8'));
  db.exec("INSERT INTO users(id,email,password_hash)VALUES('u','u@example.invalid','x');INSERT INTO businesses(id,user_id,slug,name)VALUES('b','u','b','B');INSERT INTO calls(id,business_id,channel)VALUES('c','b','web');INSERT INTO call_turns(call_id,role,text,source_final)VALUES('c','caller','Please call me back',1)");
  const fetcher=vi.fn(async()=>Response.json({id:'response',model:'gpt-5.4-mini',status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'Notes',actions:[]})}]}],usage:{input_tokens:7}}));vi.stubGlobal('fetch',fetcher);
  const values=new Map<string,unknown>();const storage={get:async(k:string)=>values.get(k),put:async(k:string,v:unknown)=>{if(k==='managed-summary')throw Error('synthetic-private-cache-canary');values.set(k,v)},list:async()=>new Map(),deleteAlarm:async()=>{},deleteAll:async()=>{}};
  const make=()=>{const s=new CallSession({storage} as unknown as DurableObjectState,{...env,DB:db as unknown as D1Database}) as any;s.callId='c';s.history=[{role:'system',content:''},{role:'user',content:'Please call'},{role:'assistant',content:'Goodbye'}];s.settings={language:'en'};return s;};
  await make().finalize();await make().finalize();
  expect(fetcher).toHaveBeenCalledTimes(1);expect(values.get('managed-summary-attempted')).toBe(true);
  const rendered=logs.mock.calls.map(args=>args.join(' ')).join('\n');expect(rendered).toContain('cache_write');expect(rendered).not.toContain('synthetic-private-cache-canary');
 }finally{logs.mockRestore();db.close();}
});
