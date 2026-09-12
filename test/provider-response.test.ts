import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatComplete, transcribe } from '../src/providers';
import { MAX_PROVIDER_JSON_BYTES as CAP, MAX_PROVIDER_READS, PROVIDER_RESPONSE_TIMEOUT_MS as TIMEOUT } from '../src/provider-response';
import type { Env } from '../src/types';

const key = 'synthetic-workspace-key';
const base = 'https://provider.example/proxy/chat/completions/v1?route=private';
const content = (kind: string) => kind === 'chat' ? { choices: [{ message: { content: '{"message":"hello €"}' } }] } : { text: ' hello € ', language: 'en' };
function request(kind: string) {
  return kind === 'chat'
    ? chatComplete({ baseUrl: base, apiKey: key, model: 'workspace-chat' }, [{ role: 'user', content: 'hello' }], { json: true, maxTokens: 123 })
    : transcribe({ DEFAULT_STT_BASE_URL: 'https://unused.example/v1', DEFAULT_STT_API_KEY: 'unused-key' } as Env,
      new ArrayBuffer(2), 'audio/wav', 'Northwheel', {
        stt_provider: 'custom', stt_base_url: base, stt_api_key: key, stt_model: 'workspace-stt',
      });
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

for (const kind of ['chat', 'stt']) describe(`${kind} bounded provider response`, () => {
  it('preserves normal structured/multibyte responses and request configuration', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify(content(kind)));
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(c) {
      // Split a UTF-8 sequence across chunks.
      for (let i = 0; i < encoded.length; i += 2) c.enqueue(encoded.slice(i, i + 2));
      c.close();
    } })));
    vi.stubGlobal('fetch', fetcher);
    const result = await request(kind);
    expect(result).toEqual(kind === 'chat' ? '{"message":"hello €"}' : { text: 'hello €', language: 'en' });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://provider.example/proxy/chat/completions/v1/${kind === 'chat' ? 'chat/completions' : 'audio/transcriptions'}?route=private`);
    expect(init.redirect).toBe('manual');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${key}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (kind === 'chat') expect(JSON.parse(init.body as string)).toMatchObject({ model: 'workspace-chat', max_tokens: 123, response_format: { type: 'json_object' } });
    else expect((init.body as FormData).get('model')).toBe('workspace-stt');
  });

  it('accepts exactly64KiB but rejects one byte more before JSON.parse', async () => {
    const minimal = JSON.stringify({ ...content(kind), padding: '' });
    const exact = JSON.stringify({ ...content(kind), padding: 'x'.repeat(CAP - minimal.length - 2) }); // euro adds2 UTF8 bytes
    expect(new TextEncoder().encode(exact).length).toBe(CAP);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(exact)));
    await request(kind);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(exact + ' ')));
    const parse = vi.spyOn(JSON, 'parse');
    await expect(request(kind)).rejects.toThrow('Provider response');
    expect(parse.mock.calls.length).toBe(0);
  });

  it.each(['absent', 'lying', 'oversized'])('cancels an oversized stream with %s Content-Length without awaiting cancellation', async length => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { streamController = c; c.enqueue(new Uint8Array(CAP + 1)); }, cancel });
    const headers = length === 'absent' ? undefined : { 'Content-Length': length === 'lying' ? '1' : String(CAP + 1) };
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { signal = init.signal; return new Response(body, { headers }); }));
    const parse = vi.spyOn(JSON, 'parse');
    let result: unknown;
    const task = request(kind).then(value => { result = value; }, error => { result = error; });
    try {
      await flush();
      expect(result instanceof Error).toBe(true);
      expect(cancel.mock.calls.length).toBeGreaterThan(0);
      expect(parse.mock.calls.length).toBe(0);
      expect(signal?.aborted).toBe(true);
    } finally { parse.mockRestore(); try { streamController.close(); } catch { /* cancelled */ } }
    await task;
  });

  it('bounds cumulative chunks, not just each chunk', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) {
      c.enqueue(new Uint8Array(CAP / 2)); c.enqueue(new Uint8Array(CAP / 2)); c.enqueue(new Uint8Array(1));
    }, cancel }))));
    const parse = vi.spyOn(JSON, 'parse');
    await expect(request(kind)).rejects.toThrow('Provider response');
    expect(cancel.mock.calls.length).toBe(1);
    expect(parse.mock.calls.length).toBe(0);
  });

  it('times out header wait and cancels a late non-cooperative fetch response', async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init) => { signal = init.signal; return new Promise<Response>(done => { resolve = done; }); }));
    let result: unknown;
    const task = request(kind).catch(error => { result = error; });
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(result instanceof Error).toBe(true);
    expect(signal?.aborted).toBe(true);
    const cancel = vi.fn(); resolve(new Response(new ReadableStream({ cancel })));
    await flush(); await task;
    expect(cancel.mock.calls.length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one deadline for headers plus a stalled body, even if cancel never settles', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise<Response>(resolve => setTimeout(() => resolve(new Response(new ReadableStream({ cancel }))), TIMEOUT - 1000));
    }));
    let result: unknown;
    const task = request(kind).catch(error => { result = error; });
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1); expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await task;
    expect(result instanceof Error).toBe(true);
    expect(cancel.mock.calls.length).toBeGreaterThan(0);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not reflect malformed JSON, stream errors, or network errors', async () => {
    for (const mode of ['json', 'stream', 'fetch']) {
      const secret = `private reflected ${key}`;
      vi.stubGlobal('fetch', vi.fn(async () => {
        if (mode === 'fetch') throw new Error(secret);
        if (mode === 'stream') return new Response(new ReadableStream({ start(c) { c.error(new Error(secret)); } }));
        return new Response(secret);
      }));
      const error = await request(kind).catch(e => e);
      expect(error instanceof Error).toBe(true);
      expect(String(error)).toBe('Error: Provider response unavailable, invalid, too large, or timed out');
      expect(String(error)).not.toContain(key);
    }
  });

  it('accepts64KiB one-byte fragments with one whole-operation deadline race', async () => {
    const minimal = JSON.stringify({ ...content(kind), padding: '' });
    const bytes = new TextEncoder().encode(JSON.stringify({ ...content(kind), padding: 'x'.repeat(CAP - minimal.length - 2) }));
    let offset = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull(c) {
      if (offset === bytes.length) c.close();
      else c.enqueue(bytes.subarray(offset, ++offset));
    } }))));
    const race = vi.spyOn(Promise, 'race');
    await request(kind);
    expect(offset).toBe(CAP);
    expect(race.mock.calls.length).toBe(1);
  });

  it('cancels empty-chunk producers within the read budget without parsing', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ pull(c) {
      pulls++; c.enqueue(new Uint8Array(0));
    }, cancel }))));
    const parse = vi.spyOn(JSON, 'parse');
    const race = vi.spyOn(Promise, 'race');
    await expect(request(kind)).rejects.toThrow('Provider response');
    expect(pulls).toBeLessThanOrEqual(MAX_PROVIDER_READS + 1); // stream prefetch may add one
    expect(cancel.mock.calls.length).toBe(1);
    expect(parse.mock.calls.length).toBe(0);
    expect(race.mock.calls.length).toBe(1);
  });

  it('preserves status errors and cancels unread error bodies', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 401 })));
    await expect(request(kind)).rejects.toThrow(kind === 'chat' ? 'LLM error 401: check the API key and model permissions' : 'STT error 401: provider request failed');
    expect(cancel.mock.calls.length).toBe(1);
  });
});
