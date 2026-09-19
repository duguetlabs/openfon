import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('filters protocol-incompatible streaming STT, aliases, and untrusted identifiers; shares cached requests without credentials', async () => {
  vi.resetModules();
  const { providerCatalog } = await import('../src/provider-catalog');
  const model = (id: string, input: string[], output: string[]) => ({ id, architecture: { input_modalities: input, output_modalities: output } });
  const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith('/models') ? { data: [
    model('chat-one', ['text'], ['text']), model('alias/chat-one', ['text'], ['text']), model('gpt-realtime-2', ['audio'], ['audio']),
    model('whisper', ['audio'], ['text']), model('whisper-stream', ['audio'], ['text']), model('<script>', ['text'], ['text']),
  ] } : { 'gpt-realtime-2': { voices: ['marin'] }, 'kataleptic-realtime': { voices_by_language: { de: 'de_DE-thorsten-medium' } } }));
  vi.stubGlobal('fetch', fetcher);
  const [a,b] = await Promise.all([providerCatalog(), providerCatalog()]);
  expect(a).toBe(b); expect(a.live).toBe(true);
  expect(a.models.map(m => m.id)).toEqual(['chat-one','gpt-realtime-2','whisper']);
  expect(a.voices.cascade).toEqual([{ id: 'de_DE-thorsten-medium', label: 'de_DE-thorsten-medium' }]);
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
  await providerCatalog(); expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60001); await providerCatalog(); expect(fetcher).toHaveBeenCalledTimes(4);
});
