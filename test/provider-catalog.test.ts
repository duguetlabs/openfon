import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('filters protocol-incompatible streaming STT, aliases, and untrusted identifiers; shares cached requests without credentials', async () => {
  vi.resetModules();
  const { providerCatalog } = await import('../src/provider-catalog');
  const model = (id: string, input: string[], output: string[]) => ({ id, architecture: { input_modalities: input, output_modalities: output } });
  const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith('/models') ? { data: [
    model('chat-one', ['text'], ['text']), model('alias/chat-one', ['text'], ['text']), model('gpt-realtime-2', ['audio'], ['audio']),
    model('whisper', ['audio'], ['text']), model('whisper-stream', ['audio'], ['text']), model('<script>', ['text'], ['text']),
    model('kataleptic-realtime', ['audio'], ['audio']), model('whisper-large-v3-turbo', ['audio'], ['text']), model('mistral-nemo-12b', ['text'], ['text']),
  ] } : { 'gpt-realtime-2': { voices: ['marin'] }, 'kataleptic-realtime': { voices_by_language: { de: 'de_DE-thorsten-medium' } } }));
  vi.stubGlobal('fetch', fetcher);
  const [a,b] = await Promise.all([providerCatalog(), providerCatalog()]);
  expect(a).toBe(b); expect(a.live).toBe(true);
  expect(a.models.map(m => m.id)).toEqual(['chat-one','gpt-realtime-2','whisper']);
  // Retired Kataleptic ids are never offered, even while the gateway lists them.
  expect(a.voices.native).toEqual([{ id: 'marin', label: 'marin' }]);
  expect(a.voices).not.toHaveProperty('cascade');
  await providerCatalog(); expect(fetcher).toHaveBeenCalledTimes(2);
  for (const call of fetcher.mock.calls as unknown as [string, RequestInit][]) {
    expect(call[0]).toMatch(/^https:\/\/api.kataleptic.com\/v1\//);
    expect(call[1]).toMatchObject({ redirect: 'manual' }); expect(call[1].headers).toBeUndefined();
  }
});
it('returns labeled built-in suggestions on failure and retries after the short fallback cache', async () => {
  vi.resetModules(); vi.useFakeTimers();
  const { providerCatalog } = await import('../src/provider-catalog');
  const fetcher = vi.fn(async () => { throw new Error('offline'); }); vi.stubGlobal('fetch', fetcher);
  const result = await providerCatalog(); expect(result.live).toBe(false);
  expect(result.models.some(m => m.id === 'kataleptic-realtime-hd')).toBe(true);
  expect(result.models.map(m => m.id)).not.toEqual(expect.arrayContaining(['kataleptic-realtime']));
  expect(result.models.filter(m => ['kataleptic-realtime', 'whisper-large-v3-turbo', 'mistral-nemo-12b'].includes(m.id))).toEqual([]);
  await providerCatalog(); expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60001); await providerCatalog(); expect(fetcher).toHaveBeenCalledTimes(4);
});

it('keeps each engine voice list separate and labels only validated live entries', async () => {
  vi.resetModules();
  const { providerCatalog } = await import('../src/provider-catalog');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/models')
    ? { data: [{ id: 'gpt-live-1', architecture: { input_modalities: ['audio'], output_modalities: ['audio'] } }] }
    : {
      'gpt-realtime-2': { voices: ['native-only'] },
      'gpt-realtime-2.1': { voices: ['next-only', 'next-only'] },
      'gpt-realtime-2.1-mini': { voices: ['<invalid>'] },
      'gpt-live-1': { voices: ['live-only'] },
    })));
  const result = await providerCatalog();
  expect(result.voices.realtime['gpt-live-1']).toEqual([{ id: 'live-only', label: 'live-only' }]);
  expect(result.voices.realtime['gpt-realtime-2.1']).toEqual([{ id: 'next-only', label: 'next-only' }]);
  expect(result.voices.realtime['gpt-realtime-2']).toEqual([{ id: 'native-only', label: 'native-only' }]);
  expect(result.voices.cataloguedModels).toEqual(['gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-live-1']);
  expect(result.voices.realtime['gpt-realtime-2.1-mini'].map(v => v.id)).toContain('marin');
});
