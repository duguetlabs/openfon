// GPT-Live (gpt-live-1) engine: protocol handling in CallSession against a fake
// gateway socket, plus provider resolution, settings validation and preview.
// Event shapes follow the live-service probe of 2026-09-24 (see src/gpt-live.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallSession } from '../src/call-session';
import { gptLiveSessionStart, silentPcm } from '../src/gpt-live';
import { assistantCompatibilityError, presetCompatibilityError } from '../src/provider-settings';
import { gptLiveConnection, realtimeCapabilities, resolveRealtime, telephoneRealtimeAvailable, type RealtimeConfig } from '../src/realtime-providers';
import { generateVoicePreview, gptLivePreview } from '../src/voice-preview';
import type { AgentSettings, Env } from '../src/types';

class FakeSocket {
  readyState = 1;
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};
  accept(): void {}
  send(data: unknown): void {
    if (this.readyState !== 1) throw new Error('socket closed');
    this.sent.push(data);
    // A browser/carrier acknowledging each admitted frame, as the real clients do.
    if (typeof data === 'string' && /^\{"type":"(audio|control)_receipt"/.test(data)) {
      const { id } = JSON.parse(data);
      queueMicrotask(() => { if (this.readyState === 1) this.receive({ type: 'audio_received', id }); });
    }
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3; this.closed = { code, reason };
    this.emit('close', { code, reason });
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(): void {}
  emit(type: string, ev: unknown): void { for (const fn of [...(this.listeners[type] ?? [])]) fn(ev); }
  receive(obj: unknown): void { this.emit('message', { data: JSON.stringify(obj) }); }
  messages(): { type: string; [k: string]: any }[] {
    return this.sent.filter(s => typeof s === 'string').map(s => JSON.parse(s as string));
  }
  of(type: string) { return this.messages().filter(m => m.type === type); }
  binary(): ArrayBuffer[] { return this.sent.filter(s => s instanceof ArrayBuffer) as ArrayBuffer[]; }
}

class FakeStorage {
  map = new Map<string, unknown>();
  async get(key: string) { return this.map.get(key); }
  async put(key: string | Record<string, unknown>, value?: unknown) {
    if (typeof key === 'string') this.map.set(key, value); else for (const [k, v] of Object.entries(key)) this.map.set(k, v);
  }
  async delete(key: string | string[]) { for (const k of [key].flat()) this.map.delete(k); return true; }
  async deleteAll() { this.map.clear(); }
  async setAlarm() {}
  async deleteAlarm() {}
}

const SETTINGS = {
  business_id: 'biz-1', agent_name: 'Alex', greeting: 'Thanks for calling Riverside Dental!', persona: 'friendly',
  language: 'en', voice: '', take_messages: 1, custom_instructions: '', llm_base_url: '', llm_api_key: '', llm_model: '',
  engine: 'realtime', realtime_model: 'gpt-live-1', realtime_voice: '',
  tts_provider: 'instance', tts_base_url: '', tts_api_key: '', tts_model: '',
};

function fakeDb(channel: string, settings: Record<string, unknown>) {
  const writes: { sql: string; args: unknown[] }[] = [];
  return { writes, db: { prepare(sql: string) { return { bind(...args: unknown[]) { return {
    async first() {
      if (sql.includes('FROM calls')) {
        if (sql.includes("failure_code GLOB 'asterisk_*'")) return null;
        return { id: 'call-1', business_id: 'biz-1', status: 'active', started_at: '2026-09-24 12:00:00', channel };
      }
      if (sql.includes('FROM businesses')) return { id: 'biz-1', user_id: 'u1', slug: 'riverside', name: 'Riverside Dental',
        description: '', address: '', phone: '', website: '', timezone: 'Europe/Vienna', hours_json: '[]', services_json: '[]', faqs_json: '[]', closures_json: '[]' };
      if (sql.includes('FROM agent_settings')) return { ...SETTINGS, ...settings };
      return null;
    },
    async all() { return { results: [] }; },
    async run() { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
  }; } }; } } };
}

const ENV = {
  ASSETS: {}, CALL_SESSION: {},
  DEFAULT_LLM_BASE_URL: 'https://llm.invalid/v1', DEFAULT_LLM_MODEL: 'test-model', DEFAULT_LLM_API_KEY: 'llm-key',
  DEFAULT_STT_BASE_URL: 'https://llm.invalid/v1', DEFAULT_STT_MODEL: 'test-stt',
  DEFAULT_TTS_PROVIDER: 'browser', AZURE_SPEECH_REGION: 'westeurope', DEFAULT_TTS_VOICE: 'en-US-AvaMultilingualNeural',
  REALTIME_BASE_URL: 'wss://api.kataleptic.com/v1/realtime', REALTIME_MODEL: 'kataleptic-realtime-hd', REALTIME_API_KEY: 'gateway-key',
};

const flush = async (rounds = 40) => { for (let i = 0; i < rounds; i++) await Promise.resolve(); };
const pcm = (sample: number, bytes = 4800) => { const b = Buffer.alloc(bytes); for (let i = 0; i < bytes; i += 2) b.writeInt16LE(sample, i); return b; };
const SPEECH = pcm(6000).toString('base64');
const SILENCE = pcm(0).toString('base64');

let callers: FakeSocket[] = [];
let gateways: FakeSocket[] = [];
let upgrades: { url: string; init: RequestInit }[] = [];
const saved: Record<string, unknown> = {};

beforeEach(() => {
  callers = []; gateways = []; upgrades = [];
  for (const k of ['WebSocketPair', 'Response', 'fetch']) saved[k] = (globalThis as never)[k];
  (globalThis as never as Record<string, unknown>).WebSocketPair = function () {
    const client = new FakeSocket(), server = new FakeSocket(); callers.push(server); return { 0: client, 1: server };
  };
  (globalThis as never as Record<string, unknown>).Response = class {
    constructor(public body: unknown, public init: { status?: number; webSocket?: unknown } = {}) {}
    get status() { return this.init.status ?? 200; }
    get webSocket() { return this.init.webSocket ?? null; }
  };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/v1/live/sessions')) {
      upgrades.push({ url, init });
      const ws = new FakeSocket(); gateways.push(ws);
      return { status: 101, webSocket: ws } as unknown as Response;
    }
    throw new Error('no network in unit tests'); // summaries fall back to their built-in text
  }) as typeof fetch;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) (globalThis as never as Record<string, unknown>)[k] = v;
  vi.useRealTimers(); vi.restoreAllMocks();
});

