import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../src/index';
import { SqliteD1, applyMigrations } from './sqlite-d1';
import { fakeEnv, fakeCtx } from './fake-d1';
import type { Env } from '../src/types';
let db: SqliteD1, env: Env;
beforeEach(() => {
  db = new SqliteD1(); applyMigrations(db);
  for (const file of ['0026_business_actions.sql', '0027_commercial.sql'])
    db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  db.exec("INSERT INTO users(id,email,password_hash)VALUES('owner','owner@example.invalid','synthetic');INSERT INTO sessions(token,user_id,expires_at)VALUES('test-session','owner','2099-01-01T00:00:00Z');INSERT INTO businesses(id,user_id,slug,name)VALUES('business','owner','business','Business');INSERT INTO assistants(id,business_id,public_slug,name,voice,realtime_voice)VALUES('assistant','business','assistant','Original','marin','marin')");
  env = { ...fakeEnv(), DB: db, OPENFON_MANAGED_WEB: 'true' } as unknown as Env;
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
for (const method of ['POST', 'PUT']) for (const mode of ['length', 'no-length', 'transfer-encoding'] as const) {
  it(`full managed ${method} bounds streamed body before parse (${mode})`, async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: 'Should not save', voice: 'marin', ignored: 'x'.repeat(1024 * 1024) }));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (sent === bytes.length) return controller.close();
      const end = Math.min(sent + 8192, bytes.length); controller.enqueue(bytes.slice(sent, end)); sent = end;
    }});
    const headers: Record<string,string> = { cookie: 'ofs=test-session', 'content-type': 'application/json' };
    if (mode === 'length') headers['content-length'] = String(bytes.length);
    if (mode === 'transfer-encoding') headers['content-length'] = '1';
    if (mode === 'transfer-encoding') headers['transfer-encoding'] = 'chunked';
    const cloned = vi.spyOn(Request.prototype, 'clone');
    const parsed = vi.spyOn(Request.prototype, 'json');
    const response = await worker.fetch(new Request('https://openfon.test/api/me/assistants' + (method === 'PUT' ? '/assistant' : ''), {method,headers,body,duplex:'half'} as RequestInit), env, fakeCtx);
    expect(response.status).toBe(413);
    expect(cloned).not.toHaveBeenCalled(); expect(parsed).not.toHaveBeenCalled();
    expect(sent).toBeLessThanOrEqual(144 * 1024);
    expect(db.database.prepare('SELECT name FROM assistants').all()).toEqual([{name:'Original'}]);
  });
}
it('rejects unauthenticated streaming requests before reading or parsing their body', async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({pull(controller) { pulls++; controller.enqueue(new Uint8Array(8192)); }});
  const cloned = vi.spyOn(Request.prototype,'clone'), parsed = vi.spyOn(Request.prototype,'json');
  const response = await worker.fetch(new Request('https://openfon.test/api/me/assistants',{method:'POST',body,duplex:'half'} as RequestInit),env,fakeCtx);
  expect(response.status).toBe(401);expect(pulls).toBeLessThanOrEqual(1);expect(cloned).not.toHaveBeenCalled();expect(parsed).not.toHaveBeenCalled();
});
