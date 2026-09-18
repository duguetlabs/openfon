import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let lookup: typeof import('../src/piper-catalog').piperVoiceFromCatalog;
const endpoint = 'wss://voice.example/rt';
const payload = (voice = 'en_late') => new TextEncoder().encode(JSON.stringify({
  'kataleptic-realtime': { voices_by_language: { en: voice } },
}));
const catalog = (voice = 'en_ok') => new Response(payload(voice));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
// Cleanup failures are reported by a separate afterEach hook, so a failing
// original deadline assertion retains its own first failure and stack.
const cleanupFailures: Error[] = [];
async function admissionBarrier(bases: string[], fetcher: ReturnType<typeof vi.fn>): Promise<void> {
  const admitted = new Set<string>();
  // Cleanup probes cannot cache data or wait on the old fixture gates. A fetch
  // for the SAME endpoint proves its old reservation was released; completion
  // of this immediate non-OK/null-body probe also settles the probe itself.
  fetcher.mockImplementation(async (url: string) => {
    admitted.add(url);
    return new Response(null, { status: 503 });
  });
  for (const base of bases) {
    const url = base.replace('wss://', 'https://') + '/voices';
    let crossed = false;
    for (let attempt = 0; attempt < 32; attempt++) {
      let completed = false, rejected = false;
      void lookup(base, 'en', 'cleanup_fallback').then(
        () => { completed = true; },
        () => { completed = true; rejected = true; },
      );
      await flush();
      // Never await an unbounded public promise or add another probe while it
      // remains unresolved. No timers or elapsed-time refill advance here.
      if (!completed || rejected) throw new Error('Cleanup probe did not complete successfully within 24 microtask turns');
      if (admitted.has(url)) { crossed = true; break; }
    }
    if (!crossed) throw new Error('Old endpoint admission was not released within 32 bounded probes');
  }
}
async function cleanupHeld(label: string, release: () => void, fetcher: ReturnType<typeof vi.fn>, bases: string[]) {
  try { release(); }
  catch { cleanupFailures.push(new Error(label + ': gate release failed')); }
  try { await admissionBarrier(bases, fetcher); }
  catch (error) {
    cleanupFailures.push(new Error(label + ': admission cleanup barrier failed', { cause: error }));
  }
}
const signals: Array<{ signal: AbortSignal; add: ReturnType<typeof vi.spyOn>; remove: ReturnType<typeof vi.spyOn> }> = [];
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.resetModules();
  signals.length = 0;
  cleanupFailures.length = 0;
  // Drive the existing native timeout API deterministically; mocked fetch and
  // streams intentionally ignore abort. This is not native cancellation proof.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    signals.push({ signal: controller.signal, add, remove });
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  ({ piperVoiceFromCatalog: lookup } = await import('../src/piper-catalog'));
});
afterEach(() => {
  vi.clearAllTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
  if (cleanupFailures.length) {
    throw new AggregateError(cleanupFailures, 'Piper fixture cleanup failure (separate from test-body assertions)');
  }
});

