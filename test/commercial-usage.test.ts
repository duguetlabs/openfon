import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,it,expect} from 'vitest';
import {SqliteD1,applyMigrations} from './sqlite-d1';
import type {Env} from '../src/types';
import type {UsageObservation} from '../src/commercial-types';
import {ingestProviderUsage,recordOperationUsage,recordCompletedCallUsage,normalizeUsage,monthlyWindow,retailOverage,markOperatorQaCall} from '../src/commercial-usage';
let db:SqliteD1,env:Env;
beforeEach(()=>{db=new SqliteD1();applyMigrations(db);db.exec(readFileSync('migrations/0027_commercial.sql','utf8'));db.exec("INSERT INTO users(id,email,password_hash) VALUES('u','u@example.invalid','x'),('v','v@example.invalid','x'); INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','B'),('other','v','other','Other'); INSERT INTO calls(id,business_id,connected_at) VALUES('call','b',CURRENT_TIMESTAMP),('othercall','other',CURRENT_TIMESTAMP)");env={DB:db} as unknown as Env;});
afterEach(()=>db.close());
const context={callId:'call',jobId:'job',businessId:'b'};
const event=(patch:Partial<UsageObservation>={}):UsageObservation=>({eventId:'e1',callId:'call',jobId:'job',source:'azure_voice',providerSessionId:'ps',observedAt:'2026-10-05T12:00:00Z',final:false,metrics:{voiceSessionSeconds:'1.250'},...patch});
it('deduplicates events and cumulative snapshots without charging missing counters',async()=>{
 expect(await ingestProviderUsage(env,context,event())).toEqual({duplicate:false});expect(await ingestProviderUsage(env,context,event())).toEqual({duplicate:true});
 await ingestProviderUsage(env,context,event({eventId:'e2',metrics:{voiceSessionSeconds:'2.500'}}));
 await ingestProviderUsage(env,context,event({eventId:'late',metrics:{voiceSessionSeconds:'1.500'}}));
 await ingestProviderUsage(env,context,event({eventId:'closed',final:true,metrics:{}}));
 expect(db.database.prepare('SELECT metric,value,is_final FROM commercial_provider_metrics').all()).toEqual([{metric:'voiceSessionMs',value:2500,is_final:0}]);
 expect(db.database.prepare('SELECT COUNT(*) AS n FROM commercial_provider_observations').get()).toEqual({n:4});
});
it('rejects cross-workspace/call/job scope and conflicting replay without overwriting',async()=>{
 await ingestProviderUsage(env,context,event());
 await expect(ingestProviderUsage(env,{...context,businessId:'other'},event())).rejects.toThrow();
 await expect(ingestProviderUsage(env,context,event({jobId:'otherjob'}))).rejects.toThrow();
 await expect(ingestProviderUsage(env,context,event({metrics:{voiceSessionSeconds:'200'}}))).rejects.toThrow('Conflicting');
 expect(db.database.prepare('SELECT value FROM commercial_provider_metrics').get()).toEqual({value:1250});
});
it('keeps response totals distinct from subcategories and separates operations',async()=>{
 const metrics={inputTokens:100,cachedInputTokens:20,outputTokens:30,reasoningTokens:10,totalTokens:130};
 const observation=event({eventId:'text',source:'azure_text',providerResponseId:'response1',final:true,metrics});
 await recordOperationUsage(env,{businessId:'b',operationId:'summary1',callId:'call',kind:'summary'},observation);
 expect(db.database.prepare("SELECT value FROM commercial_provider_metrics WHERE metric='totalTokens'").get()).toEqual({value:130});
 await expect(recordOperationUsage(env,{businessId:'other',operationId:'summary1',callId:'call',kind:'summary'},observation)).rejects.toThrow();
 expect(()=>normalizeUsage(event({metrics:{inputTokens:-1}}))).toThrow();
 expect(()=>normalizeUsage(event({metrics:{inputTokens:1,cachedInputTokens:2}}))).toThrow();
 expect(()=>normalizeUsage(event({metrics:{voiceSessionSeconds:'NaN'}}))).toThrow();
});
it('records actual terminal intervals once including failed service and refuses rewrites',async()=>{
 await expect(recordCompletedCallUsage(env,{callId:'call',connectedAtMs:1000,endedAtMs:2250})).rejects.toThrow();
 db.exec("UPDATE calls SET status='failed' WHERE id='call'");
 expect(await recordCompletedCallUsage(env,{callId:'call',connectedAtMs:1000,endedAtMs:2250})).toEqual({duplicate:false});
 expect(await recordCompletedCallUsage(env,{callId:'call',connectedAtMs:1000,endedAtMs:2250})).toEqual({duplicate:true});
 await expect(recordCompletedCallUsage(env,{callId:'call',connectedAtMs:1000,endedAtMs:3000})).rejects.toThrow('audited adjustment');
 expect(db.database.prepare('SELECT duration_ms FROM commercial_call_usage').get()).toEqual({duration_ms:1250});
});
it('operator QA marking requires active calls and is not based on test environment',async()=>{
 expect(await markOperatorQaCall(env,'call','operator')).toEqual({marked:true});
 db.exec("UPDATE calls SET status='completed' WHERE id='othercall'");expect(await markOperatorQaCall(env,'othercall','operator')).toEqual({marked:false});
});
it('monthly allowance boundaries keep annual anniversary day across short months',()=>{
 expect(monthlyWindow('2026-01-31T10:00:00Z',Date.parse('2026-03-30T00:00:00Z'))).toEqual({start:'2026-02-28T10:00:00.000Z',end:'2026-03-31T10:00:00.000Z'});
 expect(monthlyWindow('2026-01-31T10:00:00Z',Date.parse('2026-03-31T10:00:00Z')).start).toBe('2026-03-31T10:00:00.000Z');
 expect(()=>monthlyWindow('2026-01-31T10:00:00Z',0)).toThrow();
});
it('retail rounds aggregate overage once and retains exact plan rates',()=>{
 expect(retailOverage(60000,'flex','monthly').overageMinor).toBe(16);
 expect(retailOverage(60000,'flex','annual').overageMinor).toBe(15);
 expect(retailOverage(500*60000+30000,'small','monthly').overageMinor).toBe(5);
 expect(retailOverage(2500*60000,'growth','annual').overageMinor).toBe(0);
 expect(retailOverage(2000,'flex','monthly').overageMinor).toBe(1);
});
