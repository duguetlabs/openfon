import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {SqliteD1,applyMigrations} from './sqlite-d1';
import {getPhoneView,quotePhoneNumbers,orderPhoneNumber} from '../src/commercial-phone';
import type {CommercialEnv} from '../src/commercial-dodo';
let db:SqliteD1,env:CommercialEnv;
beforeEach(()=>{
 db=new SqliteD1();applyMigrations(db);for(const name of ['0027_commercial','0028_business_country','0029_phone_eligibility'])db.exec(readFileSync('migrations/'+name+'.sql','utf8'));
 db.exec("INSERT INTO users(id,email,password_hash)VALUES('u','u@example.invalid','hash'),('v','v@example.invalid','hash');INSERT INTO businesses(id,user_id,slug,name,address,country)VALUES('b','u','b','Business','Reviewed street','CL'),('foreign','v','foreign','Foreign','Other street','AT');INSERT INTO assistants(id,business_id,public_slug,name)VALUES('assistant','b','assistant','Assistant');INSERT INTO commercial_accounts(business_id,provider_mode,customer_id,status,activated_at,paid_through)VALUES('b','test','customer','active','2026-01-01','2999-01-01');");
 env={DB:db,TELNYX_PURCHASES_ENABLED:'true',TELNYX_CARRIER_VERIFIED:'true',TELNYX_ENABLED:'true',TELNYX_API_KEY:'synthetic',TELNYX_CONNECTION_ID:'connection',TELNYX_PURCHASE_COUNTRY:'AT',TELNYX_MAX_SETUP_MINOR:'100',TELNYX_MAX_MONTHLY_MINOR:'100',TELNYX_PURCHASE_CURRENCY:'USD'} as unknown as CommercialEnv;
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init:RequestInit)=>init.method==='POST'?Response.json({data:{id:'remote'}}):Response.json({data:[{phone_number:'+431234567',region_information:[{region_type:'country_code',region_name:'AT'}],phone_number_type:'local',best_effort:false,cost_information:{upfront_cost:'1.00000',monthly_cost:'1.00000',currency:'USD'}}]})));
});
afterEach(()=>{db.close();vi.unstubAllGlobals();});
function approve(business='b',area:string|null=null){db.database.prepare("INSERT INTO commercial_phone_approvals(id,business_id,country,number_type,area_code,status,business_name,business_address,business_country,reviewed_at,expires_at) SELECT ?,id,'AT','local',?,'approved',name,address,country,'2026-01-01','2999-01-01' FROM businesses WHERE id=?").run('approval-'+business,area,business);}
const quote=(areaCode?:string)=>quotePhoneNumbers(env,'b',{country:'AT',type:'local',...(areaCode?{areaCode}:{})});
it('keeps unknown eligibility closed without treating a business country as a universal foreign-country prohibition',async()=>{
 const initial=await getPhoneView(env,'b');expect(initial.businessCountry).toBe('CL');expect(initial.provisioningAvailable).toBe(false);expect(initial.offers[0].status).toBe('requirements-needed');await expect(quote()).rejects.toThrow('review');expect(fetch).not.toHaveBeenCalled();
 approve();expect((await getPhoneView(env,'b')).offers[0]).toMatchObject({country:'AT',status:'approved',canSearch:true});expect((await quote()).quotes).toHaveLength(1);
});
it.each(['pending','rejected','revoked','expired','name','address','country','missing-country','other-owner'])('rejects %s approval before inventory access',async reason=>{
 approve(reason==='other-owner'?'foreign':'b');
 if(['pending','rejected','revoked'].includes(reason))db.database.prepare('UPDATE commercial_phone_approvals SET status=?').run(reason);
 if(reason==='expired')db.exec("UPDATE commercial_phone_approvals SET expires_at='2000-01-01'");
 if(reason==='name')db.exec("UPDATE businesses SET name='Changed' WHERE id='b'");
 if(reason==='address')db.exec("UPDATE businesses SET address='Changed' WHERE id='b'");
 if(reason==='country')db.exec("UPDATE businesses SET country='DE' WHERE id='b'");
 if(reason==='missing-country')db.exec("UPDATE businesses SET country=NULL WHERE id='b'");
 await expect(quote()).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});
