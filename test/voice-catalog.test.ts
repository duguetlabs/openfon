import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

let db: SqliteD1;
let env: Env;
let sequence = 0;
const azure = [{ ShortName: 'en-US-AvaNeural', LocaleName: 'English (United States)' }];
const azureOptions = [{ id: 'en-US-AvaNeural', label: 'en-US-AvaNeural — English (United States)' }];
const gateway = { 'kataleptic-realtime': { voices_by_language: { en: 'piper-en' } },
  'gpt-realtime-2': { voices: ['gateway-voice'] }, 'kataleptic-realtime-hd': { default: 'hd-voice' } };

beforeEach(() => {
  db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES ('u','catalog@example.test','hash');
    INSERT INTO sessions(token,user_id,expires_at) VALUES ('s','u','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name) VALUES ('b','u','catalog','Catalog');
    INSERT INTO agent_settings(business_id,engine) VALUES ('b','pipeline');
    INSERT INTO provider_settings(business_id) VALUES ('b');`);
  env = { DB: db, DEFAULT_TTS_PROVIDER: 'azure', AZURE_SPEECH_KEY: `synthetic-azure-${++sequence}`,
    AZURE_SPEECH_REGION: 'westeurope', REALTIME_BASE_URL: `wss://instance-${sequence}.example/realtime`,
    REALTIME_PROVIDER: 'kataleptic' } as unknown as Env;
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function select(mode: string) {
  db.database.prepare('UPDATE provider_settings SET realtime_provider=?,realtime_base_url=?,realtime_api_key=?')
    .run(mode, 'wss://workspace.example/realtime', 'synthetic-workspace-key');
}
async function catalog() {
  const response = await worker.fetch(new Request('https://openfon.test/api/me/voices', { headers: { Cookie: 'ofs=s' } }),
    env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
  expect(response.status).toBe(200);
  return await response.json() as { azure: unknown[]; cascade: unknown[]; native: unknown[]; hdDefault: string };
}
function mockCatalogs() {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('speech.microsoft.com') ? azure : gateway)));
  vi.stubGlobal('fetch', fetch); return fetch;
}

it.each(['openai', 'custom', 'kataleptic'])('keeps pipeline Azure suggestions for explicit %s without contacting realtime endpoints', async mode => {
  select(mode); const fetch = mockCatalogs();
  const result = await catalog();
  expect(result.azure).toEqual(azureOptions);
  expect(result.cascade).toEqual([]); expect(result.hdDefault).toBe('');
  expect(result.native).toEqual(mode === 'openai' ? expect.arrayContaining([{ id: 'marin', label: 'marin' }]) : []);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith('https://westeurope.tts.speech.microsoft.com/cognitiveservices/voices/list', expect.objectContaining({
    headers: { 'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY }, redirect: 'manual', signal: expect.any(AbortSignal),
  }));
});
it.each(['openai', 'custom'])('supports inherited %s and makes no requests without an Azure key', async mode => {
  env.REALTIME_PROVIDER = mode as Env['REALTIME_PROVIDER'];
  const fetch = mockCatalogs();
  expect((await catalog()).azure).toEqual(azureOptions);
  expect(fetch).toHaveBeenCalledTimes(1);
  env.AZURE_SPEECH_KEY = ''; fetch.mockClear();
  expect((await catalog()).azure).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
it('reuses Azure across workspace choices without leaking cached gateway voices into direct/custom', async () => {
  const fetch = mockCatalogs();
  expect(await catalog()).toMatchObject({ azure: azureOptions, cascade: [{ id: 'piper-en', label: 'piper-en (en)' }], native: [{ id: 'gateway-voice', label: 'gateway-voice' }] });
  expect(fetch).toHaveBeenCalledTimes(2);
  select('openai'); const direct = await catalog();
  expect(direct.azure).toEqual(azureOptions); expect(direct.cascade).toEqual([]);
  expect(direct.native).not.toContainEqual({ id: 'gateway-voice', label: 'gateway-voice' });
  select('custom'); expect(await catalog()).toEqual({ azure: azureOptions, native: [], cascade: [], hdDefault: '' });
  select('instance'); expect((await catalog()).native).toEqual([{ id: 'gateway-voice', label: 'gateway-voice' }]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][0]).toBe(env.REALTIME_BASE_URL.replace(/^ws/, 'http') + '/voices');
});
it('does not reuse Azure catalog after region/key changes and expires each cache', async () => {
  select('openai'); const fetch = mockCatalogs();
  await catalog(); env.AZURE_SPEECH_REGION = 'eastus'; await catalog();
  env.AZURE_SPEECH_KEY = 'synthetic-rotated'; await catalog();
  expect(fetch).toHaveBeenCalledTimes(3);
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 3_600_001); await catalog();
  expect(fetch).toHaveBeenCalledTimes(4);
});
it('does not reuse the gateway catalog for a changed instance endpoint', async () => {
  const fetch = mockCatalogs(); await catalog();
  env.REALTIME_BASE_URL = 'wss://second-instance.example/realtime'; await catalog();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls[2][0]).toBe('https://second-instance.example/realtime/voices');
});
it('retains direct suggestions on Azure failure and retries instead of caching failure', async () => {
  select('openai'); const fetch = vi.fn().mockRejectedValueOnce(new Error('synthetic unavailable'))
    .mockResolvedValueOnce(new Response(JSON.stringify(azure))); vi.stubGlobal('fetch', fetch);
  const failed = await catalog(); expect(failed.azure).toEqual([]);
  expect(failed.native).toContainEqual({ id: 'marin', label: 'marin' });
  expect((await catalog()).azure).toEqual(azureOptions); expect(fetch).toHaveBeenCalledTimes(2);
});
it('keeps Azure on gateway failure and never follows an Azure redirect', async () => {
  const fetch = vi.fn(async (url: string) => url.includes('speech.microsoft.com') ? new Response(JSON.stringify(azure)) : new Response('', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  expect(await catalog()).toMatchObject({ azure: azureOptions, cascade: [], native: [] });
  select('openai'); env.AZURE_SPEECH_KEY = 'synthetic-other';
  fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: 'https://unrelated.example' } }));
  expect((await catalog()).azure).toEqual([]); expect(fetch).toHaveBeenCalledTimes(3);
});
