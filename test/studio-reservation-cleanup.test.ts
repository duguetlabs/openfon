import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

type Lane = 'ticket' | 'provider';
type Suffix = 'minute' | 'ip-minute' | 'ip-day' | 'provider-day';
type Fault = 'before' | 'after';
const now = Date.parse('2026-09-15T23:59:59.250Z');
const ip = '198.51.100.241';
let db: SqliteD1, env: Env, errors: unknown[], fetches: number;
let acquire: { suffix: Suffix; mode: Fault; peer?: () => void } | undefined;
let refund: Fault | 'late-abort' | undefined;
let ticket: Fault | undefined;
let onAcquire: ((suffix: Suffix) => void) | undefined;
let fired: number, refundAttempts: number;
let writes: unknown[];
const acquisitionError = new Error('SYNTHETIC_ACQUISITION');
const refundError = new Error('SYNTHETIC_REFUND');
const ticketError = new Error('SYNTHETIC_TICKET');
const tableRows = (sql: string) => db.database.prepare(sql).all() as Record<string, unknown>[];
const snapshot = () => (tableRows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as { name: string }[])
  .map(({ name }) => ({ name, rows: tableRows(`SELECT * FROM "${name}" ORDER BY rowid`) }));
const counters = () => tableRows("SELECT bucket,window_start,count,starts FROM rate_counters WHERE bucket LIKE 'studio:%' ORDER BY bucket,window_start");
const bucket = (suffix: Suffix) => `studio:${suffix}:${suffix.startsWith('ip-') ? ip : 'biz'}`;
const windowAt = (suffix: Suffix, clock = now) => Math.floor(clock / 1000 / (suffix.endsWith('day') ? 86400 : 60)) * (suffix.endsWith('day') ? 86400 : 60);
function set(suffix: Suffix, n: number, clock = now) {
  db.database.prepare('INSERT INTO rate_counters(bucket,window_start,count,starts) VALUES(?,?,?,7) ON CONFLICT(bucket,window_start) DO UPDATE SET count=excluded.count')
    .run(bucket(suffix), windowAt(suffix, clock), n);
}
function request(lane: Lane, path?: string) {
  return worker.fetch(new Request('https://openfon.test' + (path ?? (lane === 'ticket' ? '/api/me/assistants/asst_biz/test-calls' : '/api/me/provider/check')), {
    method: 'POST', headers: { Cookie: 'ofs=session', 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: '{}',
  }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
}
function install() {
  const inners = new WeakMap<object, ReturnType<SqliteD1['prepare']>>();
  const info = new WeakMap<object, { sql: string; values: unknown[] }>();
  function prepare(sql: string, values: unknown[] = []): D1PreparedStatement {
    const inner = db.prepare(sql).bind(...values as Parameters<ReturnType<SqliteD1['prepare']>['bind']>);
    const out = {
      bind: (...bound: unknown[]) => prepare(sql, bound),
      async first() {
        const reservation = sql.trim().startsWith('INSERT INTO rate_counters');
        const suffix = reservation ? String(values[0]).split(':')[1] as Suffix : undefined;
        if (suffix) onAcquire?.(suffix);
        const fault = suffix && acquire?.suffix === suffix ? acquire : undefined;
        if (fault) { acquire = undefined; fired++; fault.peer?.(); }
        if (fault?.mode === 'before') throw acquisitionError;
        const result = await inner.first();
        if (reservation) writes.push({ kind: 'acquire', values, result });
        if (fault?.mode === 'after') throw acquisitionError;
        return result;
      },
      all: () => inner.all(),
      async run() {
        const target = sql.trim().startsWith('INSERT INTO calls') && sql.includes('browser_claim_required');
        const fault = target ? ticket : undefined;
        if (fault) ticket = undefined;
        if (fault === 'before') throw ticketError;
        const result = await inner.run();
        if (target) writes.push({ kind: 'ticket', result });
        if (fault === 'after') throw ticketError;
        return result;
      },
    } as unknown as D1PreparedStatement;
    inners.set(out, inner); info.set(out, { sql, values }); return out;
  }
  env.DB = {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      const details = statements.map(s => info.get(s)!);
      const isRefund = details.some(d => d.sql.startsWith('UPDATE rate_counters SET count=count-1'));
      if (isRefund) {
        refundAttempts++; writes.push({ kind: 'refund-submit', details });
        if (refund === 'before') throw refundError;
      }
      const result = await db.batch(statements.map(s => inners.get(s)!));
      if (isRefund) writes.push({ kind: 'refund-result', result });
      if (isRefund && refund === 'after') throw refundError;
      return result;
    },
  } as unknown as D1Database;
}
function capture(name: string, before: unknown, response: Response, after: unknown, extra: unknown = {}) {
  console.log('reservation-preassertion', JSON.stringify({ name, before, status: response.status, after, counters: counters(), fired, refundAttempts, fetches, errors: errors.map(e => e instanceof Error ? e.message : String(e)), writes, extra }));
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
  db = new SqliteD1(); applyMigrations(db, 1, 21);
  db.exec("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused'); INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2099-01-01'); INSERT INTO businesses(id,user_id,slug,name,description) VALUES('biz','owner','owned','Owned','Synthetic'); INSERT INTO agent_settings(business_id) VALUES('biz'); INSERT INTO provider_settings(business_id) VALUES('biz');");
  env = { DB: db, DEFAULT_LLM_BASE_URL: 'https://instance.example/v1', DEFAULT_LLM_API_KEY: 'synthetic-only', DEFAULT_LLM_MODEL: 'instance', DEFAULT_STT_BASE_URL: 'https://instance.example/v1', DEFAULT_STT_MODEL: 'whisper-1', DEFAULT_TTS_PROVIDER: 'browser', REALTIME_BASE_URL: 'wss://instance.example/realtime', REALTIME_MODEL: 'kataleptic-realtime-hd' } as unknown as Env;
  const boot = await worker.fetch(new Request('https://openfon.test/api/me/bootstrap', { headers: { Cookie: 'ofs=session' } }), env, {} as ExecutionContext);
  expect(boot.status).toBe(200);
  errors = []; fetches = 0; fired = 0; refundAttempts = 0; writes = []; acquire = undefined; refund = undefined; ticket = undefined; onAcquire = undefined;
  vi.spyOn(console, 'error').mockImplementation(e => { errors.push(e); });
  vi.stubGlobal('fetch', async () => { fetches++; return Response.json({ choices: [{ message: { content: 'OK' } }] }); });
  install();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); db.close(); vi.useRealTimers(); });