async function call(options: { channel?: string; settings?: Record<string, unknown>; env?: Record<string, unknown>; started?: boolean } = {}) {
  const backing = fakeDb(options.channel ?? 'web', options.settings ?? {});
  const session = new CallSession({ storage: new FakeStorage() } as unknown as DurableObjectState,
    { ...ENV, ...options.env, DB: backing.db } as unknown as Env);
  await session.fetch({ url: 'https://example.test/ws/call?call=call-1', headers: { get: (h: string) => h === 'Upgrade' ? 'websocket' : null } } as unknown as Request);
  const caller = callers[0];
  caller.receive({ type: 'start' }); await flush();
  const gateway = gateways[0];
  const start = gateway?.of('session.start')[0];
  if (options.started !== false && start) { gateway.receive({ type: 'session.started', session: { ...start.session, id: 'live_1', status: 'active' } }); await flush(); }
  const turns = () => backing.writes.filter(w => w.sql.includes('INSERT INTO call_turns')).map(w => [w.args[1], w.args[2]]);
  const rows = () => backing.writes.filter(w => w.sql.includes('UPDATE calls'));
  return { session, caller, gateway, start, turns, rows };
}
const audio = (gateway: FakeSocket, delta: string, n = 1) => { for (let i = 0; i < n; i++) gateway.receive({ type: 'session.output_audio.delta', delta }); };
const said = (gateway: FakeSocket, role: 'caller' | 'agent', delta: string, startMs: number) =>
  gateway.receive({ type: role === 'caller' ? 'session.input_transcript.delta' : 'session.output_transcript.delta', delta, start_ms: startMs, end_ms: startMs + 200 });