it('distinguishes regulatory approval from operator purchase availability',async()=>{approve();env.TELNYX_PURCHASES_ENABLED='false';const view=await getPhoneView(env,'b');expect(view.offers[0]).toMatchObject({status:'approved',canSearch:false});expect(view.provisioningAvailable).toBe(false);});
it('requires the reviewed area and documented exact-match response rather than a nonexistent destination field',async()=>{
 approve('b','1');await expect(quote()).rejects.toThrow();await expect(quote('2')).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 expect((await quote('1')).quotes).toHaveLength(1);
 const url=new URL(String(vi.mocked(fetch).mock.calls[0][0]));
 expect(url.searchParams.get('filter[national_destination_code]')).toBe('1');
 expect(url.searchParams.has('filter[best_effort]')).toBe(false);
 for(const data of [
  {region_information:[{region_type:'country_code',region_name:'DE'}],best_effort:false},
  {region_information:[{region_type:'country_code',region_name:'AT'},{region_type:'country_code',region_name:'DE'}],best_effort:false},
  {region_information:[{region_type:'country_code',region_name:'AT'}],country_code:'DE',best_effort:false},
  {region_information:[{region_type:'country_code',region_name:'AT'}],phone_number_type:'toll_free',best_effort:false},
  {region_information:[{region_type:'country_code',region_name:'AT'}],best_effort:true},
  {region_information:[{region_type:'country_code',region_name:'AT'}]},
  {region_information:[{region_type:'country_code',region_name:'AT'}],best_effort:'false'},
  {region_information:{region_type:'country_code',region_name:'AT'},best_effort:false},
  {region_information:[null],best_effort:false},
  {best_effort:false},
 ]){
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({data:[{...data,phone_number:'+431234567',cost_information:{upfront_cost:'1',monthly_cost:'1',currency:'USD'}}]}));expect((await quote('1')).quotes).toHaveLength(0);
 }
});
it('requires an exact response for optional area filters under a country-wide approval too',async()=>{
 approve();vi.mocked(fetch).mockResolvedValueOnce(Response.json({data:[{phone_number:'+431234567',region_information:[{region_type:'country_code',region_name:'AT'}],cost_information:{upfront_cost:'1',monthly_cost:'1',currency:'USD'}}]}));
 expect((await quote('1')).quotes).toHaveLength(0);
 expect((await quote('1')).quotes).toHaveLength(1);
});
it.each(['country','approval'])('rejects a %s change after inventory but before quote insertion',async kind=>{
 approve();vi.mocked(fetch).mockImplementationOnce(async()=>{db.exec(kind==='country'?"UPDATE businesses SET country='DE' WHERE id='b'":"UPDATE commercial_phone_approvals SET status='revoked'");return Response.json({data:[{phone_number:'+431234567',cost_information:{upfront_cost:'1',monthly_cost:'1',currency:'USD'}}]});});
 await expect(quote()).rejects.toThrow('changed');expect(db.database.prepare('SELECT count(*) n FROM commercial_phone_quotes').get()).toEqual({n:0});
});
it('invalidates old quotes across revoke and reapprove even with identical final scope',async()=>{
 approve();const q=(await quote()).quotes[0];db.exec("UPDATE commercial_phone_approvals SET status='revoked';UPDATE commercial_phone_approvals SET status='approved'");expect(db.database.prepare('SELECT revision FROM commercial_phone_approvals').get()).toEqual({revision:3});vi.mocked(fetch).mockClear();await expect(orderPhoneNumber(env,'b',q.id,'assistant')).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 expect(()=>db.exec('UPDATE commercial_phone_approvals SET revision=1')).toThrow();
});
it.each(['reservation','dispatch'])('rechecks the approval at the %s boundary before any provider purchase',async boundary=>{
 approve();const q=(await quote()).quotes[0];vi.mocked(fetch).mockClear();let changed=false;
 db.hook=sql=>{if(!changed&&sql.startsWith(boundary==='reservation'?'INSERT INTO commercial_phone_orders':'SELECT o.id FROM commercial_phone_orders')){changed=true;db.database.exec("UPDATE commercial_phone_approvals SET status='revoked'");}};
 await expect(orderPhoneNumber(env,'b',q.id,'assistant')).rejects.toThrow();expect(changed).toBe(true);expect(fetch).not.toHaveBeenCalled();
 expect(db.database.prepare('SELECT state FROM commercial_phone_orders').all()).toEqual(boundary==='dispatch'?[{state:'failed'}]:[]);
});
it('orders only a current eligible quote and returns an existing order without new admission',async()=>{
 approve();const q=(await quote()).quotes[0];expect(await orderPhoneNumber(env,'b',q.id,'assistant')).toMatchObject({status:'review'});expect(vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 env.TELNYX_PURCHASES_ENABLED='false';db.exec("UPDATE businesses SET country=NULL WHERE id='b'");vi.mocked(fetch).mockClear();expect(await orderPhoneNumber(env,'b',q.id,'assistant')).toMatchObject({status:'review'});expect(fetch).not.toHaveBeenCalled();expect((await getPhoneView(env,'b')).numbers).toHaveLength(1);
});
it('adds quote approval pins without changing existing orders or quote values',()=>{
 const old=new SqliteD1();
 try{
  applyMigrations(old);old.exec(readFileSync('migrations/0027_commercial.sql','utf8'));
  old.exec("INSERT INTO users(id,email,password_hash)VALUES('old','old@example.invalid','hash');INSERT INTO businesses(id,user_id,slug,name)VALUES('old','old','old','Old business');INSERT INTO commercial_phone_quotes(id,business_id,phone_number,country,number_type,currency,setup_minor,monthly_minor,requirements_json,expires_at)VALUES('quote','old','+431234567','AT','local','USD',100,200,'[]','2999-01-01');INSERT INTO commercial_phone_orders(id,business_id,assistant_id,quote_id,phone_number,state,created_at)VALUES('order','old','old-assistant','quote','+431234567','pending','2026-01-01');");
  const quoteBefore=old.database.prepare('SELECT * FROM commercial_phone_quotes').get();
  const orderBefore=old.database.prepare('SELECT * FROM commercial_phone_orders').get();
  old.exec(readFileSync('migrations/0028_business_country.sql','utf8'));
  old.exec(readFileSync('migrations/0029_phone_eligibility.sql','utf8'));
  expect(old.database.prepare('SELECT * FROM commercial_phone_quotes').get()).toEqual({...quoteBefore,approval_id:null,approval_revision:null,area_code:null});
  expect(old.database.prepare('SELECT * FROM commercial_phone_orders').get()).toEqual(orderBefore);
  expect(old.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 }finally{old.close();}
});
