import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { generateVoicePreview } from '../src/voice-preview';
import { SqliteD1, applyMigrations } from './sqlite-d1';
import type { Env } from '../src/types';
vi.mock('../src/voice-preview', async original => ({ ...await original<object>(), generateVoicePreview: vi.fn().mockResolvedValue(new ArrayBuffer(48)) }));
let db: SqliteD1; let env: Env;
const draft = { engine: 'realtime', language: 'de', voice: '', realtime_model: 'gpt-realtime-2.1-mini', realtime_voice: 'cedar' };
function request(body: unknown = draft, token = 's1', id = 'a1') {
  return worker.fetch(new Request(`https://openfon.test/api/me/assistants/${id}/voice-preview`, {
    method: 'POST', headers: { Cookie: `ofs=${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}
beforeEach(() => {
  vi.mocked(generateVoicePreview).mockClear(); db = new SqliteD1(); applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES ('u1','one@example.test','h'),('u2','two@example.test','h');
    INSERT INTO sessions(token,user_id,expires_at) VALUES ('s1','u1','2099-01-01'),('s2','u2','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name) VALUES ('b1','u1','one','One');
    INSERT INTO assistants(id,business_id,public_slug,name) VALUES ('a1','b1','one','Alex');
    INSERT INTO provider_settings(business_id,realtime_provider,realtime_api_key,tts_provider,tts_base_url,tts_api_key,tts_model)
      VALUES ('b1','kataleptic','workspace-private','openai','https://api.openai.com/v1','speech-private','tts-1');`);
  env = { DB: db, REALTIME_BASE_URL: 'wss://api.kataleptic.com/v1/realtime', REALTIME_MODEL: 'kataleptic-realtime-hd', DEFAULT_LLM_API_KEY: 'instance-private' } as unknown as Env;
});
afterEach(() => db.close());
it('previews the unsaved selection with owned credentials without mutating assistant or creating calls', async () => {
  const before = db.database.prepare('SELECT * FROM assistants').get();
  const response = await request(); expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('audio/wav'); expect(response.headers.get('cache-control')).toContain('no-store');
  expect(generateVoicePreview).toHaveBeenCalledWith(env, expect.objectContaining({ ...draft, realtime_api_key: 'workspace-private', tts_api_key: 'speech-private' }), expect.any(AbortSignal));
  expect(db.database.prepare('SELECT * FROM assistants').get()).toEqual(before);
  expect(db.database.prepare('SELECT COUNT(*) AS n FROM calls').get()).toEqual({ n: 0 });
});
it('uses separate saved Pipeline credentials', async () => {
  expect((await request({ ...draft, engine: 'pipeline', voice: 'nova' })).status).toBe(200);
  expect(generateVoicePreview).toHaveBeenCalledWith(env, expect.objectContaining({ engine: 'pipeline', voice: 'nova', tts_model: 'tts-1', tts_api_key: 'speech-private' }), expect.any(AbortSignal));
});
it('requires authentication and assistant ownership', async () => {
  expect((await request(draft, '')).status).toBe(401);
  expect((await request(draft, 's2')).status).toBe(404);
  expect((await request(draft, 's1', 'missing')).status).toBe(404);
  expect(generateVoicePreview).not.toHaveBeenCalled();
});
it.each([{ realtime_api_key: 'attack' }, { realtime_base_url: 'https://evil.test' }, { text: 'arbitrary paid prompt' }, { voice: 'x'.repeat(201) }, { language: '__proto__' }, { engine: 'invalid' }, { realtime_voice: {} }])('rejects invalid/extra input before spend: %j', async patch => {
  expect((await request({ ...draft, ...patch })).status).toBe(400); expect(generateVoicePreview).not.toHaveBeenCalled();
  expect(db.database.prepare('SELECT COUNT(*) AS n FROM rate_counters WHERE bucket LIKE \'studio:%\'').get()).toEqual({ n: 0 });
});
it.each(['minute', 'voice-preview-day', 'ip-minute', 'ip-day'])('enforces shared %s spending limits without upstream work', async suffix => {
  const window = suffix.includes('day') ? 86400 : 60;
  const subject = suffix.startsWith('ip-') ? 'local' : 'b1';
  db.database.prepare('INSERT INTO rate_counters(bucket,window_start,count) VALUES(?,?,999)').run(`studio:${suffix}:${subject}`, Math.floor(Date.now()/1000/window)*window);
  expect((await request()).status).toBe(429); expect(generateVoicePreview).not.toHaveBeenCalled();
  expect(db.database.prepare("SELECT COUNT(*) AS n FROM rate_counters WHERE bucket LIKE 'studio:%'").get()).toEqual({ n: 1 });
});
it('returns a safe error and retains spent allowance after provider failure', async () => {
  vi.mocked(generateVoicePreview).mockRejectedValueOnce(new Error('private provider detail'));
  const response = await request(); expect(response.status).toBe(502); expect(await response.text()).not.toContain('private');
  expect(db.database.prepare("SELECT count FROM rate_counters WHERE bucket='studio:voice-preview-day:b1'").get()).toEqual({ count: 1 });
});
it('invalid saved provider configuration is rejected before reserving paid allowance', async () => {
  db.exec("UPDATE provider_settings SET realtime_provider='custom',realtime_base_url='https://invalid.test'");
  expect((await request()).status).toBe(400); expect(generateVoicePreview).not.toHaveBeenCalled();
  expect(db.database.prepare("SELECT COUNT(*) AS n FROM rate_counters WHERE bucket LIKE 'studio:%'").get()).toEqual({ n: 0 });
});