describe('GPT-Live provider resolution', () => {
  const env = ENV as unknown as Env;
  const settings = (s: Record<string, unknown>) => ({ ...SETTINGS, ...s }) as unknown as AgentSettings;

  it('serves gpt-live-1 on the Kataleptic gateway instead of substituting HD', () => {
    const config = resolveRealtime(env, settings({}));
    expect(config).toMatchObject({ model: 'gpt-live-1', protocol: 'gateway' });
    expect(config.retiredModel).toBeUndefined();
    expect(realtimeCapabilities(config)).toEqual({ engineGreeting: true, managedVoice: false, transcriptionModel: null });
    expect(telephoneRealtimeAvailable(env, settings({}))).toBe(true);
  });

  it('derives /v1/live/sessions from the realtime URL with header auth and no model or credential query', () => {
    const config = resolveRealtime({ ...env, REALTIME_BASE_URL: 'wss://gw.example/v1/realtime?token=a&api_key=b&route=eu' } as Env, settings({}));
    expect(gptLiveConnection(config)).toEqual({ url: 'https://gw.example/v1/live/sessions?route=eu',
      headers: { Upgrade: 'websocket', Authorization: 'Bearer gateway-key' } });
    expect(gptLiveConnection(resolveRealtime(env, settings({}))).url).toBe('https://api.kataleptic.com/v1/live/sessions');
  });

  it('refuses gpt-live-1 on direct OpenAI and custom realtime providers', () => {
    expect(() => resolveRealtime(env, settings({ realtime_provider: 'openai', realtime_api_key: 'k' }))).toThrow(/OpenAI realtime model/);
    expect(() => resolveRealtime(env, settings({ realtime_provider: 'custom', realtime_base_url: 'wss://custom.example/v1/realtime', realtime_api_key: 'k' })))
      .toThrow(/only through the Kataleptic gateway/);
  });

  it('accepts gpt-live-1 in assistant and preset validation for Kataleptic, not for OpenAI', () => {
    const live = { engine: 'realtime', realtime_model: 'gpt-live-1', realtime_voice: 'cedar' };
    expect(assistantCompatibilityError(env, null, live)).toBeNull();
    expect(presetCompatibilityError(env, null, live)).toBeNull();
    const openai = { realtime_provider: 'openai', realtime_base_url: 'wss://api.openai.com/v1/realtime', realtime_api_key: 'k' } as never;
    expect(assistantCompatibilityError(env, openai, live)).toMatch(/OpenAI realtime model/);
    expect(presetCompatibilityError(env, openai, live)).toMatch(/Cannot apply preset/);
  });
});

