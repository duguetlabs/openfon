#!/usr/bin/env node
/** Integration-slot-only local public-workerd admission probe. No live traffic.
 * Same unchanged harness runs on exact original and fixed source. Each scenario
 * creates/disposes its own isolate because production quarantine has no reset.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const names = process.argv.find(arg => arg.startsWith('--case='))?.slice(7).split(',');
const scenarios = ['http-saturation', 'held-cancel', 'failed-lock', 'held-dispatch'].filter(name => !names || names.includes(name));
assert.ok(scenarios.length && (!names || names.every(name => scenarios.includes(name))), 'unknown --case');
const keys = generateKeyPairSync('ed25519');
const key = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
const failures = [], passes = [], unavailable = [], cleanupErrors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Instrumentation wraps the actual HTTP body's reader for http-saturation.
// held-cancel/failed-lock use synthetic independent read/cancel methods backed
// by Node service gates. A lock shim is not native transport behavior.
const entry = `
import worker from './src/index';
export * from './src/index';
const records = new Map(); let buffers = 0;
const ByteArray = Uint8Array;
globalThis.Uint8Array = new Proxy(ByteArray, { construct(target, args) {
  if (args[0] === 131072) buffers++;
  return Reflect.construct(target, args);
}});
export default { ...worker, async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/fixture/stats') return Response.json({ buffers, records: [...records.values()] });
  const id = url.searchParams.get('id'), mode = url.searchParams.get('mode');
  const record = { id, mode, readers: 0, reads: 0, readState: 'none', cancelState: 'none', lockState: 'none', dispatch: 0, response: null };
  records.set(id, record);
  const original = request.body;
  if (original) Object.defineProperty(request, 'body', { value: { getReader() {
    record.readers++;
    const synthetic = mode === 'held-cancel' || mode === 'failed-lock';
    const raw = synthetic ? {
      read: () => env.GATES.fetch('https://gate/read/' + id).then(() => ({ done: true })),
      cancel: () => env.GATES.fetch('https://gate/cancel/' + id).then(() => {}),
      releaseLock() { if (mode === 'failed-lock') throw Error('synthetic releaseLock'); }
    } : original.getReader();
    return {
      read() { record.reads++; record.readState = 'pending'; return raw.read().then(value => {
        record.readState = 'settled'; return value;
      }, error => { record.readState = 'rejected'; throw error; }); },
      cancel() { record.cancelState = 'pending'; return raw.cancel().then(value => {
        record.cancelState = 'fulfilled'; return value;
      }, error => { record.cancelState = 'rejected'; throw error; }); },
      releaseLock() { try { raw.releaseLock(); record.lockState = 'released'; }
        catch (error) { record.lockState = 'failed'; throw error; } }
    };
  } } });
  const local = { ...env, DB: { prepare() { throw Error('forbidden D1'); } }, TELNYX_CALL: {
    idFromName: name => name, get: () => ({ async fetch() {
      record.dispatch++;
      if (mode === 'held-dispatch') await env.GATES.fetch('https://gate/dispatch/' + id);
      return new Response(null, { status: 204 });
    } })
  } };
  const response = await worker.fetch(request, local, ctx);
  record.response = response.status;
  return response;
}};
`;

function validBody() {
  const body = JSON.stringify({ data: { id: 'admission-fixture', record_type: 'event', event_type: 'call.hangup',
    occurred_at: new Date().toISOString(), payload: { call_control_id: 'control', call_leg_id: 'leg', call_session_id: 'session',
      connection_id: 'connection', hangup_cause: 'normal_clearing' } } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { body, headers: { 'Content-Type': 'application/json', 'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': sign(null, Buffer.from(timestamp + '|' + body), keys.privateKey).toString('base64') } };
}

function open(url, body, headers, clients) {
  let state = null, doneResolve, closeResolve;
  const done = new Promise(resolve => { doneResolve = resolve; });
  const closed = new Promise(resolve => { closeResolve = resolve; });
  const finish = result => { if (state) return; state = result; doneResolve(result); };
  const req = httpRequest(url, { method: 'POST', headers, agent: false }, response => {
    let size = 0; const chunks = [];
    response.on('data', chunk => { size += chunk.length;
      if (size > 4096) { finish({ kind: 'response-too-large' }); response.destroy(); } else chunks.push(chunk); });
    response.on('end', () => finish({ kind: 'response', status: response.statusCode,
      retryAfter: response.headers['retry-after'] || null, cache: response.headers['cache-control'] || null,
      body: Buffer.concat(chunks).toString('utf8') }));
    response.on('error', error => finish({ kind: 'response-error', code: error.code || error.name }));
  });
  clients.add(req);
  req.on('error', error => finish({ kind: 'client-error', code: error.code || error.name }));
  req.on('close', () => { clients.delete(req); closeResolve(); });
  req.flushHeaders(); if (body !== null) req.end(body);
  return { req, closed, done, state: () => state };
}
async function observe(handle, ms) {
  let timer;
  try { return await Promise.race([handle.done, new Promise(resolve => {
    timer = setTimeout(() => resolve({ kind: 'pending-response-observed', observationMs: ms }), ms);
  })]); } finally { clearTimeout(timer); }
}
async function waitFor(predicate, ms = 2500) {
  const until = performance.now() + ms;
  do { if (await predicate()) return true; await sleep(20); } while (performance.now() < until);
  return false;
}

scenariosLoop: for (const scenario of scenarios) {
  let mf, temp, fixtureFailure = null;
  const gates = new Map(), clients = new Set(), handles = [];
  const release = (kind, id) => gates.get('/' + kind + '/' + id)?.resolve();
  try {
    const identity = {};
    for (const name of ['src/telnyx-routes.ts', 'src/telnyx-webhook-admission.ts', 'scripts/telnyx-webhook-admission-smoke.mjs']) {
      try { identity[name] = createHash('sha256').update(await readFile(resolve(root, name))).digest('hex'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; identity[name] = null; }
    }
    console.log(JSON.stringify({ kind: 'source', scenario, identity }));
    temp = await mkdtemp(resolve(tmpdir(), 'openfon-webhook-admission-runtime-'));
    const bundle = await build({ stdin: { resolveDir: root, loader: 'ts', contents: entry }, bundle: true,
      format: 'esm', platform: 'browser', target: 'es2022', write: false, external: ['cloudflare:*'] });
    mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 8810, inspectorPort: 9250,
      defaultPersistRoot: temp, cf: false, workers: [{ name: 'openfon', modules: true, script: bundle.outputFiles[0].text,
        compatibilityDate: '2026-05-01', bindings: { TELNYX_ENABLED: 'false', TELNYX_PUBLIC_KEY: key, TELNYX_CONNECTION_ID: 'connection' },
        outboundService: () => { throw Error('forbidden outbound'); },
        serviceBindings: { GATES: request => {
          const path = new URL(request.url).pathname;
          return new Promise(resolve => { gates.set(path, { resolve: () => resolve(new Response(null, { status: 204 })) }); });
        } },
      }] }));
    const ready = await mf.ready; assert.equal(new URL(ready).hostname, '127.0.0.1');
    const stats = async () => {
      const response = await fetch(new URL('/fixture/stats', ready), { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200); return response.json();
    };
    const send = (id, mode = scenario, body = null, headers = {}) => {
      const url = new URL('/api/telnyx/webhooks', ready); url.searchParams.set('id', id); url.searchParams.set('mode', mode);
      const handle = open(url, body, headers, clients); handles.push(handle); return handle;
    };
    // Nonempty entity guarantees a body exists: missing-body400 intentionally
    // precedes admission. If admitted, this probe ends at content-type415.
    const probe = id => send(id, 'probe', '!', { 'Content-Type': 'text/plain' });
    const signed = validBody();
    const owners = Array.from({ length: 16 }, (_, id) => scenario === 'held-dispatch'
      ? send(String(id), scenario, signed.body, signed.headers) : send(String(id)));
    const started = await waitFor(async () => {
      const s = await stats(); return s.records.filter(record => scenario === 'held-dispatch' ? record.dispatch === 1 : record.readers === 1).length === 16;
    });
    if (!started) { fixtureFailure = 'sixteen owners did not reach selected boundary'; throw Error(fixtureFailure); }
    const extra = probe('extra');
    const admission = await observe(extra, 1500), initial = await stats();
    console.log(JSON.stringify({ kind: 'admission-observation', scenario, admission, initial }));
    assert.equal(admission.kind, 'response'); assert.equal(admission.status, 503);
    assert.equal(admission.retryAfter, '1'); assert.equal(admission.cache, 'no-store');
    assert.equal(initial.records.find(record => record.id === 'extra')?.readers, 0);
    assert.equal(initial.buffers, 16);
    if (scenario === 'held-dispatch') {
      await sleep(5500);
      console.log(JSON.stringify({ kind: 'held-route-observation', scenario, states: owners.map(handle => handle.state()), stats: await stats() }));
      assert.ok(owners.every(handle => handle.state() === null), 'no new downstream deadline');
      release('dispatch', '0'); assert.equal((await observe(owners[0], 2000)).status, 200);
    } else {
      const observed = await Promise.all(owners.map(handle => observe(handle, 6500)));
      const afterTimeout = await stats();
      console.log(JSON.stringify({ kind: 'timeout-observation', scenario, observed, afterTimeout }));
      assert.ok(observed.every(result => result.kind === 'response' && result.status === 408));
      if (scenario !== 'http-saturation') {
        const retained = await observe(probe('retained'), 1500);
        console.log(JSON.stringify({ kind: 'retention-observation', scenario, retained }));
        assert.equal(retained.status, 503);
        release('read', '0'); release('cancel', '0');
        const callbacksObserved = await waitFor(async () => {
          const record = (await stats()).records.find(record => record.id === '0');
          return ['settled', 'rejected'].includes(record.readState) && record.cancelState === 'fulfilled';
        });
        const settled = await stats();
        console.log(JSON.stringify({ kind: 'late-settlement-observation', scenario, callbacksObserved, settled }));
        if (!callbacksObserved) {
          // Workerd can destroy the request context after the408, leaving a
          // stranded lease. Do not call this proof of successful late release.
          unavailable.push({ scenario, boundary: 'late fulfillment callbacks after request-context teardown' });
          continue;
        }
        if (scenario === 'failed-lock') {
          assert.equal(settled.records.find(record => record.id === '0').lockState, 'failed');
          assert.equal((await observe(probe('quarantine'), 1500)).status, 503);
          passes.push(scenario); continue;
        }
      }
    }
    const refill = await observe(probe('refill'), 1500);
    console.log(JSON.stringify({ kind: 'refill-observation', scenario, refill, stats: await stats() }));
    assert.equal(refill.status, 415); passes.push(scenario);
  } catch (error) {
    failures.push({ scenario, classification: fixtureFailure ? 'fixture' : 'assertion-or-transport', error: error.message });
    console.error(JSON.stringify({ kind: 'failure', scenario, fixtureFailure, error: error.message }));
  } finally {
    for (const gate of gates.values()) gate.resolve();
    for (const handle of handles) handle.req.destroy();
    try {
      const closed = await waitFor(() => clients.size === 0, 2000);
      if (!closed) cleanupErrors.push(scenario + ': clients did not close');
    } catch (error) { cleanupErrors.push(scenario + ': client cleanup ' + error.message); }
    let disposed = false;
    try { await mf?.dispose(); disposed = !!mf; } catch (error) { cleanupErrors.push(scenario + ': runtime disposal ' + error.message); }
    try { if (temp) await rm(temp, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(scenario + ': temp disposal ' + error.message); }
    console.log(JSON.stringify({ kind: 'cleanup', scenario, disposed, clientsRemaining: clients.size, cleanupErrors }));
    if (cleanupErrors.length) break scenariosLoop;
  }
}
console.log(JSON.stringify({ kind: 'summary', passes, unavailable, failures, cleanupErrors }));
if (failures.length || cleanupErrors.length) process.exitCode = 1;
