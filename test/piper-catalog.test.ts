import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

let piperVoiceFor: typeof import('../src/providers').piperVoiceFor;
const env = (endpoint: string) => ({ REALTIME_BASE_URL: endpoint }) as Env;
const catalog = (map: unknown) => Response.json({ 'kataleptic-realtime': { voices_by_language: map } });
beforeEach(async () => {
  vi.resetModules();
  ({ piperVoiceFor } = await import('../src/providers'));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Piper catalog endpoint isolation', () => {
  it('fetches each tenant endpoint and never substitutes the first map', async () => {
    const fetcher = vi.fn(async (url: string) => catalog({ en: url.includes('tenant-a') ? 'en_US-tenant_a-medium' : 'en_US-tenant_b-medium' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await piperVoiceFor(env('wss://tenant-a.example/rt'), 'en')).toBe('en_US-tenant_a-medium');
    expect(await piperVoiceFor(env('wss://tenant-b.example/rt'), 'en')).toBe('en_US-tenant_b-medium');
    expect(await piperVoiceFor(env('wss://tenant-a.example/rt'), 'en')).toBe('en_US-tenant_a-medium');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['reject', 'http', 'invalid-json', 'invalid-map'])('uses static fallback when a second endpoint fails: %s', async failure => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('tenant-a')) return catalog({ en: 'en_US-attacker-medium' });
      if (failure === 'reject') throw new Error('provider failure');
      if (failure === 'http') return new Response('unavailable', { status: 503 });
      if (failure === 'invalid-json') return new Response('{');
      return catalog(['not', 'a', 'map']);
    }));
    await piperVoiceFor(env('wss://tenant-a.example/rt'), 'en');
    expect(await piperVoiceFor(env('wss://tenant-b.example/rt'), 'en')).toBe('en_US-lessac-medium');
  });
  it('shares equivalent endpoint spellings but preserves distinct paths and query routing', async () => {
    const fetcher = vi.fn(async () => catalog({ en: 'en_US-test-medium' }));
    vi.stubGlobal('fetch', fetcher);
    for (const url of ['wss://VOICE.example:443/rt/', 'wss://voice.example/rt', 'wss://voice.example/other', 'wss://voice.example/rt?route=b']) await piperVoiceFor(env(url), 'en');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(args => args[0])).toEqual(['https://voice.example/rt/voices', 'https://voice.example/other/voices', 'https://voice.example/rt/voices?route=b']);
  });
});

describe('Piper catalog input and memory bounds', () => {
  it('rejects oversized or credential-bearing endpoint identities without fetching', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const url of ['wss://voice.example/' + 'x'.repeat(4096), 'wss://user:pass@voice.example/rt', 'wss://voice.example/rt#fragment']) {
      expect(await piperVoiceFor(env(url), 'en')).toBe('en_US-lessac-medium');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('accepts only bounded identifier strings and language keys', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog({
      en: { voice: 'object' }, de: 'de_DE-valid-medium', fr: 'say these words',
      es: 'x'.repeat(129), nl: 42, sv: 'https://example.test/voice', da: '',
      '__proto__': { polluted: true }, english: 'en_US-wrong-key',
    })));
    const endpoint = env('wss://voice.example/rt');
    expect(await piperVoiceFor(endpoint, 'en')).toBe('en_US-lessac-medium');
    expect(await piperVoiceFor(endpoint, 'de')).toBe('de_DE-valid-medium');
    expect(await piperVoiceFor(endpoint, 'fr')).toBe('fr_FR-siwis-medium');
    expect(await piperVoiceFor(endpoint, 'es')).toBe('es_ES-sharvard-medium');
    expect(await piperVoiceFor(endpoint, 'nl')).toBe('nl_NL-mls-medium');
    expect(await piperVoiceFor(endpoint, 'sv')).toBe('sv_SE-nst-medium');
    expect(await piperVoiceFor(endpoint, 'da')).toBe('da_DK-talesyntese-medium');
  });
  it.each(['body', 'content-length', 'entries', 'redirect'])('rejects excessive or redirected catalog: %s', async kind => {
    const fetcher = vi.fn(async () => {
      if (kind === 'body') return new Response(' '.repeat(65_537));
      if (kind === 'content-length') return new Response('{}', { headers: { 'Content-Length': '65537' } });
      if (kind === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://other.example/voices' } });
      return catalog(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), 'en_US-test-medium'])));
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await piperVoiceFor(env('wss://voice.example/rt'), 'en')).toBe('en_US-lessac-medium');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    fetcher.mockImplementation(async () => catalog({ en: 'en_US-recovered-medium' }));
    expect(await piperVoiceFor(env('wss://voice.example/rt'), 'en')).toBe('en_US-recovered-medium');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('expires only the matching endpoint and falls back when its refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetcher = vi.fn(async () => catalog({ en: 'en_US-old-medium' }));
    vi.stubGlobal('fetch', fetcher);
    const first = env('wss://first.example/rt');
    const second = env('wss://second.example/rt');
    await piperVoiceFor(first, 'en');
    vi.setSystemTime(Date.now() + 1_800_000);
    await piperVoiceFor(second, 'en');
    vi.setSystemTime(Date.now() + 1_800_001);
    fetcher.mockRejectedValue(new Error('offline'));
    expect(await piperVoiceFor(first, 'en')).toBe('en_US-lessac-medium');
    expect(await piperVoiceFor(second, 'en')).toBe('en_US-old-medium');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('bounds cached endpoints and evicts the least recently used entry', async () => {
    const fetcher = vi.fn(async () => catalog({ en: 'en_US-cached-medium' }));
    vi.stubGlobal('fetch', fetcher);
    for (let i = 0; i < 32; i++) await piperVoiceFor(env(`wss://tenant-${i}.example/rt`), 'en');
    await piperVoiceFor(env('wss://tenant-0.example/rt'), 'en');
    await piperVoiceFor(env('wss://tenant-32.example/rt'), 'en');
    await piperVoiceFor(env('wss://tenant-0.example/rt'), 'en');
    expect(fetcher).toHaveBeenCalledTimes(33);
    await piperVoiceFor(env('wss://tenant-1.example/rt'), 'en');
    expect(fetcher).toHaveBeenCalledTimes(34);
  });
});
