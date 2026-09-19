import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { synthesize, speechConfig, speechVoice } from '../src/providers';
import { providerUpdate } from '../src/provider-settings';
import type { AgentSettings, Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

let db: SqliteD1;
const env = { DEFAULT_TTS_PROVIDER: 'azure', AZURE_SPEECH_KEY: 'operator-only', AZURE_SPEECH_REGION: 'westeurope', DEFAULT_TTS_VOICE: 'en-US-AvaMultilingualNeural', DEFAULT_LLM_BASE_URL: 'https://text.example/v1', DEFAULT_LLM_API_KEY: 'text-only', DEFAULT_LLM_MODEL: 'text', DEFAULT_STT_BASE_URL: 'https://stt.example/v1', DEFAULT_STT_MODEL: 'stt' } as Env;
const speech = { tts_provider: 'custom', tts_base_url: 'https://speech.example/v1', tts_api_key: 'speech-only', tts_model: 'custom-tts' };
const request = (body?: unknown, path = '/api/me/provider', token = 's1') => worker.fetch(new Request(`https://openfon.test${path}`, {
  method: body === undefined ? 'GET' : 'PUT', headers: { Cookie: `ofs=${token}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), { ...env, DB: db as unknown as D1Database }, { waitUntil() {} } as ExecutionContext);
beforeEach(() => {
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('u1','one@example.test','h'),('u2','two@example.test','h');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('s1','u1','2099-01-01'),('s2','u2','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('b1','u1','one','One'),('b2','u2','two','Two');
    INSERT INTO agent_settings(business_id) VALUES('b1'),('b2');
    INSERT INTO provider_settings(business_id) VALUES('b1'),('b2');`);
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('upgrades populated 0021 without changing existing keys or routing', () => {
  const old = new SqliteD1();
  try {
    applyMigrations(old, 1, 21);
    old.exec(`INSERT INTO users(id,email,password_hash) VALUES('u','x@example.test','h'); INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','B');
      INSERT INTO provider_settings(business_id,llm_api_key,stt_api_key,realtime_api_key) VALUES('b','text','stt','rt');`);
    const before = old.database.prepare('SELECT * FROM provider_settings').get();
    applyMigrations(old, 22, 22);
    expect(old.database.prepare('SELECT * FROM provider_settings').get()).toEqual({ ...before, tts_provider: 'instance', tts_base_url: '', tts_api_key: '', tts_model: '' });
  } finally { old.close(); }
});
it('persists independent keys, retains on partial edits, and excludes speech secrets/URLs from export', async () => {
  expect((await request({ ...speech, apiKey: 'text-private', stt_provider: 'openai', stt_base_url: 'https://api.openai.com/v1', stt_model: 'whisper-1', stt_api_key: 'stt-private' })).status).toBe(200);
  expect((await request({ model: 'next-text' })).status).toBe(200);
  expect(db.database.prepare("SELECT llm_api_key,stt_api_key,tts_api_key FROM provider_settings WHERE business_id='b1'").get()).toEqual({ llm_api_key: 'text-private', stt_api_key: 'stt-private', tts_api_key: 'speech-only' });
  const view = await (await request()).text();
  expect(view).toContain('"tts_api_key_configured":true');
  for (const key of ['text-private','stt-private','speech-only','operator-only']) expect(view).not.toContain(key);
  const other = await (await request(undefined, '/api/me/provider', 's2')).json();
  expect(other).toMatchObject({ tts_provider: 'instance', tts_base_url: '' });
  const exported = await request(undefined, '/api/me/account/export'); expect(exported.status).toBe(200);
  const text = await exported.text();
  for (const hidden of ['speech-only','speech.example','text-private','stt-private']) expect(text).not.toContain(hidden);
  expect((await request(speech, '/api/me/provider', '')).status).toBe(401);
});
it.each([
  { ...speech, tts_api_key: '' }, { ...speech, tts_model: '' }, { ...speech, tts_provider: 'invalid' },
  { ...speech, tts_base_url: 'https://127.0.0.1/v1' }, { ...speech, tts_base_url: 'https://u:p@speech.example/v1' },
  { ...speech, tts_base_url: 'https://speech.example/v1?token=x' }, { ...speech, tts_provider: 'openai' },
  { ...speech, tts_provider: 'azure' }, { tts_provider: 'browser', tts_api_key: 'unused' }, { tts_api_key: 7 },
])('rejects invalid/incomplete synthesis configuration without borrowing other keys: %j', async body => {
  expect((await request(body)).status).toBe(400);
  expect(db.database.prepare("SELECT tts_api_key FROM provider_settings WHERE business_id='b1'").get()).toEqual({ tts_api_key: '' });
});
it('binds keys to synthesis provider and endpoint and clears them in browser/instance mode', () => {
  const current = providerUpdate(env, null, speech);
  expect(() => providerUpdate(env, current, { tts_base_url: 'https://other.example/v1' })).toThrow('Endpoint changed');
  expect(() => providerUpdate(env, current, { tts_provider: 'openai', tts_base_url: 'https://api.openai.com/v1' })).toThrow('Endpoint changed');
  for (const tts_provider of ['browser','instance']) {
    const cleared = providerUpdate(env, current, { tts_provider });
    expect(cleared).toMatchObject({ tts_api_key: '', tts_base_url: '', tts_model: '' });
    expect(() => providerUpdate(env, cleared, { ...speech, tts_api_key: '' })).toThrow('own API key');
  }
});
it('uses only the speech key and provider model/voice for OpenAI-compatible audio', async () => {
  const fetcher = vi.fn(async () => new Response(new Uint8Array([1,2,3,4]))); vi.stubGlobal('fetch', fetcher);
  expect(new Uint8Array((await synthesize(env, 'Hallo', 'coral', 'mp3', speech))!)).toEqual(new Uint8Array([1,2,3,4]));
  expect(fetcher).toHaveBeenCalledWith('https://speech.example/v1/audio/speech', expect.objectContaining({ redirect: 'manual', headers: { Authorization: 'Bearer speech-only', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'custom-tts', input: 'Hallo', voice: 'coral', response_format: 'mp3' }) }));
  expect(speechVoice(env, 'de', { ...speech, voice: '', language: 'en' } as AgentSettings)).toBe('alloy');
  expect(() => speechConfig(env, { ...speech, tts_api_key: '' })).toThrow('own API key');
});
it('uses separate regional Azure auth and escapes the complete SSML', async () => {
  const fetcher = vi.fn(async () => new Response(new Uint8Array([1,2]))); vi.stubGlobal('fetch', fetcher);
  await synthesize(env, '<hello>', "de-DE-X'", 'pcm24', { ...speech, tts_provider: 'azure', tts_base_url: 'https://westeurope.tts.speech.microsoft.com' });
  expect(fetcher.mock.calls[0]).toEqual(['https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1', expect.objectContaining({ headers: expect.objectContaining({ 'Ocp-Apim-Subscription-Key': 'speech-only', 'X-Microsoft-OutputFormat': 'raw-24khz-16bit-mono-pcm' }), body: expect.stringContaining("de-DE-X&apos;") })]);
  expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body).toContain('&lt;hello&gt;');
});
it('browser selection makes no request even when the operator has Azure enabled', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  expect(await synthesize(env, 'Hi', '', 'mp3', { tts_provider: 'browser' })).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
});
it.each([0, 3, 2880002])('rejects empty, odd PCM or oversized audio (%i bytes)', async size => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(size))));
  await expect(synthesize(env, 'Hi', 'alloy', 'pcm24', speech)).rejects.toThrow();
});
it('does not read reflected error bodies or follow redirects', async () => {
  const pull = vi.fn(); const cancel = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { status: 302, headers: { location: 'https://elsewhere.example' } })));
  await expect(synthesize(env, 'Hi', '', 'mp3', speech)).rejects.toThrow('Speech synthesis failed');
  expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalled();
});
it.each(['deadline','abort'])('settles %s even when body cancellation never resolves', async kind => {
  vi.useFakeTimers(); const cancel = vi.fn(() => new Promise<void>(() => {}));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}), cancel }))));
  const control = new AbortController(); const pending = synthesize(env, 'Hi', '', 'mp3', speech, control.signal);
  const result = expect(pending).rejects.toThrow('Provider response');
  await vi.advanceTimersByTimeAsync(1);
  if (kind === 'abort') control.abort(); else await vi.advanceTimersByTimeAsync(30000);
  await result; expect(cancel).toHaveBeenCalled();
});
