#!/usr/bin/env node
// Source-only until integration grants the sole slot. Synthetic loopback HTTP
// exposes actual transport close; first response bodies NEVER finish naturally.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ': 4s harness ceiling')), 4000);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitFor(predicate, label, timeout = 1000) {
  const until = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < until, label);
    await delay(1);
  }
}
const worker = `
import { piperVoiceFromCatalog } from './src/piper-catalog';
async function lookup(request, env) {
  const endpoint = new URL(request.url).searchParams.get('endpoint');
  return Response.json({ result: await piperVoiceFromCatalog(env.UPSTREAM + '/' + endpoint, 'en', 'fallback') });
}
export class CatalogProbe {
  constructor(_state, env) { this.env = env; }
  async fetch(request) { return lookup(request, this.env); }
}
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/do/')) return env.PROBES.get(env.PROBES.idFromName(url.pathname)).fetch(request);
  return lookup(request, env);
}};
`;
const records = [];
const attempts = new Map();
let active = 0, peak = 0;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://loopback').pathname;
  const attempt = (attempts.get(path) || 0) + 1;
  attempts.set(path, attempt);
  const record = { path, attempt, openedAt: performance.now(), closedAt: null, finishedAt: null, closedWithoutFinish: false };
  records.push(record);
  active++; peak = Math.max(peak, active);
  response.on('finish', () => { record.finishedAt = performance.now(); });
  response.on('close', () => {
    record.closedAt = performance.now();
    record.closedWithoutFinish = !response.writableFinished;
    active--;
  });
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  if (attempt === 1) {
    response.flushHeaders();
    response.write('{');
    // Intentionally no timer/end/error: only cancellation/connection close can
    // stop this body before finally disposes the harness. Never natural finish.
  } else {
    response.end(JSON.stringify({ 'kataleptic-realtime': { voices_by_language: { en: 'en_recovered' } } }));
  }
});
const temp = await mkdtemp(resolve(tmpdir(), 'openfon-piper-native-deadline-'));
let mf;
try {
  // One ephemeral loopback-only upstream port, in addition to8813/9253.
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const bundled = await build({ stdin: { contents: worker, resolveDir: process.cwd(), sourcefile: 'piper-native-deadline.ts', loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp,
    port: Number(process.env.OPENFON_TEST_PORT || 8813), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9253), cf: false,
    workers: [{ name: 'probe', modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-05-01', durableObjects: { PROBES: 'CatalogProbe' },
      bindings: { UPSTREAM: 'ws://127.0.0.1:' + address.port } }] }));
  const call = (endpoint, object = '') => mf.dispatchFetch('http://probe/' + (object ? 'do/' + object : 'request') + '?endpoint=' + endpoint).then(async response => {
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).result;
  });

  await mf.ready;

  // An ignored abort would leave this body open forever, hitting the watchdog;
  // stale-result rejection cannot produce a false pass through natural finish.
  const started = performance.now();
  const first = call('never-finishes');
  assert.equal(await within(first, 'nonfinishing owner'), 'fallback');
  const elapsedMs = performance.now() - started;
  const old = records.find(record => record.path === '/never-finishes/voices');
  assert.ok(old, 'native upstream was not reached');
  await waitFor(() => old.closedAt !== null, 'native abort did not close upstream response');
  assert.equal(old.finishedAt, null, 'old body unexpectedly finished naturally');
  assert.equal(old.closedWithoutFinish, true, 'old body did not terminate by transport close');
  // Scheduling tolerance is reported separately; the body has no completion
  // path, so this does not substitute a later natural finish for native abort.
  assert.ok(elapsedMs < 2200, 'fallback did not occur near the unchanged1500ms deadline');
  assert.equal(await within(call('never-finishes'), 'retry after cancellation'), 'en_recovered');
  const retry = records.find(record => record.path === old.path && record.attempt === 2);
  assert.ok(retry && old.closedAt <= retry.openedAt, 'retry opened before old transport closed');
  console.log('PASS nonfinishing body cancelled before retry', JSON.stringify({ elapsedMs, oldBodyLifetimeMs: old.closedAt - old.openedAt, naturalFinish: false }));

  await waitFor(() => active === 0, 'previous response remained active');
  peak = 0;
  const owners = [];
  const settled = new Set();
  const dispatchAt = performance.now();
  for (let i = 0; i < 32; i++) {
    owners.push(call('boundary-' + i, 'boundary-' + i).then(result => { settled.add(i); return result; }));
  }
  // Attach a rejection handler immediately so a later disposal cannot create
  // unrelated unhandled promise output while preserving the original failure.
  const allOwners = Promise.all(owners);
  void allOwners.catch(() => {});
  await waitFor(() => records.filter(r => r.path.startsWith('/boundary-')).length === 32, '32 first bodies did not overlap');
  assert.equal(active, 32);
  assert.equal(await within(call('overflow', 'overflow'), 'capacity refusal'), 'fallback');
  assert.equal(attempts.has('/overflow/voices'), false, 'overflow reached the upstream');

  // Try the first endpoint at its expiry boundary, recording whether its owner
  // has actually settled at each attempt. Early attempts must fall back. Once
  // admitted, assert observed physical response work never exceeded32 and the
  // replacement did not overlap its old transport. No forced DO death claimed.
  await delay(Math.max(0, dispatchAt + 1500 - performance.now()));
  const observations = [];
  let replacement;
  const until = performance.now() + 1000;
  do {
    observations.push({ atMs: performance.now() - dispatchAt, oldOwnerSettled: settled.has(0), activeBefore: active });
    replacement = await within(call('boundary-0', 'replacement'), 'boundary replacement');
    if (replacement === 'fallback') await delay(1);
  } while (replacement === 'fallback' && performance.now() < until);
  assert.equal(replacement, 'en_recovered', 'no replacement admitted after expiry');
  assert.deepEqual(await within(allOwners, 'original32 deadlines'), Array(32).fill('fallback'));
  await waitFor(() => active === 0, 'boundary transports remained open');
  const oldBoundary = records.find(r => r.path === '/boundary-0/voices' && r.attempt === 1);
  const newBoundary = records.find(r => r.path === '/boundary-0/voices' && r.attempt === 2);
  assert.ok(oldBoundary && newBoundary && oldBoundary.closedAt !== null);
  assert.ok(oldBoundary.closedAt <= newBoundary.openedAt, 'replacement began before its old physical response closed');
  for (const record of records.filter(r => r.path.startsWith('/boundary-') && r.attempt === 1)) {
    assert.equal(record.finishedAt, null);
    assert.equal(record.closedWithoutFinish, true);
  }
  assert.ok(peak <= 32, 'physical response overlap exceeded32');
  console.log('PASS observed expiry boundary', JSON.stringify({ physicalPeak: peak, observations,
    replacementAfterOldCloseMs: newBoundary.openedAt - oldBoundary.closedAt,
    oldOwnerUnsettledAttemptObserved: observations.some(item => !item.oldOwnerSettled) }));
  console.log('LIMIT: observed native cancellation/order only; no forced initiating-DO destruction or universal scheduling proof');
} finally {
  await mf?.dispose();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
