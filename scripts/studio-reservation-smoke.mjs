// Node production handlers + real workerd D1; fault/peer boundaries are synthetic.
// No external provider traffic, application server concurrency or uncertain-commit proof.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
process.umask(0o077);
const evidence = process.env.OPENFON_RESERVATION_EVIDENCE_DIR;
assert.ok(evidence, 'Unique restricted durable evidence directory required');
await mkdir(evidence, { mode: 0o700 });
const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'openfon-reservation-cleanup-'));
const outcomes = [], captures = [];
const realFetch = globalThis.fetch, realNow = Date.now, realError = console.error;
let mf, disposed = false, activeCase;
try {
  await build({ stdin: { contents: "export { default } from './src/index';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'handler.mjs') });
  const { default: worker } = await import(pathToFileURL(join(temp, 'handler.mjs')).href);
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false, port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252), workers: [{ name: 'reservation-cleanup', modules: true, script: 'export default {fetch(){return new Response("local D1")}}', compatibilityDate: '2026-05-01', d1Databases: { DB: 'reservation-cleanup' }, outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready; const native = await mf.getD1Database('DB', 'reservation-cleanup');
  const exec = sql => native.batch(unstable_splitSqlQuery(sql).map(s => native.prepare(s)));
  const query = async sql => (await native.prepare(sql).all()).results;
  const migrations = (await readdir(join(root, 'migrations'))).filter(n => /^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0, 4)) <= 22).sort(); assert.equal(migrations.length, 22);
  for (const file of migrations) await exec(await readFile(join(root, 'migrations', file), 'utf8'));
  const snapshot = async () => {
    const tables = await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name");
    const result = []; for (const { name } of tables) result.push({ name, rows: await query(`SELECT * FROM "${name}" ORDER BY rowid`) }); return result;
  };
  const initialClock = Date.parse('2026-09-15T23:59:59.250Z'), ip = '198.51.100.241';
  let clock = initialClock, fault, refundFault, onAcquire, writes = [], errors = [], refundAttempts = 0, fetches = 0, fired = 0;
  Date.now = () => clock;
  const acquisitionError = new Error('SYNTHETIC_ACQUISITION'), refundError = new Error('SYNTHETIC_REFUND');
  console.error = e => { errors.push(e instanceof Error ? e.message : String(e)); };
  // Only the synthetic endpoint is intercepted; Miniflare's own local fetches
  // retain the captured real transport. Any other external provider is an error.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === 'instance.example') { fetches++; return new Response('', { status: 401 }); }
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') return realFetch(input, init);
    throw new Error('Unexpected external fetch');
  };
  const bucket = s => `studio:${s}:${s.startsWith('ip-') ? ip : 'biz'}`;
  const windowAt = (s, time = initialClock) => Math.floor(time / 1000 / (s.endsWith('day') ? 86400 : 60)) * (s.endsWith('day') ? 86400 : 60);
  const set = (s, count, time = initialClock) => native.prepare('INSERT INTO rate_counters(bucket,window_start,count,starts) VALUES(?,?,?,7) ON CONFLICT(bucket,window_start) DO UPDATE SET count=excluded.count').bind(bucket(s), windowAt(s, time), count).run();
  const counters = () => query("SELECT bucket,window_start,count,starts FROM rate_counters WHERE bucket LIKE 'studio:%' ORDER BY bucket,window_start");
  function statement(sql, args = []) {
    const raw = () => native.prepare(sql).bind(...args);
    return { sql, args, raw, bind: (...values) => statement(sql, values),
      async first(...values) {
        const reservation = sql.trim().startsWith('INSERT INTO rate_counters');
        const suffix = reservation ? String(args[0]).split(':')[1] : undefined;
        if (suffix && onAcquire) await onAcquire(suffix);
        const taken = suffix && fault?.suffix === suffix ? fault : undefined;
        if (taken) { fault = undefined; fired++; if (taken.peer) await taken.peer(); }
        if (taken?.mode === 'before') throw acquisitionError;
        const result = await raw().first(...values);
        if (reservation) writes.push({ kind: 'acquire', args, result });
        if (taken?.mode === 'after') throw acquisitionError;
        return result;
      },
      all: (...values) => raw().all(...values), run: (...values) => raw().run(...values),
    };
  }
  const db = { prepare: statement, async batch(statements) {
    const isRefund = statements.some(s => s.sql.startsWith('UPDATE rate_counters SET count=count-1'));
    if (isRefund) { refundAttempts++; writes.push({ kind: 'refund-submit', statements: statements.map(s => ({ sql: s.sql, args: s.args })) }); if (refundFault === 'before') throw refundError; }
    const result = await native.batch(statements.map(s => s.raw()));
    if (isRefund) writes.push({ kind: 'refund-result', result });
    if (isRefund && refundFault === 'after') throw refundError;
    return result;
  } };
  const env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: 'synthetic-only', DEFAULT_LLM_MODEL: 'instance', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime', REALTIME_MODEL: 'kataleptic-realtime-hd' };
  const request = (path, method = 'POST') => worker.fetch(new Request('https://openfon.test' + path, { method, headers: { Cookie: 'ofs=session', 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, ...(method === 'POST' ? { body: '{}' } : {}) }), env, { waitUntil() {}, passThroughOnException() {} });
  const action = lane => request(lane === 'ticket' ? '/api/me/assistants/asst_biz/test-calls' : '/api/me/provider/check');
  async function reset() {
    fault = undefined; refundFault = undefined; onAcquire = undefined; clock = initialClock;
    await exec("DROP TRIGGER IF EXISTS synthetic_refund_abort; DELETE FROM users; DELETE FROM rate_counters; INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'); INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01'); INSERT INTO businesses(id,user_id,slug,name,description) VALUES('biz','owner','owned','Owned','Synthetic'); INSERT INTO agent_settings(business_id) VALUES('biz'); INSERT INTO provider_settings(business_id) VALUES('biz');");
    assert.equal((await request('/api/me/bootstrap', 'GET')).status, 200);
    writes = []; errors = []; refundAttempts = 0; fetches = 0; fired = 0;
  }
  async function capture(name, before, response, extra = {}) {
    const after = await snapshot(); captures.push({ name, before, after, status: response.status, body: await response.json(), counters: await counters(), writes: [...writes], errors: [...errors], refundAttempts, fired, fetches, ...extra });
    console.log(JSON.stringify({ diagnostic: name, status: response.status })); return after;
  }
  async function acquisitionCase(lane, suffix, mode) {
    await reset(); for (const s of ['minute','ip-minute','ip-day','provider-day']) await set(s, 2);
    const before = await snapshot(); fault = { suffix, mode }; const response = await action(lane);
    const expected = structuredClone(before);
    if (mode === 'after') expected.find(t => t.name === 'rate_counters').rows.find(r => r.bucket === bucket(suffix) && r.window_start === windowAt(suffix)).count++;
    const after = await capture(`${lane}-${suffix}-${mode}`, before, response, { expected });
    assert.deepEqual(after, expected); // Original first failure after full persisted capture.
    assert.equal(response.status, 500); assert.equal(refundAttempts, 1); assert.equal(fired, 1); assert.equal(fetches, 0); assert.deepEqual(errors, [acquisitionError.message]);
    const refundResult = writes.find(w => w.kind === 'refund-result'); assert.ok(refundResult);
    // Seeded peers remain nonzero: each decrement changes1, each DELETE changes0.
    assert.ok(refundResult.result.every((r, i) => r.meta.changes === (i % 2 === 0 ? 1 : 0)));
  }
  const cases = {
    'partial-ip-before': () => acquisitionCase('ticket', 'ip-day', 'before'),
    'partial-ip-after': () => acquisitionCase('provider', 'ip-day', 'after'),
    'provider-day-before': () => acquisitionCase('provider', 'provider-day', 'before'),
    async 'refund-before'() { await refundCase('before'); },
    async 'refund-after'() { await refundCase('after'); },
    async 'refund-late-abort'() { await refundCase('late-abort'); },
    async 'peer-window'() {
      await reset(); for (const s of ['minute','ip-minute','ip-day']) { await set(s, 2); await set(s, 7, initialClock + 2000); }
      const before = await snapshot(); fault = { suffix: 'ip-day', mode: 'before', peer: async () => { await set('minute',4); await set('ip-minute',4); await set('ip-day',3); clock += 2000; } };
      const response = await action('ticket'); await capture('peer-window', before, response);
      assert.equal(response.status,500); assert.equal(refundAttempts,1); assert.equal(fetches,0);
      const rows = await counters(); for (const s of ['minute','ip-minute','ip-day']) {
        assert.equal(rows.find(r => r.bucket === bucket(s) && r.window_start === windowAt(s)).count,3);
        assert.equal(rows.find(r => r.bucket === bucket(s) && r.window_start === windowAt(s,initialClock+2000)).count,7);
      }
    },
    async 'null-and-attempt'() {
      await reset(); onAcquire = async suffix => { if (suffix === 'provider-day') { onAcquire = undefined; await set(suffix,50); clock += 2000; } };
      const before = await snapshot(), response = await action('provider'); await capture('null-provider-day',before,response);
      assert.equal(response.status,429); assert.equal(response.headers.get('Retry-After'),'1'); assert.equal(refundAttempts,1); assert.equal(fetches,0);
      assert.deepEqual(await counters(),[{bucket:bucket('provider-day'),window_start:windowAt('provider-day'),count:50,starts:7}]);
      assert.equal(writes.find(w => w.kind === 'acquire' && w.args[0] === bucket('provider-day')).result,null);
      assert.ok(writes.find(w => w.kind === 'refund-result').result.every(r => r.meta.changes === 1)); // Empty rows deleted.
      await reset(); const initial = await snapshot(), attempt = await action('provider'); await capture('charged-upstream-401',initial,attempt);
      assert.equal(attempt.status,502); assert.equal(fetches,1); assert.equal(refundAttempts,0); assert.deepEqual((await counters()).map(r=>r.count),[1,1,1,1]);
    },
  };
  async function refundCase(mode) {
    await reset(); await set('minute',2); await set('ip-minute',3);
    if (mode === 'late-abort') await exec("CREATE TRIGGER synthetic_refund_abort BEFORE UPDATE ON rate_counters WHEN OLD.bucket='studio:minute:biz' AND NEW.count<OLD.count BEGIN SELECT RAISE(ABORT,'SYNTHETIC_REFUND_LATE'); END;");
    const before = await snapshot(); fault = { suffix:'ip-day',mode:'before' }; refundFault = mode;
    const response = await action('provider'); const after = await capture(`refund-${mode}`,before,response);
    assert.equal(response.status,500); assert.equal(refundAttempts,1); assert.equal(fetches,0); assert.deepEqual(errors,[acquisitionError.message]);
    assert.deepEqual(await counters(),[
      {bucket:bucket('ip-minute'),window_start:windowAt('ip-minute'),count:mode==='after'?3:4,starts:7},
      {bucket:bucket('minute'),window_start:windowAt('minute'),count:mode==='after'?2:3,starts:7},
    ]);
    if (mode==='after') assert.deepEqual(after,before);
  }
  const selected = process.env.OPENFON_RESERVATION_NATIVE_CASE ? [process.env.OPENFON_RESERVATION_NATIVE_CASE] : Object.keys(cases);
  for (const name of selected) { assert.ok(Object.hasOwn(cases,name)); activeCase=name; await cases[name](); outcomes.push({name,status:'PASS'}); console.log(JSON.stringify(outcomes.at(-1))); activeCase=undefined; }
} catch (e) {
  outcomes.push({name:activeCase??'setup-or-harness',status:'FAIL',message:e.message}); realError(JSON.stringify(outcomes.at(-1))); process.exitCode=1;
} finally {
  globalThis.fetch=realFetch; Date.now=realNow; console.error=realError;
  try { await writeFile(join(evidence,'native-result.json'),JSON.stringify({outcomes,captures},null,2)); }
  catch(e) { realError(JSON.stringify({status:'EVIDENCE_WRITE_FAILURE',message:e.message})); process.exitCode=1; }
  try { if(mf) await mf.dispose(); disposed=true; }
  catch(e) { realError(JSON.stringify({status:'DISPOSAL_FAILURE',message:e.message})); process.exitCode=1; }
  if(disposed) { try { await rm(temp,{recursive:true,force:true}); } catch(e) { disposed=false; realError(JSON.stringify({status:'TEMP_CLEANUP_FAILURE',message:e.message})); process.exitCode=1; } }
  console.log(JSON.stringify({disposal:disposed?'completed':'unconfirmed; owned temp retained'}));
}
