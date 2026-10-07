import {afterEach,beforeEach,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import worker from '../src/index';
import {SqliteD1,applyMigrations} from './sqlite-d1';
import {fakeEnv,fakeCtx} from './fake-d1';
import type {Env} from '../src/types';
let db:SqliteD1,env:Env;
beforeEach(()=>{
 db=new SqliteD1();applyMigrations(db);
 for(const name of ['0026_business_actions','0027_commercial','0028_business_country'])db.exec(readFileSync('migrations/'+name+'.sql','utf8'));
 db.exec("INSERT INTO users(id,email,password_hash)VALUES('owner','owner@example.invalid','hash'),('other','other@example.invalid','hash'); INSERT INTO sessions(token,user_id,expires_at)VALUES('session','owner','2999-01-01');");
 env={...fakeEnv(),DB:db,OPENFON_MANAGED_WEB:'true'} as unknown as Env;
});
afterEach(()=>db.close());
const request=(path:string,method='GET',body?:unknown)=>worker.fetch(new Request('https://openfon.test'+path,{method,headers:{Cookie:'ofs=session','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env,fakeCtx);
it('keeps existing location unknown and preserves all old values in the additive migration',()=>{
 const old=new SqliteD1();try{applyMigrations(old);old.exec("INSERT INTO users(id,email,password_hash)VALUES('u','x@example.invalid','hash');INSERT INTO businesses(id,user_id,slug,name,address,timezone)VALUES('b','u','b','Existing','Old street','America/Santiago')");const before=old.database.prepare('SELECT * FROM businesses').get();old.exec(readFileSync('migrations/0028_business_country.sql','utf8'));expect(old.database.prepare('SELECT * FROM businesses').get()).toEqual({...before,country:null});}finally{old.close();}
});
it.each([undefined,null,'AT','CL'])('creates an explicit or unset country without guessing from timezone: %s',async country=>{
 const response=await request('/api/me/business','POST',{name:'Practice',timezone:'Europe/Vienna',...(country===undefined?{}:{country})});expect(response.status).toBe(201);expect(await response.json()).toMatchObject({country:country??null});
});
it.each(['ZZ','at','AUT','',42,{},[]])('rejects invalid supplied country before creating a workspace: %s',async country=>{
 expect((await request('/api/me/business','POST',{name:'Practice',country})).status).toBe(400);expect(db.database.prepare('SELECT count(*) n FROM businesses').get()).toEqual({n:0});
});
it('preserves omitted country, supports explicit clearing, isolates writes and exports it',async()=>{
 const created=await(await request('/api/me/business','POST',{name:'Practice',country:'CL'})).json() as any;
 expect((await request('/api/me/business/'+created.id,'PUT',{description:'Updated facts'})).status).toBe(200);
 expect(await(await request('/api/me/business')).json()).toMatchObject({country:'CL'});
 expect((await request('/api/me/business/'+created.id,'PUT',{country:'ZZ'})).status).toBe(400);
 const exported=await(await request('/api/me/account/export')).json() as any;
 expect(exported.data.businesses[0]).toMatchObject({country:'CL'});
 db.exec("INSERT INTO businesses(id,user_id,slug,name,country)VALUES('foreign','other','foreign','Other','AT')");
 expect((await request('/api/me/business/foreign','PUT',{country:'DE'})).status).toBe(404);
 expect((await request('/api/me/business/'+created.id,'PUT',{country:null})).status).toBe(200);
 expect(db.database.prepare('SELECT country FROM businesses WHERE id=?').get(created.id)).toEqual({country:null});
 expect(db.database.prepare("SELECT country FROM businesses WHERE id='foreign'").get()).toEqual({country:'AT'});
});
