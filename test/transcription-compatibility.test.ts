import { afterEach, expect, it, vi } from 'vitest';
import { transcribe } from '../src/providers';
import type { Env } from '../src/types';

const env = { DEFAULT_STT_BASE_URL: 'https://speech.example/v1', DEFAULT_STT_MODEL: 'future-speaker-model', DEFAULT_STT_API_KEY: 'synthetic' } as Env;
const request = () => transcribe(env, new ArrayBuffer(2), 'audio/wav', 'Dental vocabulary');
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('retries a rejected optional prompt once for any model without reading the error body', async () => {
  const cancel = vi.fn();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    if ((init.body as FormData).has('prompt')) return new Response(new ReadableStream({ cancel }), { status: 400 });
    return Response.json({ text: 'Guten Tag', language: 'de' });
  });
  vi.stubGlobal('fetch', fetcher);
  await expect(request()).resolves.toEqual({ text: 'Guten Tag', language: 'de' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledOnce();
  expect((fetcher.mock.calls[1][1].body as FormData).get('model')).toBe('future-speaker-model');
});

it('allows a slow transcription to finish after the chat deadline', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => setTimeout(() => resolve(Response.json({ text: 'Langsame Erkennung' })), 25000))));
  let result: unknown;
  const task = request().then(value => { result = value; }, error => { result = error; });
  await vi.advanceTimersByTimeAsync(25000); await task;
  expect(result).toMatchObject({ text: 'Langsame Erkennung' });
});

it.each([401, 403, 429, 500])('does not retry status %i or disclose provider text', async status => {
  const fetcher = vi.fn(async () => new Response('private provider diagnostics', { status }));
  vi.stubGlobal('fetch', fetcher);
  await expect(request()).rejects.toThrow(`STT error ${status}: provider request failed`);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('bounds fallback to one attempt with the remaining total deadline', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn((_url: string, init: RequestInit) => (init.body as FormData).has('prompt')
    ? new Promise<Response>(resolve => setTimeout(() => resolve(new Response(null, { status: 422 })), 50000))
    : new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetcher);
  let result: unknown;
  const task = request().catch(error => { result = error; });
  await vi.advanceTimersByTimeAsync(59999); expect(result).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1); await task;
  expect(result).toBeInstanceOf(Error); expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][1].signal?.aborted).toBe(true);
});

it('cancels an in-flight transcription promptly even if fetch ignores abort', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetcher);
  const task = transcribe(env, new ArrayBuffer(2), 'audio/wav', 'vocabulary', undefined, controller.signal);
  controller.abort();
  await expect(task).rejects.toThrow('Provider response');
  expect(fetcher).toHaveBeenCalledOnce();
});

it('respects an operator budget but caps it at two minutes', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  for (const [configured, expected] of [['2000', 2000], ['999999', 120000]]) {
    let result: unknown;
    const task = transcribe({ ...env, STT_TIMEOUT_MS: configured }, new ArrayBuffer(2), 'audio/wav').catch(error => { result = error; });
    await vi.advanceTimersByTimeAsync(expected - 1); expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await task; expect(result).toBeInstanceOf(Error);
  }
});

it('never loops after a failed compatibility attempt or retries an unprompted request', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 400 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(request()).rejects.toThrow('STT error 400');
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockClear();
  await expect(transcribe(env, new ArrayBuffer(2), 'audio/wav')).rejects.toThrow('STT error 400');
  expect(fetcher).toHaveBeenCalledOnce();
});

it('reads the detected language from gpt-transcribe\'s languages list', async () => {
  // Recorded shape from api.kataleptic.com, 2026-09-23.
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ text: 'Guten Tag', languages: [{ code: 'de' }], usage: { type: 'duration', seconds: 5 } })));
  await expect(request()).resolves.toEqual({ text: 'Guten Tag', language: 'de' });
});

it.each([[{ languages: 'de' }], [{ languages: [{ code: 7 }] }], [{ languages: [] }], [{ languages: [null] }]])('keeps the transcript when the languages list is malformed: %j', async extra => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ text: 'Guten Tag', ...extra })));
  await expect(request()).resolves.toMatchObject({ text: 'Guten Tag' });
});
