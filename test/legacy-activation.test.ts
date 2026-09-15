import { afterEach, expect, it } from 'vitest';
import worker from '../src/index';
import { applyMigrations, SqliteD1 } from './sqlite-d1';
import { fakeCtx, fakeEnv } from './fake-d1';

let db: SqliteD1;
afterEach(() => db?.close());
function setup(through: number) {
  db = new SqliteD1(); applyMigrations(db,1,through);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('u','legacy@example.test','unused');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES('b','u','legacy','Legacy','A repair shop');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('s','u','2099-01-01');`);
}
function request(path: string, method = 'GET') {
  return worker.fetch(new Request(`https://openfon.test${path}`, { method, headers:{Cookie:'ofs=s'} }),
    {...fakeEnv(),DB:db as unknown as D1Database},fakeCtx);
}
async function remainsPrivate() {
  expect((await request('/api/public/agent/legacy')).status).toBe(404);
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  expect((await request('/api/public/agent/legacy')).status).toBe(404);
  expect(db.database.prepare("SELECT state,activated_at FROM assistants WHERE public_slug='legacy'").get())
    .toEqual({state:'draft',activated_at:null});
}

it('migrates a business without legacy settings as private, including subsequent repair', async () => {
  setup(7); applyMigrations(db,8);
  expect(db.database.prepare("SELECT state,activated_at FROM assistants WHERE id='asst_b'").get())
    .toEqual({state:'draft',activated_at:null});
  await remainsPrivate();
});

it('repairs an identifiable old migration activation without changing other assistants', async () => {
  setup(7); applyMigrations(db,8,18);
  // Model the original0008 row before its missing-settings correction.
  db.exec("UPDATE assistants SET state='active',activated_at=created_at WHERE id='asst_b'; INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language) VALUES('custom','b','independent','active','Custom','Helpful','en');");
  applyMigrations(db,19,19);
  expect(db.database.prepare("SELECT state FROM assistants WHERE id='custom'").get()).toEqual({state:'active'});
  await remainsPrivate();
});

it('keeps an existing private assistant private when its legacy adapter and snapshot are lost', async () => {
  setup(19);
  db.exec("INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language) VALUES('custom','b','legacy','draft','Maya','Helpful','en');");
  await remainsPrivate();
  // A later genuine legacy edit still has its existing compatibility semantics.
  db.exec("UPDATE agent_settings SET agent_name='Edited Maya' WHERE business_id='b'");
  expect((await request('/api/public/agent/legacy')).status).toBe(200);
});

it('conservatively pauses a configured canonical row with later adapter loss until explicit activation', async () => {
  setup(7);
  db.exec("INSERT INTO agent_settings(business_id,agent_name,persona,language) VALUES('b','Maya','Helpful','en');");
  applyMigrations(db,8,18);
  db.exec("DELETE FROM agent_settings WHERE business_id='b'");
  applyMigrations(db,19,19);
  await remainsPrivate();
  expect(db.database.prepare("SELECT name,persona FROM assistants WHERE id='asst_b'").get()).toEqual({name:'Maya',persona:'Helpful'});
  expect((await request('/api/me/assistants/asst_b/activate','POST')).status).toBe(200);
  expect((await request('/api/public/agent/legacy')).status).toBe(200);
});

it('does not activate defaults when both assistant and legacy settings are absent', async () => {
  setup(19);
  // Real concurrent D1 transactions are covered by the workerd probe; this
  // synchronous SQLite helper cannot nest overlapping asynchronous batches.
  expect((await request('/api/me/bootstrap')).status).toBe(200);
  await remainsPrivate();
});

it('preserves a configured legacy assistant during the complete upgrade', async () => {
  setup(7);
  db.exec("INSERT INTO agent_settings(business_id,agent_name,persona,language) VALUES('b','Maya','Helpful','en');");
  applyMigrations(db,8);
  expect((await request('/api/public/agent/legacy')).status).toBe(200);
  expect(db.database.prepare("SELECT state,name FROM assistants WHERE id='asst_b'").get()).toEqual({state:'active',name:'Maya'});
});
