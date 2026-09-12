import { describe, expect, it } from 'vitest';
import { realtimeCapabilities, realtimeConnection, resolveRealtime, OPENAI_REALTIME_URL } from '../src/realtime-providers';
import type { AgentSettings, Env } from '../src/types';
const env = { REALTIME_BASE_URL: 'wss://gateway.example/v1/realtime', REALTIME_MODEL: 'kataleptic-realtime-hd', DEFAULT_LLM_API_KEY: 'operator-key' } as Env;
const settings = (extra: object) => ({ realtime_model: '', ...extra }) as AgentSettings;

describe('explicit realtime providers', () => {
  it('preserves instance gateway authentication and capabilities', () => {
    const cfg = resolveRealtime(env, null);
    expect(realtimeConnection(cfg)).toEqual({ url: 'wss://gateway.example/v1/realtime?model=kataleptic-realtime-hd&token=operator-key' });
    expect(realtimeCapabilities(cfg)).toMatchObject({ engineGreeting: false, managedVoice: true, cascade: false });
  });
  it('uses OpenAI Authorization without gateway credentials, catalogs or synthesis', () => {
    const cfg = resolveRealtime(env, settings({ realtime_provider: 'openai', realtime_api_key: 'workspace-key' }));
    expect(cfg.model).toBe('gpt-realtime');
    expect(realtimeConnection(cfg)).toEqual({ url: 'https://api.openai.com/v1/realtime?model=gpt-realtime', headers: { Upgrade: 'websocket', Authorization: 'Bearer workspace-key' } });
    expect(realtimeCapabilities(cfg)).toEqual({ engineGreeting: true, managedVoice: false, cascade: false, transcriptionModel: 'whisper-1' });
  });
  it.each(['openai', 'kataleptic', 'custom'])('does not lend the instance key to explicit %s', realtime_provider => {
    expect(() => resolveRealtime(env, settings({ realtime_provider, realtime_base_url: 'wss://gateway.example/v1/realtime' }))).toThrow();
  });
  it.each(['wss://evil.example/v1/realtime', OPENAI_REALTIME_URL + '?target=evil', 'wss://api.openai.com./v1/realtime', 'wss://user:pass@api.openai.com/v1/realtime'])('pins direct OpenAI destination %s', realtime_base_url => {
    expect(() => resolveRealtime(env, settings({ realtime_provider: 'openai', realtime_api_key: 'test', realtime_base_url }))).toThrow();
  });
  it.each(['ws://public.example/rt', 'wss://127.0.0.1/rt', 'wss://[::1]/rt', 'wss://localhost./rt', 'https://public.example/rt', 'wss://public.example/rt?token=x'])('rejects unsafe workspace destination %s', realtime_base_url => {
    expect(() => resolveRealtime(env, settings({ realtime_provider: 'custom', realtime_api_key: 'test', realtime_base_url }))).toThrow();
  });
  it('supports explicit experimental GA endpoints with their own credentials', () => {
    const cfg = resolveRealtime(env, settings({ realtime_provider: 'custom', realtime_api_key: 'custom-key', realtime_base_url: 'wss://voice.example/realtime', realtime_model: 'native-model' }));
    expect(realtimeConnection(cfg).headers?.Authorization).toBe('Bearer custom-key');
    expect(realtimeCapabilities(cfg).engineGreeting).toBe(true);
  });
  it('does not use default text credentials for an OpenAI instance', () => {
    expect(() => resolveRealtime({ ...env, REALTIME_PROVIDER: 'openai', REALTIME_BASE_URL: OPENAI_REALTIME_URL }, null)).toThrow('realtime API key');
  });
  it('rejects a gateway-only model on OpenAI', () => {
    expect(() => resolveRealtime(env, settings({ realtime_provider: 'openai', realtime_api_key: 'test', realtime_model: 'kataleptic-realtime-hd' }))).toThrow('OpenAI realtime model');
  });
});
