import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import worker from '../src/index';
import type { Env } from '../src/types';

// Literal contract values intentionally work with the unchanged original source.
const LIMIT = 128 * 1024, DEADLINE = 5000;
const keys = generateKeyPairSync('ed25519');
const publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
const url = 'https://openfon.test/api/telnyx/webhooks';
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
let env: Env, dispatch: ReturnType<typeof vi.fn>, db: ReturnType<typeof vi.fn>, lookup: ReturnType<typeof vi.fn>;
let cleanups: Array<() => void>, pending: Promise<unknown>[];

function signed(kind = 'message.received', padding = false) {
  let raw = JSON.stringify({ data: { record_type: 'event', id: 'body-fixture',
    event_type: kind, occurred_at: '2026-09-14T00:00:00Z', payload: kind === 'message.received' ? {} : {
      call_control_id: 'fixture-control', call_leg_id: 'fixture-leg', call_session_id: 'fixture-session',
      connection_id: 'fixture-connection', hangup_cause: 'normal_clearing',
    } }, note: '☎' });
  if (padding) raw += ' '.repeat(LIMIT - Buffer.byteLength(raw));
  const body = new TextEncoder().encode(raw), timestamp = String(Math.floor(Date.now() / 1000));
  const headers = { 'Content-Type': 'application/json', 'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': sign(null, Buffer.from(`${timestamp}|${raw}`), keys.privateKey).toString('base64') };
  return { body, headers };
}
function request(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
}
function stream(cancelMode: 'resolve' | 'pending' | 'reject' = 'resolve') {
  let controller!: ReadableStreamDefaultController<Uint8Array>, finishCancel!: () => void;
  const held = new Promise<void>(resolve => { finishCancel = resolve; });
  const cancel = vi.fn(() => cancelMode === 'pending' ? held : cancelMode === 'reject'
    ? Promise.reject(Error('synthetic cancellation failure')) : Promise.resolve());
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel });
  cleanups.push(() => { finishCancel(); try { controller.error(Error('fixture disposed')); } catch { /* closed */ } });
  return { body, controller, cancel };
}
function invoke(req: Request) {
  const result: { response?: Response; error?: unknown } = {};
  const settled = worker.fetch(req, env, ctx).then(response => { result.response = response; }, error => { result.error = error; });
  pending.push(settled);
  return { result, settled };
}
async function observedStatus(result: { response?: Response; error?: unknown }, status: number) {
  // Finite observation: on original source a missing response fails here, not
  // via the test runner timeout. Teardown then releases every held producer.
  expect(result.error).toBeUndefined();
  expect(result.response?.status, 'response observed before fixture disposal').toBe(status);
  expect(result.response!.headers.get('Cache-Control')).toBe('no-store');
  if (status !== 200) expect(await result.response!.json()).toEqual({ error: status === 503
    ? 'Carrier event could not be accepted' : 'Invalid carrier webhook' });
  expect(db).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
  cleanups = []; pending = [];
  db = vi.fn(() => { throw Error('unexpected database access'); });
  dispatch = vi.fn(async () => new Response(null, { status: 204 }));
  lookup = vi.fn(() => ({ fetch: dispatch }));
  env = { DB: { prepare: db }, TELNYX_ENABLED: 'false', TELNYX_PUBLIC_KEY: publicKey,
    TELNYX_CONNECTION_ID: 'fixture-connection', TELNYX_CALL: {
      idFromName: (name: string) => name, get: lookup,
    } } as unknown as Env;
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('unexpected outbound request'); }));
});
afterEach(async () => {
  for (const cleanup of cleanups) cleanup();
  await Promise.all(pending);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('public Telnyx body acquisition budget', () => {
  it('keeps missing body 400 without allocating a deadline', async () => {
    const { result, settled } = invoke(new Request(url, { method: 'POST' })); await settled;
    await observedStatus(result, 400);
  });

  it('keeps unconfigured ingress 503 without reading a body', async () => {
    env.TELNYX_PUBLIC_KEY = '';
    const read = vi.fn();
    const req = new Request(url, { method: 'POST', body: 'fixture' });
    Object.defineProperty(req, 'body', { value: { getReader: read } });
    const { result, settled } = invoke(req); await settled;
    expect(result.response?.status).toBe(503); expect(read).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['first byte', 'partial body', 'trickle'] as const)('bounds %s without waiting for EOF', async mode => {
    const s = stream('pending'), { result } = invoke(request(s.body));
    if (mode !== 'first byte') s.controller.enqueue(new Uint8Array([123]));
    if (mode === 'trickle') {
      for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(1000); s.controller.enqueue(new Uint8Array([32])); }
      await vi.advanceTimersByTimeAsync(999);
    } else await vi.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(result.response).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await observedStatus(result, 408);
    expect(s.cancel).toHaveBeenCalledTimes(1);
    expect(s.body.locked).toBe(false);
  });

  it.each(['pending', 'reject', 'resolve'] as const)('overflow rejects before %s cancellation settles', async cancelMode => {
    const s = stream(cancelMode), { result } = invoke(request(s.body, { 'Content-Length': '1' }));
    s.controller.enqueue(new Uint8Array(LIMIT + 1));
    await vi.advanceTimersByTimeAsync(0);
    await observedStatus(result, 413);
    expect(s.cancel).toHaveBeenCalledTimes(1);
    expect(s.body.locked).toBe(false);
  });

  it('keeps 413 when a synthetic reader cancel and releaseLock throw synchronously', async () => {
    const read = vi.fn(async () => ({ done: false, value: new Uint8Array(LIMIT + 1) }));
    const cancel = vi.fn(() => { throw Error('synthetic cancel'); });
    const releaseLock = vi.fn(() => { throw Error('synthetic lock'); });
    const req = new Request(url, { method: 'POST', body: 'fixture' });
    Object.defineProperty(req, 'body', { value: { getReader: () => ({ read, cancel, releaseLock }) } });
    const { result, settled } = invoke(req); await settled;
    await observedStatus(result, 413);
    expect(cancel).toHaveBeenCalledTimes(1); expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it.each(['EOF', 'chunk', 'rejection'] as const)('ignores synthetic late read %s after the deadline', async kind => {
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
    const held = new Promise((yes, no) => { resolve = yes; reject = no; });
    const read = vi.fn(() => held), cancel = vi.fn(() => new Promise<void>(() => {})), releaseLock = vi.fn();
    cleanups.push(() => resolve({ done: true }));
    const req = new Request(url, { method: 'POST', body: 'fixture' });
    Object.defineProperty(req, 'body', { value: { getReader: () => ({ read, cancel, releaseLock }) } });
    const { result } = invoke(req);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await observedStatus(result, 408);
    if (kind === 'rejection') reject(Error('late synthetic read'));
    else resolve(kind === 'EOF' ? { done: true } : { done: false, value: signed().body });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled(); expect(result.response!.status).toBe(408);
  });

  it('bounds synchronous empty chunks without relying on a timer callback', async () => {
    const data = signed(); let reads = 0;
    const s = stream();
    // Finite even on the original: empty reads, then a valid signed envelope.
    const reader = { read: vi.fn(async () => {
      reads++;
      return reads <= LIMIT + 2 ? { done: false, value: new Uint8Array() }
        : reads === LIMIT + 3 ? { done: false, value: data.body } : { done: true };
    }), cancel: s.cancel, releaseLock: vi.fn() };
    const req = request(s.body, data.headers);
    Object.defineProperty(req, 'body', { value: { getReader: () => reader } });
    const { result, settled } = invoke(req); await settled;
    await observedStatus(result, 400); expect(reads).toBe(LIMIT + 1);
    expect(s.cancel).toHaveBeenCalledTimes(1);
  });

  it('accepts an exact-limit signed UTF8 entity fragmented into single bytes plus EOF', async () => {
    const data = signed('message.received', true); let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === data.body.length) controller.close();
      else controller.enqueue(data.body.subarray(offset, ++offset));
    } });
    const { result, settled } = invoke(request(body, data.headers)); await settled;
    await observedStatus(result, 200); expect(body.locked).toBe(false);
  });

  it('accepts a signed body closed just before the deadline and clears its timer', async () => {
    const data = signed(), s = stream(), { result, settled } = invoke(request(s.body, data.headers));
    s.controller.enqueue(data.body); await vi.advanceTimersByTimeAsync(DEADLINE - 1);
    s.controller.close(); await settled;
    await observedStatus(result, 200); expect(s.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEADLINE); expect(s.cancel).not.toHaveBeenCalled();
  });

  it('preserves generic 503 on a stream read error', async () => {
    const s = stream(), { result, settled } = invoke(request(s.body));
    s.controller.error(Error('untrusted stream diagnostic')); await settled;
    await observedStatus(result, 503); expect(s.body.locked).toBe(false);
  });

  it.each([
    ['bad signature', 401], ['bad content type', 415], ['wrong application', 403],
    ['invalid JSON', 400], ['expired signature', 401],
  ] as const)('preserves completed-body %s rejection', async (kind, status) => {
    const data = signed('call.hangup');
    if (kind === 'bad signature') data.headers['telnyx-signature-ed25519'] = 'invalid';
    if (kind === 'bad content type') data.headers['Content-Type'] = 'text/plain';
    if (kind === 'wrong application') env.TELNYX_CONNECTION_ID = 'other';
    if (kind === 'expired signature') vi.setSystemTime(Date.now() + 301_000);
    if (kind === 'invalid JSON') {
      data.body = new TextEncoder().encode('{');
      data.headers['telnyx-signature-ed25519'] = sign(null, Buffer.from(`${data.headers['telnyx-timestamp']}|{`), keys.privateKey).toString('base64');
    }
    const s = stream(), { result, settled } = invoke(request(s.body, data.headers));
    s.controller.enqueue(data.body); s.controller.close(); await settled;
    expect(result.response?.status).toBe(status); expect(dispatch).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); expect(s.body.locked).toBe(false);
  });

  it.each([204, 503])('acknowledges only after durable handler returns %s', async status => {
    let reply!: () => void;
    const held = new Promise<Response>(resolve => { reply = () => resolve(new Response(null, { status })); });
    cleanups.push(() => reply()); dispatch.mockImplementation(() => held);
    const data = signed('call.hangup'), s = stream();
    const { result, settled } = invoke(request(s.body, data.headers));
    s.controller.enqueue(data.body); s.controller.close();
    // Wait for actual dispatch, rather than assuming crypto resolves in a fixed
    // number of microtasks; this is a completed-body control, not a negative.
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(result.response).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE + 1);
    expect(result.response).toBeUndefined(); // body-only deadline, not DO timeout
    reply(); await settled;
    expect(result.response?.status).toBe(status === 204 ? 200 : 503); expect(db).not.toHaveBeenCalled();
  });
});