// Ten discriminating acquisition cases: both routes at IP minute/day, plus
// provider-day. A committed-but-unacknowledged current increment must remain.
for (const lane of ['ticket', 'provider'] as const) {
  for (const suffix of (lane === 'ticket' ? ['ip-minute', 'ip-day'] : ['ip-minute', 'ip-day', 'provider-day']) as Suffix[]) {
    for (const mode of ['before', 'after'] as const) {
      it(`[original-negative] ${lane} ${suffix} ${mode} preserves only unconfirmed current spend`, async () => {
        for (const s of ['minute', 'ip-minute', 'ip-day', 'provider-day'] as const) set(s, 2);
        const before = snapshot(); acquire = { suffix, mode };
        const response = await request(lane), after = snapshot();
        const expected = JSON.parse(JSON.stringify(before)) as ReturnType<typeof snapshot>;
        if (mode === 'after') {
          const row = expected.find(t => t.name === 'rate_counters')!.rows.find(r => r.bucket === bucket(suffix) && r.window_start === windowAt(suffix))!;
          row.count = Number(row.count) + 1;
        }
        capture(`${lane}-${suffix}-${mode}`, before, response, after, { expected });
        expect(after).toEqual(expected); expect(response.status).toBe(500); expect(errors).toContain(acquisitionError);
        expect(fired).toBe(1); expect(refundAttempts).toBe(1); expect(fetches).toBe(0);
        expect(tableRows('SELECT * FROM calls')).toEqual([]);
      });
    }
  }
}
for (const lane of ['ticket', 'provider'] as const) for (const mode of ['before', 'after'] as const) {
  it(`${lane} workspace ${mode} never invents current ownership`, async () => {
    set('minute', 2); const before = snapshot(); acquire = { suffix: 'minute', mode };
    const response = await request(lane); capture(`${lane}-workspace-${mode}`, before, response, snapshot());
    expect(response.status).toBe(500); expect(refundAttempts).toBe(0); expect(fetches).toBe(0); expect(fired).toBe(1);
    expect(counters()).toEqual([{ bucket: bucket('minute'), window_start: windowAt('minute'), count: mode === 'after' ? 3 : 2, starts: 7 }]);
  });
}
for (const mode of ['before', 'after', 'late-abort'] as const) {
  it(`[original-negative] acquisition error owns one cleanup when refund ${mode}`, async () => {
    set('minute', 2); set('ip-minute', 3);
    if (mode === 'late-abort') db.exec("CREATE TRIGGER synthetic_refund_abort BEFORE UPDATE ON rate_counters WHEN OLD.bucket='studio:minute:biz' AND NEW.count<OLD.count BEGIN SELECT RAISE(ABORT,'SYNTHETIC_REFUND_LATE'); END;");
    const before = snapshot(); acquire = { suffix: 'ip-day', mode: 'before' }; refund = mode;
    const response = await request('provider'), after = snapshot(); capture(`refund-${mode}`, before, response, after);
    expect(refundAttempts).toBe(1); expect(response.status).toBe(500); expect(errors).toEqual([acquisitionError]); expect(fetches).toBe(0);
    expect(counters()).toEqual([
      { bucket: bucket('ip-minute'), window_start: windowAt('ip-minute'), count: mode === 'after' ? 3 : 4, starts: 7 },
      { bucket: bucket('minute'), window_start: windowAt('minute'), count: mode === 'after' ? 2 : 3, starts: 7 },
    ]);
    if (mode === 'after') expect(after).toEqual(before);
  });
}
it('[original-negative] peers and original windows survive a partial helper failure across midnight', async () => {
  for (const s of ['minute', 'ip-minute', 'ip-day'] as const) { set(s, 2); set(s, 7, now + 2000); }
  const before = snapshot();
  acquire = { suffix: 'ip-day', mode: 'before', peer: () => { set('minute', 4); set('ip-minute', 4); set('ip-day', 3); vi.setSystemTime(new Date(now + 2000)); } };
  const response = await request('ticket'), after = snapshot(); capture('peer-window', before, response, after);
  expect(response.status).toBe(500); expect(refundAttempts).toBe(1); expect(fetches).toBe(0);
  for (const s of ['minute', 'ip-minute', 'ip-day'] as const) {
    expect(counters().find(r => r.bucket === bucket(s) && r.window_start === windowAt(s))?.count).toBe(3);
    expect(counters().find(r => r.bucket === bucket(s) && r.window_start === windowAt(s, now + 2000))?.count).toBe(7);
  }
});
it('[original-negative] definite failure permits one explicit retry without leaked spend', async () => {
  const before = snapshot(); acquire = { suffix: 'ip-day', mode: 'before' };
  const failed = await request('ticket'), afterFailure = snapshot();
  const retry = await request('ticket'), afterRetry = snapshot(); capture('explicit-retry', before, failed, afterFailure, { retryStatus: retry.status, afterRetry });
  expect(afterFailure).toEqual(before); expect(failed.status).toBe(500); expect(retry.status).toBe(201); expect(refundAttempts).toBe(1);
  expect(counters().map(r => r.count)).toEqual([1, 1, 1]); expect(tableRows('SELECT * FROM calls')).toHaveLength(1);
});
// All null gates still choose their existing message/time and refund once.
for (const suffix of ['minute', 'ip-minute', 'ip-day', 'provider-day'] as const) {
  it(`provider concurrent null ${suffix} refunds only prior tokens with captured Retry-After`, async () => {
    const limits = { minute: 10, 'ip-minute': 20, 'ip-day': 150, 'provider-day': 50 };
    onAcquire = s => { if (s === suffix) { onAcquire = undefined; set(suffix, limits[suffix]); vi.setSystemTime(new Date(now + 2000)); } };
    const before = snapshot(), response = await request('provider'); capture(`null-${suffix}`, before, response, snapshot());
    expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('1'); expect(fetches).toBe(0);
    expect(counters()).toEqual([{ bucket: bucket(suffix), window_start: windowAt(suffix), count: limits[suffix], starts: 7 }]);
    expect(refundAttempts).toBe(suffix === 'minute' ? 0 : 1);
  });
}
for (const outcome of ['success', 'http', 'network'] as const) {
  it(`provider ${outcome} attempt retains four admitted charges`, async () => {
    vi.stubGlobal('fetch', async () => { fetches++; if (outcome === 'network') throw new Error('synthetic network'); return outcome === 'http' ? new Response('', { status: 401 }) : Response.json({ choices: [{ message: { content: 'OK' } }] }); });
    const before = snapshot(), response = await request('provider'); capture(`provider-${outcome}`, before, response, snapshot());
    expect(response.status).toBe(outcome === 'success' ? 200 : 502); expect(fetches).toBe(1); expect(refundAttempts).toBe(0);
    expect(counters().map(r => r.count)).toEqual([1, 1, 1, 1]);
  });
}
for (const mode of ['before', 'after'] as const) {
  it(`later ticket ${mode} preserves existing refund and ambiguous call semantics`, async () => {
    ticket = mode; const before = snapshot(), response = await request('ticket'); capture(`ticket-${mode}`, before, response, snapshot());
    expect(response.status).toBe(500); expect(refundAttempts).toBe(1); expect(counters()).toEqual([]); expect(errors).toContain(ticketError);
    expect(tableRows('SELECT * FROM calls')).toHaveLength(mode === 'after' ? 1 : 0);
  });
}
it('known full IP is read-only and does not acquire or refund', async () => {
  set('ip-day', 150); const before = snapshot(), response = await request('ticket'); capture('known-full', before, response, snapshot());
  expect(response.status).toBe(429); expect(snapshot()).toEqual(before); expect(writes).toEqual([]); expect(refundAttempts).toBe(0);
});
it('invalid provider config has no Studio admission or provider attempt', async () => {
  // Empty instance keys are supported. A custom endpoint without its own key
  // is the actual configuration refusal; reconcile it before the baseline.
  db.exec("UPDATE provider_settings SET llm_base_url='https://custom.example/v1',llm_api_key='' WHERE business_id='biz'; UPDATE agent_settings SET llm_base_url='https://custom.example/v1',llm_api_key='' WHERE business_id='biz';");
  const boot = await worker.fetch(new Request('https://openfon.test/api/me/bootstrap', { headers: { Cookie: 'ofs=session' } }), env, {} as ExecutionContext);
  expect(boot.status).toBe(200);
  const before = snapshot(), response = await request('provider'); capture('invalid-config', before, response, snapshot());
  expect(response.status).toBe(400); expect(snapshot()).toEqual(before); expect(writes).toEqual([]); expect(fetches).toBe(0);
});
it('missing owned ticket target has no Studio admission', async () => {
  const before = snapshot(), response = await request('ticket', '/api/me/assistants/missing/test-calls'); capture('missing-target', before, response, snapshot());
  expect(response.status).toBe(404); expect(snapshot()).toEqual(before); expect(writes).toEqual([]);
});
it('[original-negative] provider acquisition cleanup retains completed foundation reconstruction', async () => {
  db.exec("DELETE FROM assistants WHERE business_id='biz'"); const initial = snapshot(); let baseline: ReturnType<typeof snapshot> | undefined;
  onAcquire = suffix => { if (suffix === 'minute') { baseline = snapshot(); onAcquire = undefined; } };
  acquire = { suffix: 'ip-day', mode: 'before' };
  const response = await request('provider'), after = snapshot(); capture('foundation-preserved', initial, response, after, { baseline });
  expect(baseline).toBeDefined(); expect(baseline).not.toEqual(initial); expect(after).toEqual(baseline); expect(response.status).toBe(500); expect(refundAttempts).toBe(1);
});
it('later ticket foundation failure refunds once without changing the primary error', async () => {
  const fault = new Error('SYNTHETIC_FOUNDATION');
  db.hook = sql => { if (sql.startsWith('SELECT * FROM businesses WHERE user_id = ?')) throw fault; };
  try {
    const before = snapshot(), response = await request('ticket'); capture('ticket-foundation-failure', before, response, snapshot());
    expect(response.status).toBe(500); expect(snapshot()).toEqual(before); expect(refundAttempts).toBe(1); expect(errors).toEqual([fault]);
  } finally { db.hook = null; }
});
it('null-gate refund rejection does not cause a second refund attempt', async () => {
  onAcquire = suffix => { if (suffix === 'ip-day') { onAcquire = undefined; set('ip-day', 150); } };
  refund = 'after'; const before = snapshot(), response = await request('provider'); capture('null-refund-rejected', before, response, snapshot());
  expect(response.status).toBe(500); expect(refundAttempts).toBe(1); expect(errors).toEqual([refundError]);
  expect(counters()).toEqual([{ bucket: bucket('ip-day'), window_start: windowAt('ip-day'), count: 150, starts: 7 }]);
});
