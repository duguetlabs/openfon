#!/usr/bin/env node
/** Test-only actual ws -> public workerd -> real AsteriskCall/D1/PBKDF2.
 * CALL_SESSION is an accepted synthetic socket: no provider/audio/PBX claim.
 * Run only with the integration slot. Copy unchanged to the exact original
 * snapshot for negatives; this harness never imports the new protocol parser.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('../', import.meta.url));
const filter = process.argv.find(arg => arg.startsWith('--case='))?.slice(7).split(',');
const cases = [
  { name: 'no-offer', selected: null },
  { name: 'media', protocols: ['media'], selected: 'media' },
  { name: 'media-last', protocols: ['other', 'media'], selected: 'media' },
  { name: 'media-first', protocols: ['media', 'other'], selected: 'media' },
  { name: 'unsupported', protocols: ['other'], status: 400 },
  { name: 'case-sensitive', protocols: ['MEDIA'], status: 400 },
  { name: 'substring', protocols: ['premedia'], status: 400 },
  { name: 'present-empty', rawOffer: '', status: 400, boundary: true },
  { name: 'whitespace-empty', rawOffer: ' \t ', normalizedOffer: '', status: 400, boundary: true },
  { name: 'trailing-empty', rawOffer: 'media,', status: 400 },
  { name: 'invalid-remainder', rawOffer: 'media,bad/token', status: 400 },
  { name: 'duplicate-remainder', rawOffer: 'media,other,other', status: 400 },
  { name: 'forged-binding-no-auth', auth: 'absent', status: 401 },
  { name: 'wrong-auth-media', protocols: ['media'], auth: 'wrong', status: 401 },
  // These two are client-local controls, never evidence of server refusal.
  { name: 'client-duplicate-control', protocols: ['media', 'media'], local: true },
  { name: 'client-newline-control', rawOffer: 'media,other\n', local: true },
].filter(test => !filter || filter.includes(test.name));
assert.ok(cases.length && (!filter || filter.every(name => cases.some(test => test.name === name))), 'Unknown --case name');
const password = 'synthetic_Negotiation_01234567890123456789';
const authorization = 'Basic ' + Buffer.from('pbx:' + password).toString('base64');
const events = [], sockets = new Set(), failures = [], unavailable = [], passes = [], cleanupErrors = [];
let mf, temp, primary, executed = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(20); }
  throw Error('Fixture cleanup timeout: ' + label);
}

// Explicit exports override no product class. The real AsteriskCall receives
// unchanged requests/environment except the test-only CALL_SESSION binding.
const entry = `
import worker from './src/index';
import { AsteriskCall } from './src/asterisk-control';
export * from './src/index';
const record = (env, value) => env.RECORD.fetch('https://fixture.invalid/record', {
  method: 'POST', body: JSON.stringify(value)
});
export class ObservedAsteriskCall extends AsteriskCall {
  constructor(state, env) { super(state, env); this.fixtureEnv = env; }
  async fetch(request) {
    const env = this.fixtureEnv;
    const call = new URL(request.url).searchParams.get('call');
    await record(env, { kind: 'owner', call,
      offer: request.headers.get('Sec-WebSocket-Protocol'),
      authorizationAbsent: !request.headers.has('Authorization'),
      freshAdmission: request.headers.get('X-Openfon-Asterisk-Admission') === env.FIXTURE_ADMISSION });
    return super.fetch(request);
  }
}
export class SyntheticSession {
  constructor(state, env) { this.env = env; this.socket = null; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/fixture-close') {
      try { this.socket?.close(1000, 'fixture cleanup'); } catch { /* Already closed peer. */ }
      this.socket = null;
      return new Response(null, { status: 204 });
    }
    await record(this.env, { kind: 'session', call: url.searchParams.get('call'),
      offer: request.headers.get('Sec-WebSocket-Protocol') });
    const pair = new WebSocketPair(); this.socket = pair[1]; this.socket.accept();
    this.socket.addEventListener('close', () => { try { this.socket?.close(); } catch {} });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
