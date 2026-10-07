import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { SqliteD1, applyMigrations } from './sqlite-d1';
import { fakeEnv, fakeCtx } from './fake-d1';
import { persistCallActions } from '../src/managed-actions';
import type { Env } from '../src/types';
const summary = 'Synthetic failure: Azure https://fixture.invalid/private?token=synthetic-only';
const opaque = 'Synthetic failure at tenant-internal-slot-42: route-seven token synthetic-only';
const placeholder = 'Appointment requested. Review the source call for details.';
const failedSummary = 'The call could not complete. Review its transcript for any captured conversation.';
let db: SqliteD1;
let env: Env;
beforeEach(() => {
  db = new SqliteD1(); applyMigrations(db);
  db.exec("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','synthetic'),('peer','peer@example.invalid','synthetic'); INSERT INTO sessions(token,user_id,expires_at) VALUES('owner-session','owner','2099-01-01T00:00:00Z'); INSERT INTO businesses(id,user_id,slug,name) VALUES('business','owner','owned','Owned'),('peer','peer','peer','Peer');");
  env = { ...fakeEnv(), DB: db, OPENFON_MANAGED_WEB: 'true' } as unknown as Env;
});
afterEach(() => db.close());
function migrate() {
  for (const file of ['0026_business_actions.sql', '0027_commercial.sql', '0028_business_country.sql']) db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
}
function seed(id: string, status = 'failed', text = summary, business = 'business') {
  db.database.prepare('INSERT INTO calls(id,business_id,status,intent,summary,environment) VALUES(?,?,?,?,?,?)').run(id,business,status,'booking',text,'live');
}
function call(path: string) { return worker.fetch(new Request('https://openfon.test'+path,{headers:{cookie:'ofs=owner-session'}}),env,fakeCtx); }
for (const boundary of ['migration', 'insert', 'update']) it(`keeps failed legacy diagnostics out of the ${boundary} booking projection`, () => {
  if (boundary === 'migration') { seed('failed'); migrate(); }
  else { migrate(); seed('failed', boundary === 'insert' ? 'failed' : 'active'); if (boundary === 'update') db.exec("UPDATE calls SET status='failed' WHERE id='failed'"); }
  expect(db.database.prepare("SELECT content FROM action_items WHERE id='action_booking_failed'").get()).toEqual({content:placeholder});
  expect(db.database.prepare("SELECT summary FROM calls WHERE id='failed'").get()).toEqual({summary});
});
for (const destination of ['actions','export']) it(`redacts previously projected legacy diagnostics at customer ${destination} without changing stored evidence`, async () => {
  migrate(); seed('failed');
  db.database.prepare("UPDATE action_items SET content=?,status='handled' WHERE id='action_booking_failed'").run(summary);
  db.exec("INSERT INTO call_action_extractions(call_id,token) VALUES('failed','later-seal')");
  const response = await call(destination === 'actions' ? '/api/me/actions?environment=all' : '/api/me/account/export');
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  const items = destination === 'actions' ? body.items : body.data.action_items;
  expect(items.find((item: any) => item.call_id === 'failed')).toMatchObject({id:'action_booking_failed',call_id:'failed',content:placeholder,status:'handled'});
  expect(JSON.stringify(body)).not.toContain('fixture.invalid');
  expect(db.database.prepare("SELECT content FROM action_items WHERE id='action_booking_failed'").get()).toEqual({content:summary});
});
it('redacts arbitrary failed-call exception summaries in call detail and export without keyword guessing', async () => {
  migrate(); seed('opaque', 'failed', opaque);
  db.exec("INSERT INTO call_turns(call_id,role,text,ts) VALUES('opaque','caller','Please call me tomorrow','2026-10-05T00:00:00Z')");
  const detail = await (await call('/api/me/calls/opaque')).json() as any;
  expect(detail.summary).toBe(failedSummary);
  expect(detail.turns[0].text).toBe('Please call me tomorrow');
  const exported = await (await call('/api/me/account/export')).json() as any;
  expect(exported.data.calls.find((item: any) => item.id === 'opaque').summary).toBe(failedSummary);
  expect(db.database.prepare("SELECT summary FROM calls WHERE id='opaque'").get()).toEqual({summary:opaque});
});
it('preserves completed business content, structured booking keys, messages and tenant boundaries', async () => {
  migrate(); seed('completed', 'completed', 'Visit Azure Street for an appointment'); seed('structured','active'); seed('other','failed',summary,'peer');
  await persistCallActions(env,'structured',[{source_key:'booking',kind:'booking_request',content:'Book a visit to Azure Street'},{source_key:'message',kind:'message',content:'Please call me tomorrow'}]);
  db.exec("UPDATE calls SET status='failed' WHERE id='structured'");
  const body = await (await call('/api/me/actions?environment=all')).json() as any;
  expect(body.items.map((item: any) => item.content)).toEqual(expect.arrayContaining(['Visit Azure Street for an appointment','Book a visit to Azure Street','Please call me tomorrow']));
  expect(body.items.some((item: any) => item.business_id === 'peer')).toBe(false);
  expect(body.items.find((item: any) => item.id === 'action_structured_booking').content).toBe('Book a visit to Azure Street');
});
