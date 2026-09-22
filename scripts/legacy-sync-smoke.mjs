// Source-prepared bounded probe: Node production handlers + workerd/D1.
// Peers/fault boundaries are synthetic, not full Worker concurrency or deployment proof.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
process.umask(0o077);
const evidence = process.env.OPENFON_LEGACY_SYNC_EVIDENCE_DIR;
assert.ok(evidence, 'Absent durable private evidence directory required');
await mkdir(evidence, { mode: 0o700 });
const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'openfon-legacy-sync-'));
const captures = [], outcomes = [];
let mf, disposed = false, cleanupFailed = false;
const realFetch = globalThis.fetch, realError = console.error;
try {
  await build({ stdin: { contents: "export { default } from './src/index'; export { syncLegacyKnowledge } from './src/studio-api';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'handler.mjs') });
  const { default: worker, syncLegacyKnowledge } = await import(pathToFileURL(join(temp, 'handler.mjs')).href);
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, cf: false,
    port: Number(process.env.OPENFON_TEST_PORT || 8812), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9252),
    workers: [{ name: 'legacy-sync', modules: true, script: 'export default {fetch(){return new Response("local D1")}}', compatibilityDate: '2026-05-01',
      d1Databases: { DB: 'legacy-sync' }, outboundService: async () => new Response('Network disabled', { status: 502 }) }] }));
  await mf.ready; const native = await mf.getD1Database('DB', 'legacy-sync');
  const exec = sql => native.batch(unstable_splitSqlQuery(sql).map(part => native.prepare(part)));
  const query = async sql => (await native.prepare(sql).all()).results;
  const files = (await readdir(join(root, 'migrations'))).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 22).sort();
  assert.equal(files.length, 22);
  for (const file of files) await exec(await readFile(join(root, 'migrations', file), 'utf8'));
  const snapshot = async () => {
    const tables = await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name");
    const result = []; for (const { name } of tables) result.push({ name, rows: await query(`SELECT * FROM "${name}" ORDER BY rowid`) }); return result;
  };
  let onWorkspaceRead, onProjection, batches = [], errors = [];
  const errorChain = error => { const result = []; for (let depth = 0; depth < 5 && error instanceof Error; depth++, error = error.cause) result.push(error.message); return result; };
  function statement(sql, args = []) {
    const raw = () => native.prepare(sql).bind(...args);
    return { sql, args, raw, bind: (...values) => statement(sql, values),
      async first(...values) {
        const result = await raw().first(...values);
        if (onWorkspaceRead && sql.startsWith('SELECT * FROM businesses WHERE user_id = ?')) {
          const peer = onWorkspaceRead; onWorkspaceRead = undefined; await peer();
        }
        return result;
      }, all: (...values) => raw().all(...values), run: (...values) => raw().run(...values),
    };
  }
  const db = { prepare: statement, async batch(statements) {
    if (onProjection && statements.some(s => s.sql.includes('DELETE FROM knowledge_items WHERE business_id'))) {
      const peer = onProjection; onProjection = undefined; await peer(); // Before the real native batch begins.
    }
    const receipt = { statements: statements.map(({ sql, args }) => ({ sql, args })) }; batches.push(receipt);
    try { const result = await native.batch(statements.map(s => s.raw())); receipt.result = result; return result; }
    catch (error) { receipt.errors = errorChain(error); throw error; }
  } };
  const env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.invalid/v1', DEFAULT_LLM_API_KEY: 'synthetic-only', DEFAULT_LLM_MODEL: 'instance', DEFAULT_STT_BASE_URL: 'https://instance.invalid/v1', DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_MODEL: 'kataleptic-realtime-hd' };
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return realFetch(input, init);
    throw new Error('Unexpected nonlocal fetch');
  };
  console.error = error => { errors.push(errorChain(error)); };
  const request = (path, body, method = body === undefined ? 'GET' : 'PUT') => worker.fetch(new Request(`https://openfon.test${path}`, {
    method, headers: { Cookie: 'ofs=session', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil() {}, passThroughOnException() {} });
  const faq = answer => JSON.stringify([{ q: 'Question', a: answer }]);
  const save = answer => request('/api/me/business/biz', { faqs_json: faq(answer) });
  const edit = body => request('/api/me/knowledge/items/legacy_biz_faq_0', body);
  const item = async () => (await query("SELECT * FROM knowledge_items WHERE id='legacy_biz_faq_0'"))[0];
  const count = async () => (await query("SELECT COALESCE(SUM(count),0) AS n FROM rate_counters WHERE bucket='knowledge:biz'"))[0].n;
  async function reset() {
    onWorkspaceRead = undefined; onProjection = undefined;
    await exec("DROP TRIGGER IF EXISTS synthetic_legacy_marker_abort; DELETE FROM users; DELETE FROM rate_counters; INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'); INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01'); INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','owned','Owned'); INSERT INTO agent_settings(business_id) VALUES('biz'); INSERT INTO provider_settings(business_id) VALUES('biz');");
    await native.prepare("UPDATE businesses SET faqs_json=? WHERE id='biz'").bind(faq('S0')).run();
    assert.equal((await request('/api/me/bootstrap')).status, 200);
    batches = []; errors = [];
  }
  async function capture(name, response, before, winner, extra = {}) {
    const result = { name, status: response.status, body: await response.json(), before, winner, after: await snapshot(), batches: structuredClone(batches), errors: structuredClone(errors), extra };
    captures.push(result); await writeFile(join(evidence, 'native-result.json'), JSON.stringify({ outcomes, captures }, null, 2)); return result;
  }
  const cases = [
    ['stale-get', async () => {
      await reset(); const before = await snapshot(); let winner, sourceStatus, typedStatus;
      onWorkspaceRead = async () => { sourceStatus = (await save('S1')).status; typedStatus = (await edit({ answer: 'T', status: 'draft' })).status; winner = await snapshot(); };
      const response = await request('/api/me/business'), afterRequest = await snapshot();
      const fresh = await request('/api/me/bootstrap'), afterFresh = await snapshot();
      const result = await capture('stale-get', response, before, winner, { sourceStatus, typedStatus, afterRequest, freshStatus: fresh.status, afterFresh });
      assert.equal(result.status, 409); assert.equal(sourceStatus, 200); assert.equal(typedStatus, 200);
      assert.deepEqual(afterRequest, winner); assert.deepEqual(afterFresh, winner);
    }],
    ['typed-row', async () => {
      for (const action of ['edit','move','delete']) {
        await reset(); const before = await snapshot(); let winner, peerStatus;
        onProjection = async () => {
          if (action === 'move') {
            await native.prepare("INSERT INTO knowledge_collections(id,business_id,name) VALUES('other','biz','Other')").run();
            peerStatus = (await edit({ collection_id: 'other' })).status;
          } else if (action === 'delete') peerStatus = (await request('/api/me/knowledge/items/legacy_biz_faq_0', undefined, 'DELETE')).status;
          else peerStatus = (await edit({ answer: 'T', status: 'draft' })).status;
          winner = await snapshot();
        };
        const result = await capture(`typed-${action}`, await save('S1'), before, winner, { peerStatus });
        assert.equal(result.status, 409); assert.equal(peerStatus, 200); assert.deepEqual(result.after, winner);
        assert.ok(result.batches.some(batch => batch.errors?.some(message => message.includes('[OPENFON_LEGACY_KNOWLEDGE_CONFLICT]'))));
      }
    }],
    ['empty-noop', async () => {
      await reset(); assert.equal((await edit({ answer: 'Typed\u0000🙂', status: 'draft' })).status, 200);
      batches = []; const before = await snapshot(), spend = await count();
      const response = await request('/api/me/business/biz', { faqs_json: '[]', services_json: '[]' });
      await syncLegacyKnowledge(env, { id: 'biz', faqs_json: '[]', services_json: '[]' });
      await syncLegacyKnowledge(env, { id: 'biz', faqs_json: '[]', services_json: '[]' });
      const result = await capture('empty-noop', response, before, before, { spend, afterSpend: await count() });
      assert.equal(result.status, 200); assert.equal(await count(), spend); assert.equal((await query('SELECT * FROM knowledge_items')).length, 0);
      const guards = result.batches.flatMap(batch => batch.statements.map((s, i) => s.sql.includes('[OPENFON_LEGACY_KNOWLEDGE_CONFLICT]') ? batch.result?.[i] : null).filter(Boolean));
      assert.equal(guards.length, 4); // First nonempty snapshot: state+row; two empty snapshots: state only.
      for (const guard of guards) { assert.equal(guard.meta.changes, 0); assert.equal(Object.values(guard.results[0])[0], 1); }
      assert.deepEqual(await query("SELECT services_json,faqs_json FROM compatibility_sync_state WHERE business_id='biz'"), [{ services_json: '[]', faqs_json: '[]' }]);
      for (const batch of result.batches) { assert.ok(batch.statements.at(-1).sql.includes('INSERT INTO compatibility_sync_state')); assert.ok(batch.result.at(-1).meta.changes > 0); }
    }],
    ['late-marker', async () => {
      await reset(); await exec("CREATE TRIGGER synthetic_legacy_marker_abort BEFORE UPDATE OF faqs_json ON compatibility_sync_state WHEN NEW.faqs_json<>OLD.faqs_json BEGIN SELECT RAISE(ABORT,'SYNTHETIC_LATE_MARKER_EXECUTION'); END;");
      const before = await snapshot(), result = await capture('late-marker', await save('S1'), before, before);
      assert.equal(result.status, 500); assert.deepEqual(result.after, before);
      const failed = result.batches.find(batch => batch.errors?.some(message => message.includes('SYNTHETIC_LATE_MARKER_EXECUTION'))); assert.ok(failed);
      const texts = failed.statements.map(s => s.sql);
      assert.ok(texts.findIndex(s => s.includes('UPDATE businesses SET')) < texts.findIndex(s => s.includes('DELETE FROM knowledge_items')));
      assert.ok(texts.findIndex(s => s.includes('INSERT INTO knowledge_items')) < texts.findIndex(s => s.includes('INSERT INTO compatibility_sync_state')));
    }],
    ['new-and-missing', async () => {
      await reset(); await exec('DELETE FROM businesses; DELETE FROM rate_counters;');
      const before = await snapshot(), created = await request('/api/me/business', { name: 'Created', faqs_json: faq('Created') }, 'POST');
      const result = await capture('new-workspace', created, before, before); assert.equal(result.status, 201);
      assert.equal((await query('SELECT * FROM assistant_knowledge_collections')).length, 1); assert.equal((await query('SELECT * FROM knowledge_items')).length, 1);
      await exec('DELETE FROM knowledge_collections;'); const damaged = await snapshot();
      const repaired = await capture('missing-default', await request('/api/me/bootstrap'), damaged, damaged);
      assert.equal(repaired.status, 200); assert.equal((await query('SELECT * FROM knowledge_items')).length, 1); assert.equal((await query('SELECT * FROM assistant_knowledge_collections')).length, 1);
    }],
    ['quota-late', async () => {
      await reset(); const before = await snapshot(); let winner;
      onProjection = async () => { await native.prepare("UPDATE rate_counters SET count=500 WHERE bucket='knowledge:biz'").run(); winner = await snapshot(); };
      const response = await save('S1'); const result = await capture('quota-late', response, before, winner);
      assert.equal(result.status, 429); assert.deepEqual(result.after, winner); assert.equal(await count(), 500);
    }],
  ];
  const selected = process.env.OPENFON_LEGACY_SYNC_NATIVE_CASE;
  assert.ok(!selected || cases.some(([name]) => name === selected));
  for (const [name, run] of cases) {
    if (selected && name !== selected) continue;
    try { await run(); outcomes.push({ name, status: 'PASS' }); }
    catch (error) { outcomes.push({ name, status: 'FAIL', message: String(error) }); process.exitCode = 1; break; }
    finally { await writeFile(join(evidence, 'native-result.json'), JSON.stringify({ outcomes, captures }, null, 2)); }
  }
} catch (error) {
  outcomes.push({ name: 'setup-or-capture', status: 'FAIL', message: String(error) }); process.exitCode = 1;
  await writeFile(join(evidence, 'native-result.json'), JSON.stringify({ outcomes, captures }, null, 2));
} finally {
  console.error = realError; globalThis.fetch = realFetch;
  try { if (mf) await mf.dispose(); disposed = true; }
  catch (error) { cleanupFailed = true; process.exitCode = 1; console.error('DISPOSAL_FAILURE', error); }
  if (disposed) {
    try { await rm(temp, { recursive: true, force: true }); }
    catch (error) { cleanupFailed = true; process.exitCode = 1; console.error('TEMP_CLEANUP_FAILURE', error); }
  }
  console.log(JSON.stringify({ outcomes: outcomes.map(({ name, status }) => ({ name, status })), captures: captures.length, disposal: disposed ? 'completed' : 'failed', tempCleanup: cleanupFailed ? 'failed' : 'completed' }));
}