describe('Piper initiating caller deadline', () => {
  it.each(['http-error', 'declared-size', 'stream-overflow', 'expired-response', 'fetch', 'read'] as const)(
    '[caller-deadline-negative] returns fallback while %s pipeline is still held', async kind => {
      const headers = deferred<Response>();
      const cancel = deferred<void>();
      let cancelEntered = 0, readEntered = 0, fetchEntered = 0;
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { stream = controller; },
        pull(controller) {
          readEntered++;
          if (kind === 'stream-overflow') controller.enqueue(new Uint8Array(65_537));
        },
        cancel() { cancelEntered++; return cancel.promise; },
      }, { highWaterMark: 0 });
      const response = new Response(body, {
        status: kind === 'http-error' ? 503 : 200,
        headers: kind === 'declared-size' ? { 'Content-Length': '65537' } : {},
      });
      const fetcher = vi.fn(() => {
        fetchEntered++;
        return kind === 'expired-response' || kind === 'fetch' ? headers.promise : Promise.resolve(response);
      });
      vi.stubGlobal('fetch', fetcher);
      let observed: string | undefined;
      const first = lookup(endpoint, 'en', 'owner_fallback');
      void first.then(value => { observed = value; });
      try {
        await flush();
        expect(fetchEntered).toBe(1);
        if (['http-error', 'declared-size', 'stream-overflow'].includes(kind)) expect(cancelEntered).toBe(1);
        if (kind === 'read') expect(readEntered).toBe(1);
        if (kind === 'expired-response' || kind === 'fetch') expect(readEntered).toBe(0);
        await vi.advanceTimersByTimeAsync(1499);
        expect(observed).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        const outcomeAtDeadline = observed;
        // Expired-response ordering: capture caller outcome FIRST, then inject
        // late headers and prove cancel (not read) is entered with debt retained.
        if (kind === 'expired-response') {
          headers.resolve(response);
          await flush();
          expect(cancelEntered).toBe(1);
          expect(readEntered).toBe(0);
        }
        expect(await lookup(endpoint, 'de', 'follower_fallback')).toBe('follower_fallback');
        expect(fetcher).toHaveBeenCalledTimes(1);
        // The original terminates here with undefined, never a five-second hang.
        expect(outcomeAtDeadline).toBe('owner_fallback');
      } finally {
        await cleanupHeld('held-' + kind, () => {
          headers.resolve(response);
          cancel.resolve();
          if (kind === 'read') stream.close();
        }, fetcher, [endpoint]);
      }
    },
  );

  it('retains all32 slots after caller timeout and releases exactly one on cancel settlement', async () => {
    const cancels = Array.from({ length: 32 }, () => deferred<void>());
    let entered = 0;
    const fetcher = vi.fn(async (url: string) => {
      const index = Number(new URL(url).hostname.split('-')[1].split('.')[0]);
      return new Response(new ReadableStream({ cancel() { entered++; return cancels[index].promise; } }, { highWaterMark: 0 }), { status: 503 });
    });
    vi.stubGlobal('fetch', fetcher);
    const outcomes: Array<string | undefined> = Array(32).fill(undefined);
    const ownerEndpoints = Array.from({ length: 32 }, (_, i) => `wss://tenant-${i}.example/rt`);
    const owners = ownerEndpoints.map((base, i) => lookup(base, 'en', `fallback_${i}`));
    owners.forEach((owner, i) => { void owner.then(value => { outcomes[i] = value; }); });
    const replacementGate = deferred<Response>();
    let replacement: Promise<string> | undefined;
    try {
      await flush();
      expect(entered).toBe(32);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await lookup('wss://overflow.example/rt', 'en', 'full')).toBe('full');
      expect(await lookup('wss://tenant-0.example/rt', 'de', 'busy')).toBe('busy');
      expect(fetcher).toHaveBeenCalledTimes(32);
      const outcomesBeforeFirstRelease = [...outcomes];
      expect(outcomesBeforeFirstRelease).toEqual(Array.from({ length: 32 }, (_, i) => `fallback_${i}`));
      cancels[0].resolve();
      await flush();
      fetcher.mockImplementation(() => replacementGate.promise);
      replacement = lookup('wss://replacement.example/rt', 'en', 'replacement');
      expect(await lookup('wss://overflow.example/rt', 'en', 'still_full')).toBe('still_full');
      expect(fetcher).toHaveBeenCalledTimes(33);
    } finally {
      await cleanupHeld('full32', () => {
        cancels.forEach(gate => gate.resolve());
        replacementGate.resolve(new Response(null, { status: 503 }));
      }, fetcher, [...ownerEndpoints, ...(replacement ? ['wss://replacement.example/rt'] : [])]);
    }
  });

  it('[caller-deadline-negative] never publishes a late body after deadline and wall-clock rollback', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let entered = 0;
    const body = new ReadableStream<Uint8Array>({ start(c) { stream = c; }, pull() { entered++; } }, { highWaterMark: 0 });
    const fetcher = vi.fn(async () => new Response(body));
    vi.stubGlobal('fetch', fetcher);
    let observed: string | undefined;
    const first = lookup(endpoint, 'en', 'fallback');
    void first.then(value => { observed = value; });
    try {
      await flush(); expect(entered).toBe(1);
      await vi.advanceTimersByTimeAsync(1500);
      vi.setSystemTime(0);
      stream.enqueue(payload()); stream.close();
      await flush();
      expect(observed).toBe('fallback');
      fetcher.mockImplementation(async () => catalog('en_fresh'));
      expect(await lookup(endpoint, 'en', 'fallback')).toBe('en_fresh');
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      try { stream.close(); } catch { /* already closed */ }
      await first;
    }
  });

  it.each(['fulfill', 'reject'] as const)('observes late cancel %s and admits a clean retry', async outcome => {
    const cancel = deferred<void>();
    let entered = 0;
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      cancel() { entered++; return cancel.promise; },
    }, { highWaterMark: 0 }), { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const first = lookup(endpoint, 'en', 'fallback');
    try {
      await flush(); expect(entered).toBe(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await lookup(endpoint, 'en', 'busy')).toBe('busy');
      if (outcome === 'reject') cancel.reject(new Error('synthetic cancellation rejection'));
      else cancel.resolve();
      await first; await flush();
      fetcher.mockImplementation(async () => catalog());
      expect(await lookup(endpoint, 'en', 'fallback')).toBe('en_ok');
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { cancel.resolve(); await first; }
  });

  it.each(['signal', 'listener', 'already-aborted'] as const)('releases admission when %s setup fails before I/O', async failure => {
    if (failure === 'signal') vi.mocked(AbortSignal.timeout).mockImplementationOnce(() => { throw new Error('setup'); });
    else if (failure === 'already-aborted') {
      const controller = new AbortController(); controller.abort();
      vi.mocked(AbortSignal.timeout).mockReturnValueOnce(controller.signal);
    } else {
      const signal = new AbortController().signal;
      vi.spyOn(signal, 'addEventListener').mockImplementationOnce(() => { throw new Error('setup'); });
      vi.mocked(AbortSignal.timeout).mockReturnValueOnce(signal);
    }
    const fetcher = vi.fn(async () => catalog());
    vi.stubGlobal('fetch', fetcher);
    expect(await lookup(endpoint, 'en', 'fallback')).toBe('fallback');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await lookup(endpoint, 'en', 'retry')).toBe('en_ok');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'] as const)('removes the caller listener on early %s', async outcome => {
    const fetcher = vi.fn(async () => {
      if (outcome === 'failure') throw new Error('offline');
      return catalog();
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await lookup(endpoint, 'en', 'fallback')).toBe(outcome === 'success' ? 'en_ok' : 'fallback');
    expect(AbortSignal.timeout).toHaveBeenCalledWith(1500);
    const record = signals[0];
    const registration = record.add.mock.calls.find(args => args[0] === 'abort');
    expect(registration).toBeDefined();
    expect(record.remove).toHaveBeenCalledWith('abort', registration![1]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses admission-origin deadline after delayed headers without resetting on body progress', async () => {
    const headers = deferred<Response>();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({ start(c) { stream = c; }, pull() { reads++; } }, { highWaterMark: 0 });
    const fetcher = vi.fn(() => headers.promise);
    vi.stubGlobal('fetch', fetcher);
    let observed: string | undefined;
    const first = lookup(endpoint, 'en', 'fallback');
    void first.then(value => { observed = value; });
    try {
      await vi.advanceTimersByTimeAsync(1000);
      headers.resolve(new Response(body)); await flush();
      expect(reads).toBe(1);
      stream.enqueue(new TextEncoder().encode('{')); await flush();
      await vi.advanceTimersByTimeAsync(499); expect(observed).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1); expect(observed).toBe('fallback');
    } finally {
      await cleanupHeld('delayed-headers', () => {
        headers.resolve(new Response(null));
        stream.close();
      }, fetcher, [endpoint]);
    }
  });

  it('preserves exact body limit, language selection and settled cache hits', async () => {
    const text = new TextDecoder().decode(payload('en_exact'));
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(text + ' '.repeat(65_536 - text.length)));
    vi.stubGlobal('fetch', fetcher);
    expect(await lookup(endpoint, 'en', 'fallback')).toBe('en_exact');
    expect(await lookup(endpoint, 'de', 'de_fallback')).toBe('de_fallback');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'manual', signal: signals[0].signal });
  });
});
