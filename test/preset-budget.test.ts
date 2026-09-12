import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../src/index';
import { applyMigrations, SqliteD1 } from './sqlite-d1';
import { fakeEnv, fakeCtx } from './fake-d1';
import type { Env } from '../src/types';
let db: SqliteD1, env: Env;
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
  db=new SqliteD1();applyMigrations(db);
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','unused');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('session','owner','2026-09-10T12:00:00Z');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','biz','Business');`);
  env={...fakeEnv(undefined as never),DB:db as unknown as D1Database};
  expect((await request('/api/me/bootstrap')).status).toBe(200);
});
afterEach(()=>{db.close();vi.useRealTimers();});
function request(path:string,body?:unknown,method=body===undefined?'GET':'POST') {
 return worker.fetch(new Request('https://example.invalid'+path,{method,headers:{Cookie:'ofs=session','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,fakeCtx);
}
const changes=()=>db.database.prepare('SELECT total_changes() AS n').get();
const rows=()=>db.database.prepare('SELECT id,name FROM engine_profiles ORDER BY id').all();
function seed(id:string,name='Preset') {
 for(const table of ['engine_profiles','engine_presets'])db.database.prepare(`INSERT INTO ${table}(id,business_id,name) VALUES(?,'biz',?)`).run(id,name);
}
function removeBudgets(){for(const table of ['engine_profiles','engine_presets'])for(const action of ['insert','update'])db.exec(`DROP TRIGGER ${table}_${action}_budget`);}
function restoreBudgets(){db.exec(readFileSync(new URL('../migrations/0017_preset_budgets.sql',import.meta.url),'utf8'));}
it('caps both API writers with write-free known refusals and deletion recovery',async()=>{
 for(let i=0;i<64;i++)seed(`p${i}`);
 const before=changes();
 for(const path of ['/api/me/engine-presets','/api/me/business/biz/profiles'])expect((await request(path,{name:'Overflow'})).status).toBe(409);
 const refused=await request('/api/me/engine-presets',{name:'Overflow'});expect((await refused.json() as {error:string}).error).toContain('storage limit');
 expect(changes()).toEqual(before);expect(rows()).toHaveLength(64);
 expect((await request('/api/me/profiles/p0',undefined,'DELETE')).status).toBe(200);
 expect((await request('/api/me/engine-presets',{name:'Replacement'})).status).toBe(201);
 expect(rows()).toHaveLength(64);
});
it('preflights both mirrored tables and the second write at daily399 without partial writes',async()=>{
 seed('p');db.exec("UPDATE rate_counters SET count=399 WHERE bucket='presets:biz'");
 const before=changes(),original=rows();
 for(const [path,method] of [['/api/me/engine-presets','POST'],['/api/me/business/biz/profiles','POST'],['/api/me/engine-presets/p','PUT'],['/api/me/profiles/p','PUT']])expect((await request(path,{name:'Rejected'},method)).status).toBe(429);
 expect(changes()).toEqual(before);expect(rows()).toEqual(original);
 expect((await request('/api/me/bootstrap')).status).toBe(200);
 vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
 expect((await request('/api/me/profiles/p',{name:'Tomorrow'},'PUT')).status).toBe(200);
});
it('bounds UTF8 bytes in both tables and permits shrinking historical rows',async()=>{
 seed('p');
 const size=()=>Number((db.database.prepare(`SELECT SUM(length(CAST(id AS BLOB))+length(CAST(name AS BLOB))+length(CAST(engine AS BLOB))+length(CAST(realtime_model AS BLOB))+length(CAST(realtime_voice AS BLOB))+length(CAST(language AS BLOB))+length(CAST(voice AS BLOB))+length(CAST(llm_model AS BLOB))) AS n FROM engine_presets`).get() as {n:number}).n);
 const room=524288-size();db.database.prepare("UPDATE engine_presets SET name=name||? WHERE id='p'").run('é'.repeat(Math.floor(room/2))+'x'.repeat(room%2));
 expect(size()).toBe(524288);const before=changes();
 expect((await request('/api/me/business/biz/profiles',{name:'Overflow'})).status).toBe(409);expect(changes()).toEqual(before);
 expect((await request('/api/me/engine-presets/p',{name:'Small'},'PUT')).status).toBe(200);
 removeBudgets();db.database.prepare("UPDATE engine_profiles SET name=? WHERE id='p'").run('x'.repeat(600000));restoreBudgets();
 expect((await request('/api/me/profiles/p',{name:'Small'},'PUT')).status).toBe(200);
});
it('rolls back concurrent boundary batches and rejects workspace moves',async()=>{
 for(let i=0;i<63;i++)seed(`p${i}`);
 await expect(db.batch([db.prepare("INSERT INTO engine_profiles(id,business_id,name) VALUES('last','biz','Last')"),db.prepare("INSERT INTO engine_profiles(id,business_id,name) VALUES('overflow','biz','Overflow')")])).rejects.toThrow('OPENFON_PRESET_STORAGE_LIMIT');
 expect(rows()).toHaveLength(63);
 expect(()=>db.exec("UPDATE engine_profiles SET business_id='elsewhere' WHERE id='p0'")).toThrow('OPENFON_PRESET_WORKSPACE_CHANGE');
});
it('keeps historical oversized reconciliation out of JS and provides bounded removable previews',async()=>{
 removeBudgets();for(let i=0;i<70;i++)seed(`p${String(i).padStart(3,'0')}`,'é'.repeat(9000));restoreBudgets();
 let fullProfileLoads=0;db.hook=sql=>{if(/SELECT \* FROM engine_(profiles|presets) WHERE business_id = \? ORDER BY id/.test(sql))fullProfileLoads++;};
 const before=rows();const bootstrap=await request('/api/me/bootstrap');expect(fullProfileLoads).toBe(0);expect(bootstrap.status).toBe(200);expect(rows()).toEqual(before);
 const response=await request('/api/me/business/biz/profiles');const text=await response.text();expect(text.length).toBeLessThan(100000);
 const previews=JSON.parse(text);expect(previews).toHaveLength(64);expect(previews[0].name).toHaveLength(256);expect(previews[0].preview_only).toBe(1);
 expect((await request('/api/me/profiles/p000',undefined,'DELETE')).status).toBe(200);
 const next=await (await request('/api/me/business/biz/profiles')).json() as {id:string}[];expect(next.some(p=>p.id==='p064')).toBe(true);
});
it('repairs only changed rows at the exact daily boundary and defers exhausted repair',async()=>{
 seed('p');db.exec("UPDATE engine_profiles SET name='Updated' WHERE id='p'; UPDATE rate_counters SET count=400 WHERE bucket='presets:biz'");
 expect((await request('/api/me/bootstrap')).status).toBe(200);
 expect(await db.prepare("SELECT name FROM engine_presets WHERE id='p'").first()).toEqual({name:'Preset'});
 db.exec("UPDATE rate_counters SET count=399 WHERE bucket='presets:biz'");
 expect((await request('/api/me/bootstrap')).status).toBe(200);
 expect(await db.prepare("SELECT name FROM engine_presets WHERE id='p'").first()).toEqual({name:'Updated'});
 const before=changes();expect((await request('/api/me/bootstrap')).status).toBe(200);expect(changes()).toEqual(before);
});
it('shrinks mirror rows before growing siblings when a fitting swap crosses the interim byte cap',async()=>{
 seed('a','Small');seed('z','x'.repeat(400000));
 // Reverse the sizes without ever exceeding the legacy table cap.
 db.exec("UPDATE engine_profiles SET name='Small' WHERE id='z'");
 db.database.prepare("UPDATE engine_profiles SET name=? WHERE id='a'").run('x'.repeat(400000));
 expect((await request('/api/me/bootstrap')).status).toBe(200);
 expect(await db.prepare("SELECT length(name) AS n FROM engine_presets WHERE id='a'").first()).toEqual({n:400000});
 expect(await db.prepare("SELECT name FROM engine_presets WHERE id='z'").first()).toEqual({name:'Small'});
});
it('a refused preset creation does not run unrelated legacy reconciliation first',async()=>{
 for(let i=0;i<64;i++)seed(`p${i}`);
 db.exec("UPDATE engine_profiles SET name='Pending legacy edit' WHERE id='p0'");
 const before=changes();
 expect((await request('/api/me/engine-presets',{name:'No room'})).status).toBe(409);
 expect(changes()).toEqual(before);
 expect(await db.prepare("SELECT name FROM engine_presets WHERE id='p0'").first()).toEqual({name:'Preset'});
});
it('marks NUL-shortened previews read-only without changing their stored bytes',async()=>{
 seed('nul','Visible\0hidden suffix');
 const stored=await db.prepare("SELECT hex(name) AS bytes FROM engine_profiles WHERE id='nul'").first();
 const response=await request('/api/me/business/biz/profiles');
 const list=await response.json() as {id:string;name:string;preview_only:number}[];
 expect(list[0].name).toBe('Visible');expect(list[0].preview_only).toBe(1);
 expect(await db.prepare("SELECT hex(name) AS bytes FROM engine_profiles WHERE id='nul'").first()).toEqual(stored);
});
