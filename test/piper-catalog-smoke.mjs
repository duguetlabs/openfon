#!/usr/bin/env node
// Source-prepared request-context probe. Run only under integration's sole grant.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('request-context probe did not settle within 4 seconds')), 4000);
    })]);
  } finally { clearTimeout(timer); }
}
const worker = `
import { piperVoiceFromCatalog } from './src/piper-catalog';
// Test-only observation after native fetch has delivered headers to this Worker.
// Store scalar data only; no cross-context resolver/Response is retained here.
const headersSeen = new Set();
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  headersSeen.add(new URL(typeof args[0] === 'string' ? args[0] : args[0].url).pathname);
  return response;
};
async function lookup(request) {
  const url = new URL(request.url);
  const result = await piperVoiceFromCatalog('wss://catalog.test/' + url.searchParams.get('endpoint'), url.searchParams.get('lang') || 'en', 'fallback');
  return Response.json({ result });
}
export class CatalogProbe { async fetch(request) { return lookup(request); } }
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/headers') return Response.json({ seen: headersSeen.has('/' + url.searchParams.get('endpoint') + '/voices') });
  if (url.pathname.startsWith('/do/')) return env.PROBES.get(env.PROBES.idFromName(url.pathname)).fetch(request);
  return lookup(request);
}};
`;
const temp = await mkdtemp(resolve(tmpdir(), 'openfon-piper-context-'));
let mf;
const counts = new Map();
const bodyTimers = new Set();
const finishedBodies = new Set();
try {
  const bundled = await build({ stdin: { contents: worker, resolveDir: process.cwd(), sourcefile: 'piper-catalog-probe.ts', loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, port: Number(process.env.OPENFON_TEST_PORT || 8813), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9253), cf: false,
    workers: [{ name: 'probe', modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-05-01', durableObjects: { PROBES: 'CatalogProbe' },
      outboundService: async request => {
        const path = new URL(request.url).pathname;
        const attempt = (counts.get(path) || 0) + 1;
        counts.set(path, attempt);
        const bytes = new TextEncoder().encode(JSON.stringify({ 'kataleptic-realtime': { voices_by_language: { en: 'en_runtime', de: 'de_runtime' } } }));
        if (attempt === 1 && path.includes('http-failure')) return new Response(null, { status: 503 });
        if (path.includes('body-pending') || (attempt === 1 && (path.includes('deadline') || path.includes('body-failure')))) {
          let timer;
          return new Response(new ReadableStream({
            start(controller) {
              // Headers and a prefix arrive now; the rest stays pending.
              controller.enqueue(bytes.slice(0, 1));
              timer = setTimeout(() => {
                bodyTimers.delete(timer);
                finishedBodies.add(path);
                if (path.includes('body-failure')) controller.error(new Error('synthetic body failure'));
                else { controller.enqueue(bytes.slice(1)); controller.close(); }
              }, path.includes('deadline') ? 2500 : 400);
              bodyTimers.add(timer);
            },
            cancel() { clearTimeout(timer); bodyTimers.delete(timer); },
          }));
        }
        // No cross-request promise resolvers in the synthetic upstream.
        await delay(200);
        return new Response(bytes);
      } }] }));
  const waitForFetch = async endpoint => {
    const until = Date.now() + 2000;
    while (!counts.has('/' + endpoint + '/voices')) {
      assert.ok(Date.now() < until, 'first catalog request did not start');
      await delay(1);
    }
  };
  const read = async response => {
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).result;
  };
  for (const kind of ['requests', 'objects']) {
    const endpoint = kind;
    const url = i => `http://probe/${kind === 'objects' ? 'do/' + i : 'request'}?endpoint=${endpoint}&lang=${i % 2 ? 'de' : 'en'}`;
    let ownerSettled = false;
    const first = mf.dispatchFetch(url(0)).then(read).then(result => { ownerSettled = true; return result; });
    await waitForFetch(endpoint);
    const others = Array.from({ length: 15 }, (_, i) => mf.dispatchFetch(url(i + 1)));
    const results = await within(Promise.all(others.map(p => p.then(read))));
    assert.deepEqual(results, Array(15).fill('fallback'));
    assert.equal(ownerSettled, false, 'followers waited for the initiating request');
    assert.equal(await within(first), 'en_runtime');
    assert.equal(await within(mf.dispatchFetch(url(1)).then(read)), 'de_runtime');
    assert.equal(counts.get('/' + endpoint + '/voices'), 1);
    console.log('PASS', kind, 'one owner / 15 immediate fallbacks / settled cache shared');
  }
  for (const kind of ['requests', 'objects']) {
    const endpoint = 'body-pending-' + kind;
    const url = i => `http://probe/${kind === 'objects' ? 'do/body-' + i : 'request'}?endpoint=${endpoint}&lang=${i ? 'de' : 'en'}`;
    const first = mf.dispatchFetch(url(0)).then(read);
    const until = Date.now() + 2000;
    for (;;) {
      const state = await mf.dispatchFetch('http://probe/headers?endpoint=' + endpoint);
      if ((await state.json()).seen) break;
      assert.ok(Date.now() < until, 'Worker did not observe catalog headers');
      await delay(1);
    }
    assert.ok(!finishedBodies.has('/' + endpoint + '/voices'), 'body finished before follower could join');
    const follower = mf.dispatchFetch(url(1)).then(read);
    assert.equal(await within(follower), 'fallback');
    assert.ok(!finishedBodies.has('/' + endpoint + '/voices'), 'follower waited for body completion');
    assert.equal(await within(first), 'en_runtime');
    assert.equal(await within(mf.dispatchFetch(url(1)).then(read)), 'de_runtime');
    assert.equal(counts.get('/' + endpoint + '/voices'), 1);
    console.log('PASS', kind, 'immediate fallback after native headers / pending body / settled cache shared');
  }
  for (const failure of ['http-failure', 'body-failure', 'deadline']) {
    const url = `http://probe/request?endpoint=${failure}`;
    assert.equal(await within(mf.dispatchFetch(url).then(read)), 'fallback');
    assert.equal(await within(mf.dispatchFetch(url).then(read)), 'en_runtime');
    assert.equal(counts.get('/' + failure + '/voices'), 2);
    console.log('PASS', failure, 'native failure then fresh successful lookup');
  }
  // Client-facing AbortError is observable, but still does not establish that
  // the initiating workerd IoContext was destroyed or its I/O cancelled.
  const abort = new AbortController();
  const initiator = mf.dispatchFetch('http://probe/request?endpoint=cancelled', { signal: abort.signal }).then(
    response => ({ outcome: 'completed', response }),
    error => ({ outcome: 'rejected', name: error.name }),
  );
  await waitForFetch('cancelled');
  const follower = mf.dispatchFetch('http://probe/request?endpoint=cancelled&lang=de').then(read);
  abort.abort();
  assert.equal(await within(follower), 'fallback');
  const outcome = await within(initiator);
  if (outcome.outcome === 'rejected') {
    assert.equal(outcome.name, 'AbortError', 'initiator rejected for a reason other than cancellation');
    console.log('OBSERVED client AbortError / immediate follower fallback; context destruction NOT proven');
  } else {
    assert.equal(await read(outcome.response), 'en_runtime');
    console.log('UNSUPPORTED cancellation propagation: initiator completed normally despite abort; no cancellation PASS claimed');
  }
  assert.equal(counts.get('/cancelled/voices'), 1);
  console.log('UNPROVEN initiating Durable Object cancellation/destruction; this probe does not exercise it');

} finally {
  await mf?.dispose();
  for (const timer of bodyTimers) clearTimeout(timer);
  await rm(temp, { recursive: true, force: true });
}
