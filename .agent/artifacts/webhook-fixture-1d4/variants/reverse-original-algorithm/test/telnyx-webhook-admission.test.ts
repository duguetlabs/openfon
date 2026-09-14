import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Hono } from 'hono';
import type { Env } from '../src/types';

// Public-route tests deliberately import no new admission API: copy unchanged
// onto exact ddce for original negatives. Each test loads a fresh module budget;
// production has no reset, and quarantine is permanent within an isolate.
const URL = 'https://openfon.test/api/telnyx/webhooks';
const keys = generateKeyPairSync('ed25519');
const publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
let worker: typeof import('../src/index')['default'];
let env: Env, pending: Promise<unknown>[], cleanup: Array<() => void>;
let lookup: ReturnType<typeof vi.fn>, db: ReturnType<typeof vi.fn>;
const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
const tick = () => vi.advanceTimersByTimeAsync(0);

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type ReadResult = { done: boolean; value?: Uint8Array };
function heldReader(options: { cancel?: 'pending' | 'resolve' | 'reject' | 'throw'; lockFails?: boolean } = {}) {
  // Deliberately independent read/cancel settlement: this is a synthetic reader,
  // not a claim that real ReadableStream cancellation leaves read pending.
  const readResult = deferred<ReadResult>(), cancelResult = deferred<void>();
  const reader = {
    read: vi.fn(() => readResult.promise),
    cancel: vi.fn(() => {
      if (options.cancel === 'throw') throw Error('synthetic cancellation throw');
      if (options.cancel === 'reject') return Promise.reject(Error('synthetic cancellation rejection'));
      return options.cancel === 'resolve' ? Promise.resolve() : cancelResult.promise;
    }),
    releaseLock: vi.fn(() => { if (options.lockFails) throw Error('synthetic lock release failure'); }),
  };
  const getReader = vi.fn(() => reader);
  const request = new Request(URL, { method: 'POST', body: 'fixture' });
  Object.defineProperty(request, 'body', { value: { getReader } });
  cleanup.push(() => { readResult.resolve({ done: true }); cancelResult.resolve(); });
  return { reader, getReader, request, readResult, cancelResult };
}
function start(request: Request, app = worker) {
  const result: { response?: Response; error?: unknown } = {};
  const settled = Promise.resolve(app.fetch(request, env, context)).then(response => { result.response = response; }, error => { result.error = error; });
  pending.push(settled);
  return { result, settled };
}
async function probe(expected: number, app = worker) {
  const f = heldReader(); f.readResult.resolve({ done: true });
  const { result, settled } = start(f.request, app); await settled;
  expect(result.error).toBeUndefined();
  expect(result.response?.status).toBe(expected);
  expect(result.response?.headers.get('Cache-Control')).toBe('no-store');
  if (expected === 503) {
    expect(result.response?.headers.get('Retry-After')).toBe('1');
    expect(await result.response!.json()).toEqual({ error: 'Carrier ingress unavailable' });
    expect(f.getReader).not.toHaveBeenCalled(); expect(f.reader.cancel).not.toHaveBeenCalled();
  } else {
    expect(expected).toBe(400); expect(f.getReader).toHaveBeenCalledTimes(1);
  }
}
function fill(options: Parameters<typeof heldReader>[0] = {}, count = 16) {
  return Array.from({ length: count }, () => {
    const f = heldReader(options); return { ...f, ...start(f.request) };
  });
}
function signed(id = 'lease-fixture') {
  const raw = JSON.stringify({ data: { id, record_type: 'event', event_type: 'call.hangup',
    occurred_at: '2026-09-14T00:00:00Z', payload: { call_control_id: 'control', call_leg_id: 'leg',
      call_session_id: 'session', connection_id: 'connection', hangup_cause: 'normal_clearing' } } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request(URL, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json',
    'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': sign(null, Buffer.from(`${timestamp}|${raw}`), keys.privateKey).toString('base64') } });
}


type SignedFixture<T> = {
  id: string; request: Request; body: Uint8Array; signedInput: Uint8Array;
  gate: ReturnType<typeof deferred<T>>;
};
type SignedOwner<T> = SignedFixture<T> & ReturnType<typeof start>;