describe('GPT-Live session start', () => {
  it('sends the strict session.start shape with voice, format and function-only delegation', async () => {
    const { start, gateway, caller } = await call({ settings: { realtime_voice: 'cedar' }, env: { GPT_LIVE_DELEGATION_MODEL: 'gpt-5.4' } });
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0].url).toBe('https://api.kataleptic.com/v1/live/sessions');
    expect(new Headers(upgrades[0].init.headers).get('Authorization')).toBe('Bearer gateway-key');
    expect(upgrades[0].init.redirect).toBe('manual');
    expect(Object.keys(start!.session).sort()).toEqual(['audio', 'delegation', 'instructions', 'model']);
    expect(start!.session.model).toBe('gpt-live-1');
    expect(start!.session.audio).toEqual({ format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'cedar' } });
    expect(start!.session.instructions).toContain('Riverside Dental');
    expect(start!.session.instructions).toMatch(/delegate so the call can be ended/);
    const delegation = start!.session.delegation;
    expect(delegation.type).toBe('responses');
    expect(delegation.responses.model).toBe('gpt-5.4');
    expect(delegation.responses.tool_choice).toBe('auto');
    expect(delegation.responses.instructions).toContain('Riverside Dental'); // business facts for delegated answers
    expect(delegation.responses.tools).toEqual([expect.objectContaining({ type: 'function', name: 'end_call' })]);
    // Greeting through commentary, right after session.started; the call is ready.
    expect(gateway.of('session.commentary.append')).toEqual([{ type: 'session.commentary.append', delegation_id: null,
      content: "Greet the caller: 'Thanks for calling Riverside Dental!'" }]);
    expect(caller.of('ready')[0]).toMatchObject({ mode: 'realtime', greeting: '', engine: 'realtime · gpt-live-1', audioReceipts: true });
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('defaults the delegation model and omits a voice outside the GPT-Live catalog', async () => {
    const { start, caller } = await call({ settings: { realtime_voice: 'en-US-AvaMultilingualNeural' } });
    expect(start!.session.audio).toEqual({ format: { type: 'audio/pcm', rate: 24000 } });
    expect(start!.session.delegation.responses.model).toBe('gpt-5.4-mini');
    caller.receive({ type: 'hangup' }); await flush();
  });

  it.each([
    ['a different model', { model: 'gpt-realtime-2' }],
    ['another audio format', { audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'cedar' } } }],
    ['another voice', { audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' } } }],
  ])('fails the call when session.started confirms %s', async (_, override) => {
    const { gateway, caller, start, rows } = await call({ settings: { realtime_voice: 'cedar' }, started: false });
    gateway.receive({ type: 'session.started', session: { ...start!.session, ...override } }); await flush(80);
    expect(caller.of('ready')).toHaveLength(0);
    expect(caller.of('ended')).toHaveLength(1);
    expect(gateway.closed).not.toBeNull();
    expect(rows().some(w => w.args[0] === 'failed')).toBe(true);
  });

  it('fails the call on an error before session.started without exposing it', async () => {
    const { gateway, caller, rows } = await call({ started: false });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    gateway.receive({ type: 'error', error: { type: 'invalid_request_error', code: 'unknown_parameter', message: 'secret-detail' } }); await flush(80);
    expect(caller.of('ready')).toHaveLength(0);
    expect(rows().some(w => w.args[0] === 'failed')).toBe(true);
    expect(JSON.stringify([caller.messages(), rows()])).not.toContain('secret-detail');
    log.mockRestore();
  });

  it('withholds carrier ready until the greeting is audible, dropping the leading silence', async () => {
    const { gateway, caller } = await call({ channel: 'telnyx' });
    audio(gateway, SILENCE, 5); await flush();
    expect(caller.of('ready')).toHaveLength(0);
    expect(caller.binary()).toHaveLength(0);
    audio(gateway, SPEECH); await flush();
    expect(caller.of('ready')).toHaveLength(1);
    expect(caller.binary()).toHaveLength(1);
    const index = caller.sent.findIndex(d => typeof d === 'string' && JSON.parse(d).type === 'ready');
    expect(caller.sent[index + 1]).toBeInstanceOf(ArrayBuffer);
    caller.receive({ type: 'hangup' }); await flush();
  });
});

