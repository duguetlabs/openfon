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
const dispatch = vi.fn(async () => new Response(null));
beforeEach(async () => {
  db = new SqliteD1(); applyMigrations(db); dispatch.mockClear();
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','biz','Business');
    INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language) VALUES('assistant','biz','assistant','active','Alex','Helpful','en');`);
  await db.prepare("INSERT INTO asterisk_routes(id,business_id,assistant_id,password_sha256,enabled,password_hash) VALUES('pbx','biz','assistant',lower(hex(randomblob(32))),1,?)").bind(await hashPassword(password)).run();
  env = { ...fakeEnv(undefined as never), DB: db as unknown as D1Database, ASTERISK_ENABLED: 'true',
    ASTERISK_CALL: { idFromName: (id: string) => id, get: () => ({ fetch: dispatch }) } } as unknown as Env;
});
afterEach(() => db.close());
function connect(auth?: string, route = 'pbx') {
  return worker.fetch(new Request(`https://example.invalid/ws/asterisk/${route}?call=test`, { headers: {
    Upgrade: 'websocket', 'CF-Connecting-IP': '192.0.2.1', ...(auth ? { Authorization: auth } : {}),
  } }), env, fakeCtx);
}
const changes = () => db.database.prepare('SELECT total_changes() AS n').get();
it('rejects missing, invalid and revoked PBX credentials without any D1 writes or dispatch', async () => {
  const before = changes();
  for (let i = 0; i < 125; i++) {
    expect((await connect()).status).toBe(401);
    expect((await connect('Basic ' + btoa('pbx:' + 'x'.repeat(32)))).status).toBe(401);
    expect((await connect('Basic ' + btoa('unknown:' + password), 'unknown')).status).toBe(401);
  }
  expect(changes()).toEqual(before);
  db.exec("UPDATE asterisk_routes SET enabled=0 WHERE id='pbx'");
  const revoked = changes();
  expect((await connect(authorization)).status).toBe(401);
  expect(changes()).toEqual(revoked);
  expect(db.database.prepare("SELECT count(*) AS n FROM rate_counters WHERE bucket LIKE 'asterisk:%'").get()).toEqual({ n: 0 });
  expect(dispatch).not.toHaveBeenCalled();
});
it('retains the rate cap for authenticated PBX requests', async () => {
  expect((await connect(authorization)).status).toBe(200);
  expect(dispatch).toHaveBeenCalledTimes(1);
  db.exec("UPDATE rate_counters SET count=120 WHERE bucket LIKE 'asterisk:%'");
  const before = changes();
  expect((await connect(authorization)).status).toBe(429);
  expect(changes()).toEqual(before);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
