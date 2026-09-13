import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let lookup: typeof import('../src/piper-catalog').piperVoiceFromCatalog;
const catalog = (voices: Record<string, string>) => Response.json({ 'kataleptic-realtime': { voices_by_language: voices } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  vi.resetModules();
  ({ piperVoiceFromCatalog: lookup } = await import('../src/piper-catalog'));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Piper concurrent catalog admission', () => {
  it('[original-negative] admits one cold normalized endpoint and immediately falls back for concurrent callers', async () => {
    const gate = deferred<void>();
    const fetcher = vi.fn(async () => { await gate.promise; return catalog({ en: 'en_shared', de: 'de_shared' }); });
    vi.stubGlobal('fetch', fetcher);
    const calls = Array.from({ length: 100 }, (_, i) => lookup(i % 2 ? 'wss://VOICE.example:443/rt/' : 'wss://voice.example/rt', i % 3 === 0 ? 'en' : i % 3 === 1 ? 'de' : 'fr', `fallback_${i}`));
    let settled = 0;
    calls.slice(1).forEach(p => { void p.then(() => { settled++; }); });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const countWhilePending = fetcher.mock.calls.length;
    const settledBeforeOwner = settled;
    gate.resolve();
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 100 }, (_, i) => i === 0 ? 'en_shared' : `fallback_${i}`));
    expect(countWhilePending).toBe(1);
    expect(settledBeforeOwner).toBe(99);
    expect(await lookup('wss://voice.example/rt', 'de', 'de_fallback')).toBe('de_shared');
    expect(await lookup('wss://voice.example/rt', 'fr', 'fr_fallback')).toBe('fr_fallback');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('[original-negative] refuses duplicate work after headers arrive while the body is pending', async () => {
    const gate = deferred<void>();
    let bodies = 0;
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      async start(controller) {
        bodies++;
        await gate.promise;
        controller.enqueue(new TextEncoder().encode('{"kataleptic-realtime":{"voices_by_language":{"en":"en_stream"}}}'));
        controller.close();
      },
    })));
    vi.stubGlobal('fetch', fetcher);
    const first = lookup('wss://voice.example/rt', 'en', 'fallback');
    // Let the first lookup receive its headers and begin the pending read.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const rest = Array.from({ length: 20 }, () => lookup('wss://voice.example/rt', 'en', 'fallback'));
    await Promise.resolve();
    const pendingBodies = bodies;
    gate.resolve();
    expect(await Promise.all([first, ...rest])).toEqual(['en_stream', ...Array(20).fill('fallback')]);
    expect(pendingBodies).toBe(1);
  });

  it('[original-negative] bounds distinct pending endpoints without queueing and releases capacity', async () => {
    const gate = deferred<void>();
    const fetcher = vi.fn(async (url: string) => { await gate.promise; return catalog({ en: url.includes('extra') ? 'en_extra' : 'en_shared' }); });
    vi.stubGlobal('fetch', fetcher);
    const calls = Array.from({ length: 40 }, (_, i) => lookup(`wss://tenant-${i}.example/rt`, 'en', `fallback_${i}`));
    await Promise.resolve();
    let overflowSettled = 0;
    calls.slice(32).forEach(p => { void p.then(() => { overflowSettled++; }); });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const observedOverflow = overflowSettled;
    const countWhilePending = fetcher.mock.calls.length;
    // A matching in-flight endpoint uses its own fallback even at capacity.
    const shared = lookup('wss://tenant-0.example/rt', 'en', 'shared_fallback');
    gate.resolve();
    const results = await Promise.all(calls);
    expect(await shared).toBe('shared_fallback');
    expect(countWhilePending).toBe(32);
    expect(observedOverflow).toBe(8);
    expect(results).toEqual(Array.from({ length: 40 }, (_, i) => i < 32 ? 'en_shared' : `fallback_${i}`));
    expect(await lookup('wss://extra.example/rt', 'en', 'fallback')).toBe('en_extra');
    expect(fetcher).toHaveBeenCalledTimes(33);
  });

  it('[original-negative] admits one expired refresh and never returns stale voices on failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const gate = deferred<void>();
    const fetcher = vi.fn(async () => catalog({ en: 'en_old' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await lookup('wss://voice.example/rt', 'en', 'fallback')).toBe('en_old');
    vi.setSystemTime(Date.now() + 3_600_001);
    fetcher.mockImplementation(async () => { await gate.promise; throw new Error('offline'); });
    const calls = Array.from({ length: 20 }, (_, i) => lookup('wss://voice.example/rt', 'en', `fallback_${i}`));
    await Promise.resolve();
    const countWhilePending = fetcher.mock.calls.length;
    gate.resolve();
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 20 }, (_, i) => `fallback_${i}`));
    expect(countWhilePending).toBe(2);
    fetcher.mockImplementation(async () => catalog({ en: 'en_new' }));
    expect(await lookup('wss://voice.example/rt', 'en', 'fallback')).toBe('en_new');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps cache hits available while pending capacity is full and separates path/query identity', async () => {
    const gate = deferred<void>();
    const fetcher = vi.fn(async () => catalog({ en: 'en_cached' }));
    vi.stubGlobal('fetch', fetcher);
    await lookup('wss://cached.example/rt', 'en', 'fallback');
    fetcher.mockImplementation(async () => { await gate.promise; return catalog({ en: 'en_pending' }); });
    const calls = Array.from({ length: 32 }, (_, i) => lookup(`wss://voice.example/path-${i % 2}?route=${i}`, 'en', 'fallback'));
    expect(await lookup('wss://cached.example/rt', 'en', 'fallback')).toBe('en_cached');
    await Promise.resolve();
    const count = fetcher.mock.calls.length;
    gate.resolve();
    expect(await Promise.all(calls)).toEqual(Array(32).fill('en_pending'));
    expect(count).toBe(33);
  });


  it('reclaims an abandoned scalar reservation at the deadline and isolates late completion/cleanup', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const old = deferred<void>();
    const fresh = deferred<void>();
    // Deliberately ignore AbortSignal to model a context that cannot execute
    // its old continuation until after another request reclaimed capacity.
    const fetcher = vi.fn(async () => { await old.promise; return catalog({ en: 'en_old' }); });
    vi.stubGlobal('fetch', fetcher);
    const first = lookup('wss://voice.example/rt', 'en', 'old_fallback');
    vi.setSystemTime(Date.now() + 1499);
    expect(await lookup('wss://voice.example/rt', 'en', 'busy')).toBe('busy');
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    fetcher.mockImplementation(async () => { await fresh.promise; return catalog({ en: 'en_new' }); });
    const second = lookup('wss://voice.example/rt', 'en', 'new_fallback');
    old.resolve();
    expect(await first).toBe('old_fallback');
    // The old finally must not delete the replacement reservation.
    expect(await lookup('wss://voice.example/rt', 'en', 'still_busy')).toBe('still_busy');
    expect(fetcher).toHaveBeenCalledTimes(2);
    fresh.resolve();
    expect(await second).toBe('en_new');
    expect(await lookup('wss://voice.example/rt', 'en', 'fallback')).toBe('en_new');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reclaims expired distinct capacity without allowing late owners to populate the cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const gate = deferred<void>();
    const fetcher = vi.fn(async () => { await gate.promise; return catalog({ en: 'en_expired' }); });
    vi.stubGlobal('fetch', fetcher);
    const calls = Array.from({ length: 32 }, (_, i) => lookup(`wss://abandoned-${i}.example/rt`, 'en', `fallback_${i}`));
    expect(await lookup('wss://next.example/rt', 'en', 'busy')).toBe('busy');
    expect(fetcher).toHaveBeenCalledTimes(32);
    vi.setSystemTime(Date.now() + 1500);
    fetcher.mockImplementation(async () => catalog({ en: 'en_new' }));
    expect(await lookup('wss://next.example/rt', 'en', 'fallback')).toBe('en_new');
    gate.resolve();
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 32 }, (_, i) => `fallback_${i}`));
    expect(await lookup('wss://abandoned-0.example/rt', 'en', 'fallback')).toBe('en_new');
    expect(fetcher).toHaveBeenCalledTimes(34);
  });

  it.each(['throw', 'reject', 'redirect', 'oversize', 'body-error', 'abort'])('releases a failed lookup for a later retry: %s', async failure => {
    const abort = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      if (failure === 'throw') throw new Error('synchronous failure');
      if (failure === 'reject') return Promise.reject(new Error('offline'));
      if (failure === 'redirect') return Promise.resolve(new Response(null, { status: 302 }));
      if (failure === 'oversize') return Promise.resolve(new Response(' '.repeat(65_537)));
      if (failure === 'body-error') return Promise.resolve(new Response(new ReadableStream({ start(c) { c.error(new Error('body failed')); } })));
      return new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    });
    vi.stubGlobal('fetch', fetcher);
    const result = lookup('wss://voice.example/rt', 'en', 'fallback');
    await Promise.resolve();
    abort.abort();
    expect(await result).toBe('fallback');
    expect(timeout).toHaveBeenCalledWith(1500);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'manual', signal: abort.signal });
    timeout.mockRestore();
    fetcher.mockImplementation(() => Promise.resolve(catalog({ en: 'en_recovered' })));
    expect(await lookup('wss://voice.example/rt', 'en', 'fallback')).toBe('en_recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