describe('GPT-Live audio', () => {
  it('forwards caller PCM as session.input_audio.append, unchanged', async () => {
    const { gateway, caller } = await call();
    const input = pcm(1234, 960);
    caller.emit('message', { data: input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) }); await flush();
    expect(gateway.of('session.input_audio.append')).toEqual([{ type: 'session.input_audio.append', audio: input.toString('base64') }]);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('plays speech with short pauses, but drops sustained silence from the continuous stream', async () => {
    vi.useFakeTimers();
    const { gateway, caller } = await call();
    audio(gateway, SILENCE, 10); // before anyone speaks
    audio(gateway, SPEECH, 3); audio(gateway, SILENCE, 2); audio(gateway, SPEECH, 2); // a pause inside speech
    audio(gateway, SILENCE, 40); // the agent is listening
    await vi.advanceTimersByTimeAsync(3000);
    const frames = caller.binary();
    const bytes = frames.reduce((n, f) => n + f.byteLength, 0);
    expect(bytes).toBe((3 + 2 + 2 + 3) * 4800); // speech, its pause, and a 300 ms tail
    expect(silentPcm(frames.at(-1)!)).toBe(true);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('admits more than a minute of continuous agent audio across pauses', async () => {
    vi.useFakeTimers();
    const { gateway, caller, rows } = await call();
    for (let second = 0; second < 90; second++) {
      audio(gateway, second % 10 === 9 ? SILENCE : SPEECH, 10);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(caller.of('error')).toHaveLength(0);
    expect(rows()).toHaveLength(0);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('never sends realtime barge-in controls', async () => {
    const { gateway, caller } = await call();
    audio(gateway, SPEECH, 2); said(gateway, 'caller', ' Wait', 400); await flush();
    expect(gateway.messages().map(m => m.type)).not.toEqual(expect.arrayContaining(['response.cancel', 'conversation.item.truncate', 'session.update']));
    expect(caller.of('flush')).toHaveLength(0);
    caller.receive({ type: 'hangup' }); await flush();
  });
});

describe('GPT-Live transcripts', () => {
  it('assembles interleaved deltas into per-speaker turns and persists them', async () => {
    vi.useFakeTimers();
    const { gateway, caller, turns } = await call();
    said(gateway, 'agent', ' Thanks for calling', 200); said(gateway, 'agent', ' Riverside Dental!', 400);
    await vi.advanceTimersByTimeAsync(1500);
    said(gateway, 'caller', ' Hi', 3000); said(gateway, 'caller', ' there. Can', 3200);
    said(gateway, 'agent', ' Mm-hmm', 3400); // backchannel over the caller
    said(gateway, 'caller', ' I book a cleaning?', 3600);
    await vi.advanceTimersByTimeAsync(600);
    said(gateway, 'agent', ' Sure,', 4600); said(gateway, 'agent', ' which day?', 4800);
    await vi.advanceTimersByTimeAsync(1500);
    expect(turns()).toEqual([
      ['agent', 'Thanks for calling Riverside Dental!'],
      ['caller', 'Hi there. Can I book a cleaning?'],
      ['agent', 'Mm-hmm Sure, which day?'],
    ]);
    expect(caller.of('transcript').map(m => m.text)).toEqual(['Hi there. Can I book a cleaning?']);
    expect(caller.of('agent_text').map(m => m.text)).toEqual(['Thanks for calling Riverside Dental!', 'Mm-hmm Sure, which day?']);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('hands open turns over when the call ends', async () => {
    const { gateway, caller, turns } = await call();
    said(gateway, 'caller', ' I need to cancel my', 1000);
    caller.receive({ type: 'hangup' }); await flush(80);
    expect(turns()).toEqual([['caller', 'I need to cancel my']]);
    expect(gateway.of('session.close')).toHaveLength(1);
  });

  it('fails the call on an oversized transcript delta', async () => {
    const { gateway, caller, rows } = await call();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    said(gateway, 'caller', 'x'.repeat(9000), 0); await flush(80);
    expect(caller.of('error')).toHaveLength(1);
    expect(rows().some(w => w.args[0] === 'failed')).toBe(true);
  });

  it('answers typed caller text with an instruction addendum and records it', async () => {
    const { gateway, caller, turns } = await call();
    caller.receive({ type: 'text', text: 'Are you open Friday?' }); await flush();
    expect(gateway.of('session.instructions.append')).toEqual([{ type: 'session.instructions.append', delegation_id: null,
      content: 'The caller typed this message instead of speaking: "Are you open Friday?" Answer it aloud.' }]);
    expect(turns()).toEqual([['caller', 'Are you open Friday?']]);
    caller.receive({ type: 'hangup' }); await flush();
  });
});

describe('GPT-Live closing', () => {
  const functionCall = (name: string, callId = 'call_1') => ({ type: 'response.event', delegation_id: 'item_1', event: {
    type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call', status: 'completed', arguments: '{}', call_id: callId, name } } });

  async function conversation() {
    vi.useFakeTimers();
    const handle = await call();
    const { gateway } = handle;
    said(gateway, 'agent', ' Thanks for calling.', 200); audio(gateway, SPEECH, 5); audio(gateway, SILENCE, 10);
    await vi.advanceTimersByTimeAsync(1500);
    said(gateway, 'caller', ' Can I book a cleaning?', 3000); audio(gateway, SILENCE, 10);
    await vi.advanceTimersByTimeAsync(1500);
    said(gateway, 'agent', ' Booked for Friday.', 5000); audio(gateway, SPEECH, 5); audio(gateway, SILENCE, 10);
    await vi.advanceTimersByTimeAsync(1500);
    return handle;
  }

  it('answers end_call, waits for the goodbye to finish, then hangs up and closes the session', async () => {
    const { gateway, caller, rows } = await conversation();
    said(gateway, 'caller', ' Thanks, that is all.', 8000); audio(gateway, SILENCE, 3);
    said(gateway, 'agent', ' Goodbye!', 8600); audio(gateway, SPEECH, 4);
    gateway.receive(functionCall('end_call')); await flush();
    expect(gateway.of('response.item.create')).toEqual([{ type: 'response.item.create', item: expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }) }]);
    const types = gateway.messages().map(m => m.type);
    expect(types.indexOf('response.create')).toBe(types.indexOf('response.item.create') + 1);
    expect(caller.of('ending')).toHaveLength(0); // still speaking
    audio(gateway, SILENCE, 5); await flush();
    expect(caller.of('ending')).toHaveLength(0);
    audio(gateway, SILENCE, 1); await vi.advanceTimersByTimeAsync(1000);
    expect(caller.of('ending')).toHaveLength(1);
    const played = caller.binary().length;
    audio(gateway, SPEECH, 5); await vi.advanceTimersByTimeAsync(500); // "I'll end the call." after the goodbye
    expect(caller.binary()).toHaveLength(played);
    caller.receive({ type: 'playback_complete', id: caller.of('ending')[0].id }); await flush(80);
    expect(caller.of('ended')).toHaveLength(1);
    expect(gateway.of('session.close')).toHaveLength(1);
    expect(gateway.closed).toBeNull(); // bounded wait for session.closed
    gateway.receive({ type: 'session.closed', usage: { seconds: 12.6 }, reason: 'close_requested' }); await flush();
    expect(gateway.closed).not.toBeNull();
    expect(rows().some(w => w.args[0] === 'completed')).toBe(true);
  });

  it('plays out a queued goodbye but nothing the model says after it', async () => {
    const { gateway, caller } = await conversation();
    const bytes = () => caller.binary().reduce((n, f) => n + f.byteLength, 0);
    const before = bytes();
    gateway.receive(functionCall('end_call'));
    said(gateway, 'agent', ' Goodbye!', 9000); audio(gateway, SPEECH, 10); // generated faster than playback
    audio(gateway, SILENCE, 6); await flush();
    expect(caller.of('ending')).toHaveLength(0); // the goodbye is still queued
    audio(gateway, SPEECH, 5); // "I'll end the call."
    await vi.advanceTimersByTimeAsync(5000);
    expect(caller.of('ending')).toHaveLength(1);
    expect(bytes() - before).toBe((10 + 3) * 4800);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('stops agent audio after a turn-limit hangup has told the caller it is ending', async () => {
    const { gateway, caller } = await conversation();
    for (let i = 0; i < 100 && !caller.of('ending').length; i++) {
      said(gateway, 'caller', ` Question ${i}?`, 10_000 + i * 2000); said(gateway, 'agent', ` Answer ${i}.`, 10_000 + i * 2000);
      await vi.advanceTimersByTimeAsync(1300);
    }
    expect(caller.of('ending')).toHaveLength(1);
    const played = caller.binary().length;
    audio(gateway, SPEECH, 5); await vi.advanceTimersByTimeAsync(1000);
    expect(caller.binary()).toHaveLength(played);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('hangs up after a bounded wait when end_call comes with no spoken goodbye', async () => {
    const { gateway, caller } = await conversation();
    gateway.receive(functionCall('end_call')); audio(gateway, SILENCE, 10); await flush();
    expect(caller.of('ending')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(8000); audio(gateway, SILENCE, 1); await vi.advanceTimersByTimeAsync(500);
    expect(caller.of('ending')).toHaveLength(1);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('does not count a goodbye the caller has since talked over', async () => {
    const { gateway, caller } = await conversation();
    said(gateway, 'agent', ' Okay, goodbye!', 8000); audio(gateway, SPEECH, 4); audio(gateway, SILENCE, 10);
    await vi.advanceTimersByTimeAsync(1300);
    said(gateway, 'caller', ' Wait, one more question.', 11_000); await vi.advanceTimersByTimeAsync(1300);
    gateway.receive(functionCall('end_call')); audio(gateway, SILENCE, 10); await flush();
    expect(caller.of('ending')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(8000); audio(gateway, SILENCE, 1); await vi.advanceTimersByTimeAsync(500);
    expect(caller.of('ending')).toHaveLength(1);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('closes the socket even when session.closed never arrives', async () => {
    const { gateway, caller } = await conversation();
    caller.receive({ type: 'hangup' }); await flush(80);
    expect(gateway.of('session.close')).toHaveLength(1);
    expect(gateway.closed).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(gateway.closed).not.toBeNull();
  });

  it('answers an unknown tool call so the delegation cannot hang, without closing', async () => {
    const { gateway, caller } = await conversation();
    gateway.receive(functionCall('book_table', 'call_x')); gateway.receive(functionCall('book_table', 'call_x')); await flush();
    expect(gateway.of('response.item.create')).toHaveLength(1);
    expect(JSON.parse(gateway.of('response.item.create')[0].item.output)).toEqual({ error: 'Unknown tool.' });
    audio(gateway, SILENCE, 100); await vi.advanceTimersByTimeAsync(10_000);
    expect(caller.of('ending')).toHaveLength(0);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('hangs up after a caller farewell answered with a goodbye, without any delegation', async () => {
    const { gateway, caller } = await conversation();
    said(gateway, 'caller', ' Great, goodbye.', 8000); audio(gateway, SILENCE, 3);
    await vi.advanceTimersByTimeAsync(1300);
    said(gateway, 'agent', ' Bye, have a nice day!', 9500); audio(gateway, SPEECH, 6);
    await vi.advanceTimersByTimeAsync(1300); // the agent turn completes
    expect(caller.of('ending')).toHaveLength(0);
    audio(gateway, SILENCE, 6); await vi.advanceTimersByTimeAsync(1000);
    expect(caller.of('ending')).toHaveLength(1);
    expect(gateway.of('response.item.create')).toHaveLength(0);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('keeps talking when the agent answers a caller farewell with a question', async () => {
    const { gateway, caller } = await conversation();
    said(gateway, 'caller', ' Okay bye.', 8000); await vi.advanceTimersByTimeAsync(1300);
    said(gateway, 'agent', ' Before you go, do you need a reminder?', 9500); audio(gateway, SPEECH, 6);
    await vi.advanceTimersByTimeAsync(1300);
    audio(gateway, SILENCE, 100); await vi.advanceTimersByTimeAsync(12_000);
    expect(caller.of('ending')).toHaveLength(0);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('hangs up once the agent is quiet when a caller farewell gets no reply at all', async () => {
    const { gateway, caller } = await conversation();
    said(gateway, 'caller', ' Goodbye.', 8000); await vi.advanceTimersByTimeAsync(1300);
    audio(gateway, SILENCE, 10); await vi.advanceTimersByTimeAsync(7000);
    expect(caller.of('ending')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000); audio(gateway, SILENCE, 1); await flush();
    expect(caller.of('ending')).toHaveLength(1);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('does not arm the farewell backstop before a real exchange', async () => {
    vi.useFakeTimers();
    const { gateway, caller } = await call();
    said(gateway, 'caller', ' Bye.', 1000); await vi.advanceTimersByTimeAsync(1300);
    audio(gateway, SILENCE, 100); await vi.advanceTimersByTimeAsync(12_000);
    expect(caller.of('ending')).toHaveLength(0);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('fails the call on a provider error after start, without leaking it', async () => {
    const { gateway, caller, rows } = await call();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    gateway.receive({ type: 'error', error: { type: 'server_error', code: 'secret-code', message: 'secret-detail' } });
    audio(gateway, SPEECH); await flush(80);
    expect(caller.of('error')).toHaveLength(1);
    expect(caller.binary()).toHaveLength(0);
    expect(caller.of('ended')).toHaveLength(1);
    const failed = rows().find(w => w.args[0] === 'failed');
    expect(failed).toBeDefined();
    expect(JSON.stringify([caller.messages(), rows(), log.mock.calls])).not.toMatch(/secret-(code|detail)/);
  });
});

describe('GPT-Live recovery', () => {
  it('reconnects once with the conversation so far and without a second greeting', async () => {
    vi.useFakeTimers();
    const { gateway, caller } = await call();
    said(gateway, 'caller', ' My name is Maria.', 1000); await vi.advanceTimersByTimeAsync(1300);
    gateway.close(1006, 'dropped'); await flush(80);
    expect(gateways).toHaveLength(2);
    const replacement = gateways[1];
    const start = replacement.of('session.start')[0];
    expect(start.session.instructions).toContain('Caller: My name is Maria.');
    expect(start.session.instructions).toContain('Do NOT greet again');
    replacement.receive({ type: 'session.started', session: start.session }); await flush();
    expect(replacement.of('session.commentary.append')).toHaveLength(0);
    caller.emit('message', { data: new ArrayBuffer(960) }); await flush();
    expect(replacement.of('session.input_audio.append')).toHaveLength(1);
    expect(caller.of('error')).toHaveLength(0);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('recognises a goodbye in the replacement session despite its restarted clock', async () => {
    vi.useFakeTimers();
    const { gateway, caller } = await call();
    said(gateway, 'caller', ' Can I book a cleaning?', 50_000); await vi.advanceTimersByTimeAsync(1300);
    gateway.close(1006, 'dropped'); await flush(80);
    const replacement = gateways[1];
    replacement.receive({ type: 'session.started', session: replacement.of('session.start')[0].session }); await flush();
    const functionCall = { type: 'response.event', delegation_id: 'item_1', event: { type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'call_1', name: 'end_call', arguments: '{}' } } };
    said(replacement, 'agent', ' Booked. Goodbye!', 1000); audio(replacement, SPEECH, 3);
    replacement.receive(functionCall); audio(replacement, SILENCE, 6); await vi.advanceTimersByTimeAsync(500);
    expect(caller.of('ending')).toHaveLength(1);
    caller.receive({ type: 'hangup' }); await flush();
  });

  it('fails the call when the replacement session cannot start', async () => {
    vi.useFakeTimers();
    const { gateway, caller, rows } = await call();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    gateway.close(1006, 'dropped'); await flush(80);
    await vi.advanceTimersByTimeAsync(5000); await flush(80);
    expect(caller.of('ended')).toHaveLength(1);
    expect(rows().some(w => w.args[0] === 'failed')).toBe(true);
  });
});

describe('GPT-Live voice preview', () => {
  const config: RealtimeConfig = { provider: 'kataleptic', protocol: 'gateway', baseUrl: 'wss://api.kataleptic.com/v1/realtime', apiKey: 'k', model: 'gpt-live-1' };

  it('records the spoken sample up to its trailing silence and closes the session', async () => {
    const promise = gptLivePreview(config, 'cedar', 'Hello there!', new AbortController().signal);
    await flush();
    const ws = gateways[0];
    const start = ws.of('session.start')[0];
    expect(start.session).toEqual({ model: 'gpt-live-1', instructions: expect.any(String),
      audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'cedar' } } });
    ws.receive({ type: 'session.started', session: start.session });
    expect(ws.of('session.commentary.append')[0]).toEqual({ type: 'session.commentary.append', delegation_id: null, content: "Say exactly: 'Hello there!'" });
    audio(ws, SILENCE, 4); audio(ws, SPEECH, 3); audio(ws, SILENCE, 1); audio(ws, SPEECH, 2); audio(ws, SILENCE, 8);
    const wav = await promise;
    expect(new DataView(wav).getUint32(40, true)).toBe((3 + 1 + 2 + 2) * 4800);
    expect(ws.of('session.close')).toHaveLength(1);
    expect(ws.closed).not.toBeNull();
  });

  it('is what generateVoicePreview uses for gpt-live-1, with a GPT-Live voice only', async () => {
    const promise = generateVoicePreview(ENV as unknown as Env, { ...SETTINGS, realtime_voice: 'en-US-AvaMultilingualNeural' } as unknown as AgentSettings, new AbortController().signal);
    const rejected = expect(promise).rejects.toThrow('Voice preview failed');
    await flush();
    expect(upgrades[0].url).toBe('https://api.kataleptic.com/v1/live/sessions');
    expect(gateways[0].of('session.start')[0].session.audio.output).toBeUndefined();
    gateways[0].receive({ type: 'error', error: { code: 'x' } });
    await rejected;
  });

  it('rejects a session that confirms another model', async () => {
    const promise = gptLivePreview(config, '', 'Hi', new AbortController().signal);
    const rejected = expect(promise).rejects.toThrow('Voice preview failed');
    await flush();
    gateways[0].receive({ type: 'session.started', session: { model: 'gpt-realtime-2', audio: { format: { type: 'audio/pcm', rate: 24000 } } } });
    await rejected;
    expect(gateways[0].closed).not.toBeNull();
  });
});

it('builds session.start without a voice when none is chosen', () => {
  const start = gptLiveSessionStart({ instructions: 'i', voice: '', delegationModel: 'm', delegationInstructions: 'd', greeting: null });
  expect(start.session.audio).toEqual({ format: { type: 'audio/pcm', rate: 24000 } });
});