async function signedBatch<T>(): Promise<SignedFixture<T>[]> {
  return Promise.all(Array.from({ length: 16 }, async (_, index) => {
    const id = `lease-fixture-${index}`, request = signed(id);
    const body = new Uint8Array(await request.clone().arrayBuffer());
    const prefix = new TextEncoder().encode(`${request.headers.get('telnyx-timestamp')}|`);
    const signedInput = new Uint8Array(prefix.length + body.length);
    signedInput.set(prefix); signedInput.set(body, prefix.length);
    return { id, request, body, signedInput, gate: deferred<T>() };
  }));
}

function signedBoundary<T>(fixtures: SignedFixture<T>[]) {
  const byId = new Map(fixtures.map(f => [f.id, f]));
  const byInput = new Map(fixtures.map(f => [Buffer.from(f.signedInput).toString('base64'), f.id]));
  expect(byId.size).toBe(16); expect(byInput.size).toBe(16);
  const ids: string[] = [], errors: string[] = [];
  function fail(message: string): never { errors.push(message); throw Error(message); }
  function enter(id: unknown) {
    if (typeof id !== 'string' || !byId.has(id)) return fail(`Unknown signed fixture identity: ${String(id)}`);
    if (ids.includes(id)) return fail(`Duplicate signed fixture identity: ${id}`);
    ids.push(id);
    return byId.get(id)!.gate.promise;
  }
  return {
    ids, errors, enter,
    verifyInput(data: BufferSource) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const id = byInput.get(Buffer.from(bytes).toString('base64'));
      if (id === undefined) return fail('Unknown exact signed fixture bytes');
      return enter(id);
    },
    async wait(count: number) {
      // Existing Vitest waitFor bounds apply; no longer test/body deadlines.
      await vi.waitFor(() => { expect(errors).toEqual([]); expect(ids).toHaveLength(count); });
    },
  };
}

async function startSignedBatch<T>(fixtures: SignedFixture<T>[], boundary: ReturnType<typeof signedBoundary<T>>) {
  // Instrumented schedule, not natural HTTP/crypto completion timing.
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const startedAt = Date.now();
  const owners = fixtures.map(f => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controllers.push(controller);
      cleanup.push(() => { try { controller.error(Error('reverse fixture cleanup')); } catch {} });
    } });
    const request = new Request(f.request.url, { method: 'POST', headers: f.request.headers, body, duplex: 'half' } as RequestInit);
    return { ...f, ...start(request) };
  });
  expectAllHeld(owners);
  for (let index = 15; index >= 0; index--) {
    // Explicitly fail a missed schedule; never extend the existing body budget.
    expect(Date.now() - startedAt).toBeLessThan(5000);
    controllers[index].enqueue(fixtures[index].body); controllers[index].close();
    await boundary.wait(16 - index);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(boundary.ids[15 - index]).toBe(fixtures[index].id);
    expectAllHeld(owners);
  }
  expect(boundary.ids).toEqual(fixtures.map(f => f.id).reverse());
  expect(vi.getTimerCount()).toBe(0);
  return owners;
}

function expectAllHeld<T>(owners: SignedOwner<T>[]) {
  expect(owners).toHaveLength(16);
  for (const owner of owners) { expect(owner.result.error).toBeUndefined(); expect(owner.result.response).toBeUndefined(); }
}

async function expectSelectedResponse<T>(owners: SignedOwner<T>[], selected: SignedOwner<T>, status: number) {
  await vi.waitFor(() => {
    for (const owner of owners) expect(owner.result.error).toBeUndefined();
    expect(selected.result.response?.status).toBe(status);
    expect(owners.filter(owner => owner.result.response !== undefined)).toHaveLength(1);
    expect(owners.filter(owner => owner !== selected && owner.result.response === undefined)).toHaveLength(15);
  });
}

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
  worker = (await import('../src/index')).default;
  pending = []; cleanup = [];
  lookup = vi.fn(async () => new Response(null, { status: 204 }));
  db = vi.fn(() => { throw Error('forbidden D1 work'); });
  env = { TELNYX_PUBLIC_KEY: publicKey, TELNYX_CONNECTION_ID: 'connection', TELNYX_ENABLED: 'false',
    TELNYX_CALL: { idFromName: (name: string) => name, get: () => ({ fetch: lookup }) }, DB: { prepare: db } } as unknown as Env;
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('forbidden outbound work'); }));
});
afterEach(async () => {
  for (const finish of cleanup) finish();
  await Promise.all(pending);
  expect(db).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers();
});

