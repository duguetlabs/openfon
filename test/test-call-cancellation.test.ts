import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { fakeCtx, fakeEnv } from './fake-d1';
import { applyMigrations, SqliteD1 } from './sqlite-d1';
import type { Env } from '../src/types';

let db: SqliteD1;
let env: Env;
const cancel = (id: string, token = 'owner-session') => worker.fetch(
  new Request(`https://openfon.test/api/me/test-calls/${id}`, {
    method: 'DELETE', headers: { Cookie: `ofs=${token}` },
  }), env, fakeCtx,
);

beforeEach(() => {
  db = new SqliteD1();
  applyMigrations(db);
  env = { ...fakeEnv(), DB: db as unknown as D1Database };
  for (const id of ['owner', 'other']) {
    db.exec(`INSERT INTO users(id,email,password_hash) VALUES('${id}','${id}@example.test','unused');
      INSERT INTO businesses(id,user_id,slug,name) VALUES('biz-${id}','${id}','${id}','${id}');
      INSERT INTO sessions(token,user_id,expires_at) VALUES('${id}-session','${id}','2999-01-01T00:00:00.000Z');`);
  }
});
afterEach(() => db.close());

const insert = (id: string, business = 'biz-owner', environment = 'test', connected: string | null = null, status = 'active') =>
  db.database.prepare('INSERT INTO calls(id,business_id,environment,connected_at,status) VALUES(?,?,?,?,?)')
    .run(id, business, environment, connected, status);

describe('unused test call cancellation', () => {
  it('revokes the owned unused ticket idempotently and removes its daily reservation', async () => {
    insert('pending');
    expect((await cancel('pending')).status).toBe(200);
    expect((await cancel('pending')).status).toBe(200);
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM calls').get()).toEqual({ n: 0 });
    const socket = await worker.fetch(new Request('https://openfon.test/ws/call/pending', {
      headers: { Upgrade: 'websocket', Cookie: 'ofs=owner-session' },
    }), env, fakeCtx);
    expect(socket.status).toBe(404);
  });

  it('requires authentication and preserves foreign, live, connected and historical calls', async () => {
    insert('pending');
    insert('foreign', 'biz-other');
    insert('live', 'biz-owner', 'live');
    insert('connected', 'biz-owner', 'test', '2026-01-01');
    insert('history', 'biz-owner', 'test', null, 'abandoned');
    expect((await cancel('pending', 'invalid')).status).toBe(401);
    for (const id of ['foreign', 'live', 'connected', 'history']) {
      expect((await cancel(id)).status).toBe(200);
    }
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM calls').get()).toEqual({ n: 5 });
  });

  it('preserves a call when the websocket connection claim wins the race', async () => {
    insert('racing');
    db.hook = sql => {
      if (sql.startsWith('DELETE FROM calls')) {
        db.hook = null;
        db.database.prepare("UPDATE calls SET connected_at=datetime('now') WHERE id='racing'").run();
      }
    };
    expect((await cancel('racing')).status).toBe(200);
    expect(db.database.prepare("SELECT connected_at FROM calls WHERE id='racing'").get())
      .toHaveProperty('connected_at', expect.any(String));
  });
});