export default { ...worker, async fetch(request, env, ctx) {
  const call = new URL(request.url).searchParams.get('call');
  await record(env, { kind: 'public-request', call, offer: request.headers.get('Sec-WebSocket-Protocol') });
  const response = await worker.fetch(request, env, ctx);
  await record(env, { kind: 'public-response', call, status: response.status,
    selected: response.headers.get('Sec-WebSocket-Protocol') });
  return response;
}};
`;

function connect(url, test) {
  return new Promise(resolveResult => {
    let socket, done = false, upgrade = null, nodeSerialization = null;
    const timer = setTimeout(() => {
      finish({ kind: 'timeout' }); socket?.terminate();
    }, 8000);
    const finish = result => {
      if (done) return; done = true; clearTimeout(timer); resolveResult({ ...result, upgrade, nodeSerialization });
    };
    const headers = { 'X-Openfon-Asterisk-Admission': 'forged-fixture-value' };
    if (test.auth !== 'absent') headers.Authorization = test.auth === 'wrong'
      ? 'Basic ' + Buffer.from('pbx:' + 'x'.repeat(40)).toString('base64') : authorization;
    if (Object.hasOwn(test, 'rawOffer')) headers['Sec-WebSocket-Protocol'] = test.rawOffer;
    try {
      socket = new WebSocket(url, test.protocols || [], { headers, handshakeTimeout: 7000, perMessageDeflate: false,
        finishRequest(request) {
          // ws delegates end() to this hook. End exactly once, without changing
          // headers. This is Node serialization, NOT a packet capture.
          request.end();
          if (typeof request._header !== 'string') {
            nodeSerialization = { available: false }; return;
          }
          // Whitelist one field only. Never retain/log the request, complete
          // serialized header block, Authorization or any other header value.
          const values = [];
          for (const line of request._header.split('\r\n')) {
            const colon = line.indexOf(':');
            if (colon > 0 && line.slice(0, colon).toLowerCase() === 'sec-websocket-protocol') {
              values.push(line.slice(colon + 1));
            }
          }
          // Values retain ALL bytes after ':', including Node's separator OWS.
          nodeSerialization = { available: true, present: values.length > 0, count: values.length, valuesAfterColon: values };
        },
      });
      sockets.add(socket);
    } catch (error) { finish({ kind: 'client-local', error: error.message }); return; }
    socket.on('upgrade', response => { upgrade = { status: response.statusCode, selected: response.headers['sec-websocket-protocol'] ?? null }; });
    socket.on('open', () => finish({ kind: 'open', protocol: socket.protocol }));
    socket.on('unexpected-response', (_request, response) => {
      finish({ kind: 'http-refusal', status: response.statusCode });
      response.resume(); socket.terminate();
    });
    // Keep an error listener after the initial outcome for disposal/abort events.
    socket.on('error', error => finish({ kind: 'client-error', error: error.message }));
    socket.on('close', (code) => {
      sockets.delete(socket); finish({ kind: 'closed-before-open', code });
    });
  });
}

async function closeClients() {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'fixture cleanup');
    else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
  // Test-only bounded graceful close, then terminate only this harness's sockets.
  const deadline = Date.now() + 1000;
  while (sockets.size && Date.now() < deadline) await pause(20);
  for (const socket of sockets) socket.terminate();
  await waitFor(() => sockets.size === 0, 'client sockets');
}

try {
  temp = await mkdtemp(resolve(tmpdir(), 'openfon-asterisk-negotiation-'));
  const hash = execFileSync(process.execPath, [resolve(root, 'scripts/asterisk-credential.mjs')], { input: password, encoding: 'utf8' }).trim();
  const version = createHash('sha256').update(JSON.stringify(['pbx', 'business', 'assistant', hash])).digest('hex');
  const bundle = await build({ stdin: { resolveDir: root, loader: 'ts', contents: entry }, bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', write: false, external: ['cloudflare:*'] });
  mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: Number(process.env.OPENFON_TEST_PORT || 8811),
    inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9251), defaultPersistRoot: temp, cf: false, workers: [{
      name: 'openfon', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-01',
      d1Databases: { DB: 'negotiation-db' },
      durableObjects: { ASTERISK_CALL: { className: 'ObservedAsteriskCall', useSQLite: true }, CALL_SESSION: { className: 'SyntheticSession', useSQLite: true } },
      bindings: { ASTERISK_ENABLED: 'true', FIXTURE_ADMISSION: version, REALTIME_BASE_URL: 'wss://fixture.invalid/realtime',
        REALTIME_MODEL: 'gpt-realtime-2', REALTIME_API_KEY: 'synthetic-only' },
      outboundService: () => { throw Error('Fixture forbids provider/outbound traffic'); },
      serviceBindings: { RECORD: async request => { events.push(await request.json()); return new Response(null, { status: 204 }); } },
    }] }));
  const ready = await mf.ready;
  const publicUrl = new URL(ready); publicUrl.protocol = 'ws:'; publicUrl.pathname = '/ws/asterisk/pbx';
  assert.equal(publicUrl.hostname, '127.0.0.1');
  const db = await mf.getD1Database('DB', 'openfon');
  for (const name of (await readdir(resolve(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
    await db.batch(unstable_splitSqlQuery(await readFile(resolve(root, 'migrations', name), 'utf8')).map(sql => db.prepare(sql)));
  }
  await db.batch([
    db.prepare("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused')"),
    db.prepare("INSERT INTO businesses(id,user_id,slug,name,max_concurrent_calls,max_calls_per_day) VALUES('business','owner','negotiation','Fixture',1,100)"),
    db.prepare("INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language,engine,realtime_model) VALUES('assistant','business','negotiation','active','Alex','Helpful','en','realtime','gpt-realtime-2')"),
    db.prepare("INSERT INTO asterisk_routes(id,business_id,assistant_id,password_sha256,password_hash,enabled) VALUES('pbx','business','assistant',lower(hex(randomblob(32))),?,1)").bind(hash),
  ]);
  const sessions = await mf.getDurableObjectNamespace('CALL_SESSION', 'openfon');
  for (const test of cases) {
    executed++;
    const call = 'ast_' + createHash('sha256').update('pbx\0' + test.name).digest('hex');
    const start = events.length; publicUrl.search = '?call=' + test.name;
    try {
      const outcome = await connect(publicUrl, test);
      const trace = events.slice(start);
      const row = await db.prepare('SELECT id,status,carrier_released_at FROM calls WHERE id=?').bind(call).first();
      const ingress = trace.find(event => event.kind === 'public-request');
      const response = trace.find(event => event.kind === 'public-response');
      const owners = trace.filter(event => event.kind === 'owner');
      const sessionEvents = trace.filter(event => event.kind === 'session');
      const classification = outcome.kind === 'client-local' ? 'client-local-refusal'
        : outcome.kind === 'http-refusal' && response?.status === outcome.status ? 'application-http-response'
        : outcome.kind === 'http-refusal' ? 'transport-http-response'
        : outcome.kind;
      // Especially on ORIGINAL no-offer: persist unsolicited selection, exact
      // client error, public/owner/session trace and D1 row BEFORE assertions.
      console.log(JSON.stringify({ case: test.name, classification, outcome, trace, callRows: row ? 1 : 0, row,
        optionOffer: Object.hasOwn(test, 'rawOffer') ? test.rawOffer : test.protocols?.join(',') ?? null,
        observedOffer: ingress?.offer ?? null }));
      let unavailableReason = null;
      if (!test.local) {
        assert.equal(outcome.nodeSerialization?.available, true, 'Node serialized header observation available');
        const serialized = outcome.nodeSerialization;
        const intended = Object.hasOwn(test, 'rawOffer') ? test.rawOffer : test.protocols?.join(',') ?? null;
        if (test.boundary && !serialized.present) {
          unavailableReason = 'client-construction: protocol header absent from Node serialization';
        } else {
          assert.equal(serialized.count, intended === null ? 0 : 1);
          if (intended !== null) assert.equal(serialized.valuesAfterColon[0].replace(/^[ \t]+|[ \t]+$/g, ''), intended.replace(/^[ \t]+|[ \t]+$/g, ''));
          if (test.boundary && ingress && ingress.offer === null) {
            unavailableReason = 'boundary-normalization: serialized empty/OWS protocol is absent at public handler; exact layer unknown';
          }
        }
      }
      if (unavailableReason) {
        // This proves no present-empty policy outcome. Check the observed
        // absent-header behavior, but report UNAVAILABLE rather than PASS/400.
        assert.ok(ingress); assert.equal(ingress.offer, null);
        assert.equal(outcome.kind, 'open'); assert.equal(outcome.protocol, '');
        assert.deepEqual(outcome.upgrade, { status: 101, selected: null });
        assert.equal(response?.status, 101); assert.equal(response.selected, null);
        assert.equal(owners.length, 1); assert.equal(owners[0].offer, null);
        assert.equal(owners[0].authorizationAbsent, true); assert.equal(owners[0].freshAdmission, true);
        assert.equal(sessionEvents.length, 1); assert.equal(sessionEvents[0].offer, null); assert.ok(row);
        unavailable.push({ case: test.name, reason: unavailableReason });
      } else if (test.local) {
        assert.equal(outcome.kind, 'client-local'); assert.equal(trace.length, 0); assert.equal(row, null);
      } else if (test.status) {
        assert.equal(outcome.kind, 'http-refusal'); assert.equal(outcome.status, test.status);
        assert.equal(response?.status, test.status, 'must reach application policy, not transport-only refusal');
        assert.ok(ingress); assert.equal(owners.length, 0); assert.equal(sessionEvents.length, 0); assert.equal(row, null);
        if (Object.hasOwn(test, 'rawOffer')) assert.equal(ingress.offer, test.normalizedOffer ?? test.rawOffer);
      } else {
        assert.equal(outcome.kind, 'open'); assert.equal(outcome.protocol, test.selected ?? '');
        assert.deepEqual(outcome.upgrade, { status: 101, selected: test.selected });
        assert.equal(response?.status, 101); assert.equal(response.selected, test.selected);
        assert.ok(ingress); assert.equal(ingress.offer, test.protocols?.join(',') ?? null);
        assert.equal(owners.length, 1); assert.equal(owners[0].offer, test.selected);
        assert.equal(owners[0].authorizationAbsent, true); assert.equal(owners[0].freshAdmission, true);
        assert.equal(sessionEvents.length, 1); assert.equal(sessionEvents[0].offer, null); assert.ok(row);
      }
      if (unavailableReason) console.log(JSON.stringify({ case: test.name, result: 'UNAVAILABLE', reason: unavailableReason }));
      else { passes.push(test.name); console.log(JSON.stringify({ case: test.name, result: 'PASS' })); }
    } catch (error) {
      failures.push({ case: test.name, error: error.message });
      console.log(JSON.stringify({ case: test.name, result: 'FAIL', error: error.message }));
    } finally {
      // The synthetic peer can close an original failed-handshake orphan too.
      // Do not create a session merely to clean up a pre-admission refusal.
      try { await closeClients(); } catch (error) { cleanupErrors.push(error); }
      try {
        if (events.slice(start).some(event => event.kind === 'session' && event.call === call)) {
          const closed = await sessions.get(sessions.idFromName(call)).fetch('https://fixture/fixture-close');
          assert.equal(closed.status, 204, 'synthetic peer cleanup response');
          await waitFor(async () => Boolean((await db.prepare('SELECT carrier_released_at FROM calls WHERE id=?').bind(call).first())?.carrier_released_at), test.name + ' owner release');
        }
      } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) break; // No later case can obscure a dirty fixture.
  }
  console.log(JSON.stringify({ result: failures.length || cleanupErrors.length ? 'FAIL' : unavailable.length ? 'COMPLETE_WITH_UNAVAILABLE' : 'PASS',
    counts: { PASS: passes.length, UNAVAILABLE: unavailable.length, FAIL: failures.length }, failures, unavailable,
    runtime: 'actual ws/public workerd/AsteriskCall/D1/PBKDF2', session: 'accepted synthetic socket only',
    provider: 'none', PBX: 'none', Linux: 'not tested', scheduledCases: cases.length, executedCases: executed }));
  if (failures.length) throw Error(failures.length + ' negotiation case(s) failed');
} catch (error) { primary = error; }
finally {
  try { await closeClients(); } catch (error) { cleanupErrors.push(error); }
  try { await mf?.dispose(); } catch (error) { cleanupErrors.push(error); }
  try { if (temp) await rm(temp, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  console.log(JSON.stringify({ cleanup: cleanupErrors.length ? 'UNCERTAIN' : 'disposed', clientSockets: sockets.size,
    errors: cleanupErrors.map(error => error.message) }));
}
if (primary || cleanupErrors.length) throw new AggregateError([...(primary ? [primary] : []), ...cleanupErrors], 'Negotiation validation failed');