describe('aggregate public webhook lease ownership', () => {
  it('rejects request17 before reader, buffer, timer or cancellation allocation', async () => {
    const ByteArray = Uint8Array;
    let buffers = 0;
    vi.stubGlobal('Uint8Array', new Proxy(ByteArray, { construct(target, args) {
      if (args[0] === 131072) buffers++;
      return Reflect.construct(target, args);
    } }));
    const owners = fill(); await tick();
    expect(owners.every(owner => owner.getReader.mock.calls.length === 1)).toBe(true);
    expect(buffers).toBe(16); expect(vi.getTimerCount()).toBe(16);
    await probe(503);
    expect(buffers).toBe(16); expect(vi.getTimerCount()).toBe(16);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('shares its module budget across separate router registrations', async () => {
    fill(); await tick();
    const other = new Hono<{ Bindings: Env; Variables: { userId: string } }>();
    (await import('../src/telnyx-routes')).registerTelnyxRoutes(other);
    await probe(503, other as unknown as typeof worker);
  });

  it.each(['consume-first', 'cancel-first'] as const)('does not refill on timeout or partial cleanup: %s', async order => {
    const owners = fill(); await vi.advanceTimersByTimeAsync(5000);
    expect(owners.map(owner => owner.result.response?.status)).toEqual(Array(16).fill(408));
    expect(vi.getTimerCount()).toBe(0);
    await probe(503);
    const one = owners[0];
    if (order === 'consume-first') one.readResult.resolve({ done: true }); else one.cancelResult.resolve();
    await tick(); await probe(503);
    if (order === 'consume-first') one.cancelResult.resolve(); else one.readResult.resolve({ done: true });
    await tick(); await probe(400);
    // Reuse that one slot, then repeat old settlement callbacks. No second
    // credit may appear for the newly held owner.
    const replacement = heldReader(); start(replacement.request); await tick();
    one.readResult.resolve({ done: true }); one.cancelResult.resolve();
    await tick(); await probe(503);
    expect(one.reader.cancel).toHaveBeenCalledTimes(1); expect(one.reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('retains real-stream cancellation work even when cancel resolves the pending read', async () => {
    fill({}, 15);
    const cancel = deferred<void>(); let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel: () => cancel.promise });
    cleanup.push(() => { cancel.resolve(); try { controller.error(Error('fixture dispose')); } catch {} });
    const r = start(new Request(URL, { method: 'POST', body, duplex: 'half' } as RequestInit));
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.result.response?.status).toBe(408); expect(body.locked).toBe(false);
    await probe(503); cancel.resolve(); await tick(); await probe(400);
  });

  it.each(['reject', 'throw'] as const)('permanently quarantines cancellation %s after read settlement', async cancel => {
    const owners = fill({ cancel }); await vi.advanceTimersByTimeAsync(5000);
    expect(owners.map(owner => owner.result.response?.status)).toEqual(Array(16).fill(408));
    for (const owner of owners) owner.readResult.resolve({ done: true });
    await tick(); await probe(503);
    await vi.advanceTimersByTimeAsync(3600_000); await probe(503);
    expect(owners.every(owner => owner.reader.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('permanently quarantines failed lock release even after successful read and cancellation settlement', async () => {
    const owners = fill({ lockFails: true }); await vi.advanceTimersByTimeAsync(5000);
    for (const owner of owners) { owner.readResult.resolve({ done: true }); owner.cancelResult.resolve(); }
    await tick(); await probe(503);
    await vi.advanceTimersByTimeAsync(3600_000); await probe(503);
    expect(owners.every(owner => owner.reader.releaseLock.mock.calls.length === 1)).toBe(true);
  });

  it('does not retain capacity when getReader throws before a reader is acquired', async () => {
    for (let i = 0; i < 20; i++) {
      const req = new Request(URL, { method: 'POST', body: 'fixture' });
      Object.defineProperty(req, 'body', { value: { getReader() { throw Error('synthetic reader acquisition'); } } });
      const r = start(req); await r.settled;
      expect(r.result.response?.status).toBe(503); expect(r.result.response?.headers.get('Retry-After')).toBeNull();
    }
    await probe(400); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['pending', 'reject'] as const)('owns allocation failure after getReader with %s cancellation', async cancel => {
    fill({}, 15); await tick();
    const last = heldReader({ cancel });
    const ByteArray = Uint8Array;
    vi.stubGlobal('Uint8Array', new Proxy(ByteArray, { construct(target, args) {
      if (args[0] === 131072) throw Error('synthetic acquisition buffer allocation');
      return Reflect.construct(target, args);
    } }));
    const r = start(last.request); await r.settled;
    vi.stubGlobal('Uint8Array', ByteArray);
    expect(r.result.response?.status).toBe(503);
    expect(last.reader.read).not.toHaveBeenCalled(); expect(last.reader.cancel).toHaveBeenCalledTimes(1);
    expect(last.reader.releaseLock).toHaveBeenCalledTimes(1);
    await probe(503);
    last.cancelResult.resolve(); await tick();
    await probe(cancel === 'pending' ? 400 : 503);
  });

  it.each(['fulfill', 'reject'] as const)('holds completed signed bodies through durable dispatch %s', async completion => {
    const fixtures = await signedBatch<Response>();
    fixtures.forEach(f => cleanup.push(() => f.gate.resolve(new Response(null, { status: 204 }))));
    const boundary = signedBoundary(fixtures);
    lookup.mockImplementation(async (request: Request) => {
      const control = await request.json() as { id?: unknown };
      return boundary.enter(control.id);
    });
    const owners = await startSignedBatch(fixtures, boundary);
    expect(lookup).toHaveBeenCalledTimes(16); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(6000); await probe(503); // No downstream timeout.
    expectAllHeld(owners);
    const selected = owners[0];
    const arrivalOwner = owners.find(owner => owner.id === boundary.ids[0]);
    expect(arrivalOwner?.id).toBe('lease-fixture-15');
    if (!arrivalOwner) throw Error('Missing original-algorithm arrival owner');
    if (completion === 'fulfill') arrivalOwner.gate.resolve(new Response(null, { status: 204 })); else arrivalOwner.gate.reject(Error('synthetic dispatch failure'));
    await expectSelectedResponse(owners, arrivalOwner, completion === 'fulfill' ? 200 : 503);
    expect(selected.result.response).toBeUndefined();
    console.info('ORIGINAL_ALGORITHM_FINITE_OBSERVATION', JSON.stringify({
      arrivalOrder: boundary.ids, releasedId: arrivalOwner.id, awaitedId: selected.id,
      responses: owners.map(owner => ({ id: owner.id, status: owner.result.response?.status ?? null, error: owner.result.error === undefined ? null : String(owner.result.error) })),
    }));
    // Expected finite correlation assertion failure, NOT exact historical CI replay.
    await expectSelectedResponse(owners, selected, completion === 'fulfill' ? 200 : 503);
    expect(boundary.errors).toEqual([]);
    await probe(400);
  });

  it('holds completed bodies through cryptographic verification', async () => {
    const fixtures = await signedBatch<boolean>();
    fixtures.forEach(f => cleanup.push(() => f.gate.resolve(false)));
    const boundary = signedBoundary(fixtures);
    const verify = vi.spyOn(crypto.subtle, 'verify').mockImplementation((_algorithm, _key, _signature, data) => boundary.verifyInput(data));
    const owners = await startSignedBatch(fixtures, boundary);
    expect(verify).toHaveBeenCalledTimes(16);
    await probe(503); expectAllHeld(owners);
    const selected = owners[0];
    const arrivalOwner = owners.find(owner => owner.id === boundary.ids[0]);
    expect(arrivalOwner?.id).toBe('lease-fixture-15');
    if (!arrivalOwner) throw Error('Missing original-algorithm arrival owner');
    arrivalOwner.gate.resolve(false);
    await expectSelectedResponse(owners, arrivalOwner, 401);
    expect(selected.result.response).toBeUndefined();
    console.info('ORIGINAL_ALGORITHM_FINITE_OBSERVATION', JSON.stringify({
      arrivalOrder: boundary.ids, releasedId: arrivalOwner.id, awaitedId: selected.id,
      responses: owners.map(owner => ({ id: owner.id, status: owner.result.response?.status ?? null, error: owner.result.error === undefined ? null : String(owner.result.error) })),
    }));
    // Expected finite correlation assertion failure, NOT exact historical CI replay.
    await expectSelectedResponse(owners, selected, 401);
    expect(boundary.errors).toEqual([]);
    await probe(400);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('preserves configuration and missing-body precedence even at saturation', async () => {
    fill(); await tick();
    const empty = start(new Request(URL, { method: 'POST' })); await empty.settled;
    expect(empty.result.response?.status).toBe(400);
    env.TELNYX_PUBLIC_KEY = '';
    const fixture = heldReader(), r = start(fixture.request); await r.settled;
    expect(r.result.response?.status).toBe(503); expect(r.result.response?.headers.get('Retry-After')).toBeNull();
    expect(fixture.getReader).not.toHaveBeenCalled();
  });
});
