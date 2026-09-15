#!/usr/bin/env node
/** Integration-slot-only, local workerd/public-route body deadline probe.
 * Actual HTTP upload cases are separate from instrumented JS cancellation
 * fixtures. No production DO, D1, carrier, provider, account or deploy access.
 * Copy this unchanged to exact original source for finite negative observations.
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
const LIMIT = 128 * 1024, OBSERVE_MS = 7000;
const names = process.argv.find(arg => arg.startsWith('--case='))?.slice(7).split(',');
const cases = [
  { name: 'no-first-byte', mode: 'empty', status: 408 },
  { name: 'partial-no-eof', mode: 'partial', status: 408 },
  { name: 'trickle-no-eof', mode: 'trickle', status: 408 },
  { name: 'overflow-no-eof', mode: 'overflow', status: 413 },
  { name: 'signed-complete', mode: 'valid', status: 200, dispatch: 1 },
  { name: 'invalid-signature', mode: 'invalid', status: 401 },
  { name: 'wrong-application', mode: 'wrong', status: 403 },
  { name: 'durable-refusal', mode: 'refused', status: 503, dispatch: 1 },
  { name: 'synthetic-cancel-pending', mode: 'cancel-pending', status: 413, synthetic: true },
  { name: 'synthetic-cancel-reject', mode: 'cancel-reject', status: 413, synthetic: true },
].filter(test => !names || names.includes(test.name));
assert.ok(cases.length && (!names || names.every(name => cases.some(test => test.name === name))), 'unknown --case');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const key = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
const events = [], clients = new Set(), failures = [], passes = [], cleanupErrors = [];
let mf, temp, primary;

// This wrapper calls the unchanged public app. Boundaries are observed through
// an awaited test service. TELNYX_CALL is deliberately a synthetic acceptance
// stub; tests assert dispatch counts, not carrier owner persistence.
const entry = `
import worker from './src/index';
export * from './src/index';
const record = (env, data) => env.RECORD.fetch('https://fixture.invalid/record', {
  method: 'POST', body: JSON.stringify(data)
});
export default { ...worker, async fetch(request, env, ctx) {
  const url = new URL(request.url), name = url.searchParams.get('case');
  await record(env, { kind: 'entered', name, at: Date.now() });
  let cancelCalls = 0;
  if (name === 'synthetic-cancel-pending' || name === 'synthetic-cancel-reject') {
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(131073)); }, cancel() {
      cancelCalls++;
      return name.endsWith('pending') ? new Promise(() => {}) : Promise.reject(Error('synthetic cancel rejection'));
    } });
    request = new Request(request.url, { method: 'POST', headers: request.headers, body });
  }
  const local = { ...env, DB: { prepare() { throw Error('fixture forbids D1'); } },
    TELNYX_CALL: { idFromName: name => name, get: () => ({ async fetch() {
      await record(env, { kind: 'dispatch', name });
      return new Response(null, { status: name === 'durable-refusal' ? 503 : 204 });
    } }) }
  };
  const response = await worker.fetch(request, local, ctx);
  await record(env, { kind: 'response', name, at: Date.now(), status: response.status, cancelCalls });
  return response;
}};
`;

function signed(test) {
  const body = JSON.stringify({ data: { record_type: 'event', id: test.name,
    event_type: 'call.hangup', occurred_at: new Date().toISOString(), payload: {
      call_control_id: 'fixture-control', call_leg_id: 'fixture-leg', call_session_id: 'fixture-session',
      connection_id: test.mode === 'wrong' ? 'other' : 'fixture-connection', hangup_cause: 'normal_clearing',
    } } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { body, headers: { 'Content-Type': 'application/json', 'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': test.mode === 'invalid' ? 'invalid'
      : sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString('base64') } };
}

async function observe(url, test) {
  const data = signed(test), start = performance.now();
  let req, observationTimer, trickle, closeTimer, finish, closedResolve;
  let stopped = false;
  const closed = new Promise(resolve => { closedResolve = resolve; });
  const outcome = new Promise(resolve => { finish = value => {
    if (stopped) return;
    stopped = true; clearTimeout(observationTimer); clearInterval(trickle);
    resolve({ ...value, elapsedMs: performance.now() - start });
  }; });
  try {
    // This is an intentional finite observation boundary, NOT setup timeout or
    // fixture disposal. An ORIGINAL pending result is recorded before destroy.
    observationTimer = setTimeout(() => finish({ kind: 'pending-response-observed', observationMs: OBSERVE_MS }), OBSERVE_MS);
    req = httpRequest(url, { method: 'POST', headers: data.headers, agent: false }, res => {
      let bytes = 0, chunks = [];
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 4096) { finish({ kind: 'oversized-response' }); res.destroy(); }
        else chunks.push(chunk);
      });
      res.on('end', () => finish({ kind: 'response', status: res.statusCode,
        cache: res.headers['cache-control'], body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', error => finish({ kind: 'response-error', code: error.code || error.name }));
    });
    clients.add(req);
    req.on('close', () => { clients.delete(req); closedResolve(); });
    req.on('error', error => finish({ kind: 'client-error', code: error.code || error.name }));
    req.flushHeaders();
    if (test.mode === 'partial' || test.mode === 'trickle') req.write('{');
    if (test.mode === 'trickle') trickle = setInterval(() => req.write(' '), 700);
    if (test.mode === 'overflow') req.write(Buffer.alloc(LIMIT + 1));
    if (!['empty', 'partial', 'trickle', 'overflow'].includes(test.mode)) req.end(data.body);
    const observed = await outcome;
    const trace = events.filter(event => event.name === test.name);
    // Snapshot/log BEFORE destroying the client. A response caused by fixture
    // teardown cannot turn an original pending observation into a pass.
    console.log(JSON.stringify({ kind: 'observation', name: test.name,
      attribution: test.synthetic ? 'instrumented-workerd-JS-stream' : 'HTTP-upload-to-public-workerd', outcome: observed, trace }));
    return { outcome: observed, trace };
  } finally {
    clearTimeout(observationTimer); clearInterval(trickle);
    if (req) {
      req.destroy();
      try {
        await Promise.race([closed, new Promise((_, reject) => {
          closeTimer = setTimeout(() => reject(Error('owned client did not close')), 2000);
        })]);
      } finally { clearTimeout(closeTimer); }
    }
  }
}

try {
  const identity = {};
  for (const path of ['src/telnyx-routes.ts', 'src/telnyx-webhook.ts', 'scripts/telnyx-webhook-body-smoke.mjs']) {
    identity[path] = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex');
  }
  console.log(JSON.stringify({ kind: 'source-identity', identity, observationMs: OBSERVE_MS }));
  temp = await mkdtemp(resolve(tmpdir(), 'openfon-webhook-body-runtime-'));
  const bundle = await build({ stdin: { resolveDir: root, loader: 'ts', contents: entry }, bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', write: false, external: ['cloudflare:*'] });
  mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 8810, inspectorPort: 9250,
    defaultPersistRoot: temp, cf: false, workers: [{ name: 'openfon', modules: true,
      script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-01',
      bindings: { TELNYX_ENABLED: 'false', TELNYX_PUBLIC_KEY: key, TELNYX_CONNECTION_ID: 'fixture-connection' },
      outboundService: () => { throw Error('fixture forbids outbound traffic'); },
      serviceBindings: { RECORD: async request => { events.push(await request.json()); return new Response(null, { status: 204 }); } },
    }] }));
  const ready = await mf.ready;
  console.log(JSON.stringify({ kind: 'runtime-ready', host: new URL(ready).hostname, port: new URL(ready).port }));
  for (const test of cases) {
    const url = new URL('/api/telnyx/webhooks', ready); url.searchParams.set('case', test.name);
    assert.equal(url.hostname, '127.0.0.1');
    try {
      const { outcome, trace } = await observe(url, test);
      if (!trace.some(event => event.kind === 'entered')) {
        primary = Error('fixture did not reach public handler: ' + test.name);
        throw primary;
      }
      assert.equal(outcome.kind, 'response', 'application response within finite observation');
      assert.equal(outcome.status, test.status);
      assert.equal(outcome.cache, 'no-store');
      const response = trace.find(event => event.kind === 'response');
      assert.equal(response?.status, test.status, 'public handler response matches client');
      assert.equal(trace.filter(event => event.kind === 'dispatch').length, test.dispatch || 0);
      if (test.synthetic) assert.equal(response.cancelCalls, 1);
      if (test.status === 408) {
        const entered = trace.find(event => event.kind === 'entered');
        assert.ok(response.at - entered.at >= 4900, 'not an immediate pre-body refusal');
      }
      passes.push(test.name);
    } catch (error) {
      if (primary) throw error;
      failures.push({ name: test.name, error: error.message });
      console.log(JSON.stringify({ kind: 'case-failure', name: test.name, error: error.message }));
      if (clients.size) throw Error('client cleanup incomplete; stop before next case');
    }
  }
} catch (error) {
  primary = error;
  console.error(JSON.stringify({ kind: 'fixture-failure', error: error.message }));
} finally {
  for (const client of clients) client.destroy();
  try { await mf?.dispose(); } catch (error) { cleanupErrors.push('runtime disposal: ' + error.message); }
  try { if (temp) await rm(temp, { recursive: true, force: true }); } catch (error) { cleanupErrors.push('temp disposal: ' + error.message); }
  console.log(JSON.stringify({ kind: 'cleanup', runtimeDisposed: !!mf && cleanupErrors.length === 0,
    clientsRemaining: clients.size, cleanupErrors }));
}
console.log(JSON.stringify({ kind: 'summary', passes, failures, fixtureFailure: primary?.message || null }));
if (primary || failures.length || cleanupErrors.length || clients.size) process.exitCode = 1;
