import { AsteriskAuthBudget, asteriskAuthBudget, asteriskIngressBudget } from '../src/asterisk-auth-budget';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { hashPassword } from '../src/auth';
import { applyMigrations, SqliteD1 } from './sqlite-d1';
import { fakeEnv, fakeCtx } from './fake-d1';
import type { Env } from '../src/types';
let db: SqliteD1;
let env: Env;
const password = 'synthetic-password-with-at-least-32-bytes';
const authorization = 'Basic ' + btoa('pbx:' + password);
const dispatch = vi.fn(async (_request: Request) => new Response(null));
beforeEach(async () => {
  const budget=new AsteriskAuthBudget();vi.spyOn(asteriskAuthBudget,'acquire').mockImplementation(()=>budget.acquire());
  const ingress=new AsteriskAuthBudget();vi.spyOn(asteriskIngressBudget,'acquire').mockImplementation(()=>ingress.acquire());
  dispatch.mockImplementation(async()=>new Response(null));
  db = new SqliteD1(); applyMigrations(db); dispatch.mockClear();
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','biz','Business');
    INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language) VALUES('assistant','biz','assistant','active','Alex','Helpful','en');`);
  await db.prepare("INSERT INTO asterisk_routes(id,business_id,assistant_id,password_sha256,enabled,password_hash) VALUES('pbx','biz','assistant',lower(hex(randomblob(32))),1,?)").bind(await hashPassword(password)).run();
  env = { ...fakeEnv(undefined as never), DB: db as unknown as D1Database, ASTERISK_ENABLED: 'true',
    ASTERISK_CALL: { idFromName: (id: string) => id, get: () => ({ fetch: dispatch }) } } as unknown as Env;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });
function connect(auth?: string, route = 'pbx', call = 'test', source = '192.0.2.1') {
  return worker.fetch(new Request(`https://example.invalid/ws/asterisk/${route}?call=${call}`, { headers: {
    Upgrade: 'websocket', 'CF-Connecting-IP': source, 'X-Openfon-Asterisk-Admission': 'f'.repeat(64), ...(auth ? { Authorization: auth } : {}),
  } }), env, fakeCtx);
}
const changes = () => db.database.prepare('SELECT total_changes() AS n').get();
it('rejects missing, invalid and revoked PBX credentials without any D1 writes or dispatch', async () => {
  const before = changes();
  for (let i = 0; i < 125; i++) {
    expect([401,429]).toContain((await connect()).status);
    expect([401,429]).toContain((await connect('Basic ' + btoa('pbx:' + 'x'.repeat(32)))).status);
    expect([401,429]).toContain((await connect('Basic ' + btoa('unknown:' + password), 'unknown')).status);
  }
  expect(changes()).toEqual(before);
  db.exec("UPDATE asterisk_routes SET enabled=0 WHERE id='pbx'");
  const revoked = changes();
  expect([401,429]).toContain((await connect(authorization)).status);
  expect(changes()).toEqual(revoked);
  expect(db.database.prepare("SELECT count(*) AS n FROM rate_counters WHERE bucket LIKE 'asterisk:%'").get()).toEqual({ n: 0 });
  expect(dispatch).not.toHaveBeenCalled();
});
it.each(['concurrency','daily'])('rejects known-full %s quota with zero D1 write attempts or owner contact', async quota => {
  db.exec("UPDATE businesses SET max_concurrent_calls=1,max_calls_per_day=1");
  db.exec(quota === 'concurrency'
    ? "INSERT INTO calls(id,business_id,channel,environment,reserved_at,started_at) VALUES('prior','biz','telnyx','live',datetime('now'),datetime('now','-2 days'))"
    : "INSERT INTO calls(id,business_id,status,environment,carrier_released_at) VALUES('prior','biz','completed','live',datetime('now'))");
  const before=changes();const writes:string[]=[];
  db.hook=sql=>{if (!sql.trimStart().startsWith('SELECT')) writes.push(sql);};
  for(let i=0;i<4;i++) expect((await connect(authorization,'pbx','fresh-'+i)).status).toBe(403);
  expect(writes).toEqual([]);expect(changes()).toEqual(before);expect(dispatch).not.toHaveBeenCalled();
});
it('dispatches within capacity without public D1 writes and replaces forged admission headers',async()=>{
  const before=changes();
  expect((await connect(authorization)).status).toBe(200);
  expect(changes()).toEqual(before);expect(dispatch).toHaveBeenCalledTimes(1);
  const request=dispatch.mock.calls[0][0] as Request;
  expect(request.headers.has('Authorization')).toBe(false);
  expect(request.headers.get('X-Openfon-Asterisk-Admission')).toMatch(/^[a-f0-9]{64}$/);
  expect(request.headers.get('X-Openfon-Asterisk-Admission')).not.toBe('f'.repeat(64));
});
it('bounds bursts independently of caller identifiers and refills without persistent writes',async()=>{
  const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);
  const before=changes();
  for(let i=0;i<16;i++)expect((await connect(authorization,'pbx','call-'+i,'192.0.2.'+i)).status).toBe(200);
  expect((await connect(authorization,'pbx','overflow','198.51.100.1')).status).toBe(429);
  expect(dispatch).toHaveBeenCalledTimes(16);expect(changes()).toEqual(before);
  vi.spyOn(Date,'now').mockReturnValue(now+500);
  expect((await connect(authorization,'pbx','refill')).status).toBe(200);
  expect(changes()).toEqual(before);
});
it('holds at most four ingress slots through pending owner responses and releases on errors',async()=>{
  const pending: (()=>void)[]=[];
  let started!:()=>void;const fourStarted=new Promise<void>(resolve=>{started=resolve;});
  dispatch.mockImplementation(()=>new Promise<Response>((resolve)=>{pending.push(()=>resolve(new Response(null)));if(pending.length===4)started();}));
  const requests=Array.from({length:4},()=>connect(authorization));
  await fourStarted;expect(dispatch).toHaveBeenCalledTimes(4);
  const before=changes();expect((await connect(authorization)).status).toBe(429);expect(changes()).toEqual(before);
  for(const resolve of pending)resolve();await Promise.all(requests);
  dispatch.mockRejectedValueOnce(Error('owner unavailable'));
  expect((await connect(authorization)).status).toBe(500);
  dispatch.mockImplementation(async()=>new Response(null));
  expect((await connect(authorization)).status).toBe(200);
});
it('retains rolling-day exclusions and counts only occupied live calls',async()=>{
  db.exec("UPDATE businesses SET max_concurrent_calls=1,max_calls_per_day=1");
  db.exec(`INSERT INTO calls(id,business_id,status,environment,started_at,connected_at,carrier_released_at) VALUES
    ('old','biz','completed','live',datetime('now','-2 days'),NULL,datetime('now')),
    ('abandoned','biz','abandoned','live',datetime('now'),NULL,NULL),
    ('preview','biz','active','test',datetime('now'),datetime('now'),NULL)`);
  expect((await connect(authorization)).status).toBe(200);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
