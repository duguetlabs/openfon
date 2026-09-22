import { describe, expect, it } from 'vitest';
import { liveRealtimeVoice, realtimeCapabilities, realtimeConnection, resolveRealtime, OPENAI_REALTIME_URL } from '../src/realtime-providers';
import type { AgentSettings, Env } from '../src/types';
const env = { REALTIME_BASE_URL: 'wss://gateway.example/v1/realtime', REALTIME_MODEL: 'kataleptic-realtime-hd', DEFAULT_LLM_API_KEY: 'operator-key' } as Env;
const settings = (extra: object) => ({ realtime_model: '', ...extra }) as AgentSettings;

describe('explicit realtime providers', () => {
  it('[gateway-header-negative] preserves instance gateway authentication and capabilities', () => {
    const cfg = resolveRealtime(env, null);
    expect(realtimeConnection(cfg)).toEqual({ url: 'https://gateway.example/v1/realtime?model=kataleptic-realtime-hd', headers: { Upgrade: 'websocket', Authorization: 'Bearer operator-key' } });
    expect(realtimeCapabilities(cfg)).toMatchObject({ engineGreeting: false, managedVoice: true });
  });
  it.each(['ws', 'wss'])('[gateway-header-negative] removes every credential alias while preserving %s routing', scheme => {
    const cfg = resolveRealtime({ ...env, REALTIME_BASE_URL: `${scheme}://gateway.example/api/v1/realtime?token=old-a&route=east&api_key=old-b&token=old-c&api_key=old-d&model=old` }, null);
    const connection = realtimeConnection(cfg);
    expect(connection.headers?.Authorization).toBe('Bearer operator-key');
    const url = new URL(connection.url);
    expect(url.protocol).toBe(scheme === 'wss' ? 'https:' : 'http:');
    expect(url.host).toBe('gateway.example');
    expect(url.pathname).toBe('/api/v1/realtime');
    expect([...url.searchParams.entries()]).toEqual([['route', 'east'], ['model', 'kataleptic-realtime-hd']]);
    expect(cfg.protocol).toBe('gateway');
  });
  it('[gateway-header-negative] uses only the explicit gateway workspace key', () => {
    const cfg = resolveRealtime({ ...env, REALTIME_API_KEY: 'instance-realtime' }, settings({ realtime_provider: 'kataleptic', realtime_base_url: 'wss://workspace.example/v1/realtime', realtime_api_key: 'workspace-gateway', realtime_model: 'gpt-realtime-2' }));
    expect(realtimeConnection(cfg)).toEqual({ url: 'https://workspace.example/v1/realtime?model=gpt-realtime-2', headers: { Upgrade: 'websocket', Authorization: 'Bearer workspace-gateway' } });
    expect(cfg.protocol).toBe('gateway');
    expect(realtimeCapabilities(cfg)).toEqual({ engineGreeting: true, managedVoice: false, transcriptionModel: 'whisper-1' });
  });
  it('[gateway-header-negative] prefers the instance realtime key to the legacy text fallback', () => {
    const cfg = resolveRealtime({ ...env, REALTIME_API_KEY: 'instance-realtime' }, null);
    expect(realtimeConnection(cfg).headers?.Authorization).toBe('Bearer instance-realtime');
    expect(new URL(realtimeConnection(cfg).url).searchParams.has('token')).toBe(false);
  });
  it('does not invent an instance gateway credential when both keys are absent', () => {
    const cfg = resolveRealtime({ ...env, DEFAULT_LLM_API_KEY: '', REALTIME_API_KEY: '' }, null);
    expect(cfg.apiKey).toBe('');
    expect(realtimeConnection(cfg).headers?.Authorization).toBe('Bearer ');
  });
  it('uses OpenAI Authorization without gateway credentials, catalogs or synthesis', () => {
    const cfg = resolveRealtime(env, settings({ realtime_provider: 'openai', realtime_api_key: 'workspace-key' }));
    expect(cfg.model).toBe('gpt-realtime');
    expect(realtimeConnection(cfg)).toEqual({ url: 'https://api.openai.com/v1/realtime?model=gpt-realtime', headers: { Upgrade: 'websocket', Authorization: 'Bearer workspace-key' } });
    expect(realtimeCapabilities(cfg)).toEqual({ engineGreeting: true, managedVoice: false, transcriptionModel: 'whisper-1' });
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

describe('retired Kataleptic cascade', () => {
  it.each(['kataleptic-realtime', 'llama-3.3-70b', 'mistral-nemo-12b'])('serves a stored %s selection on the HD tier', model => {
    for (const selection of [settings({ realtime_model: model }), settings({ realtime_provider: 'kataleptic', realtime_api_key: 'k', realtime_model: model })]) {
      const cfg = resolveRealtime(env, selection);
      expect(cfg).toMatchObject({ model: 'kataleptic-realtime-hd', retiredModel: model });
      expect(new URL(realtimeConnection(cfg).url).searchParams.get('model')).toBe('kataleptic-realtime-hd');
    }
  });
  it('serves a retired instance default on the HD tier and keeps live tiers', () => {
    expect(resolveRealtime({ ...env, REALTIME_MODEL: 'llama-3.3-70b' }, null).model).toBe('kataleptic-realtime-hd');
    expect(resolveRealtime({ ...env, REALTIME_MODEL: 'gpt-realtime-2.1-mini' }, null)).not.toHaveProperty('retiredModel');
    expect(resolveRealtime({ ...env, REALTIME_MODEL: 'gpt-4o-realtime-preview' }, null).model).toBe('kataleptic-realtime-hd');
    expect(resolveRealtime(env, settings({ realtime_provider: 'kataleptic', realtime_api_key: 'k' })).model).toBe('kataleptic-realtime-hd');
  });
  it('leaves custom providers in their own model namespace', () => {
    const cfg = resolveRealtime(env, settings({ realtime_provider: 'custom', realtime_base_url: 'wss://rt.example/v1/realtime', realtime_api_key: 'k', realtime_model: 'kataleptic-realtime' }));
    expect(cfg.model).toBe('kataleptic-realtime');
  });
});

describe('retired Piper voices', () => {
  const custom = resolveRealtime(env, settings({ realtime_provider: 'custom', realtime_base_url: 'wss://rt.example/v1/realtime', realtime_api_key: 'k' }));
  it('drops a Piper id on the gateway and keeps every other voice', () => {
    const hd = resolveRealtime(env, null);
    expect(liveRealtimeVoice(hd, 'de_DE-thorsten-medium')).toBe('');
    expect(liveRealtimeVoice(hd, 'de-DE-SeraphinaMultilingualNeural')).toBe('de-DE-SeraphinaMultilingualNeural');
    expect(liveRealtimeVoice(resolveRealtime(env, settings({ realtime_model: 'gpt-realtime-2.1' })), 'marin')).toBe('marin');
    // A voice chosen for a retired tier goes with it, whatever its form.
    expect(liveRealtimeVoice(resolveRealtime(env, settings({ realtime_model: 'kataleptic-realtime' })), 'marin')).toBe('');
  });
  it('leaves custom providers their own voice namespace', () => {
    expect(liveRealtimeVoice(custom, 'de_DE-thorsten-medium')).toBe('de_DE-thorsten-medium');
  });
});
