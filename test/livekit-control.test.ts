import {fakeCtx} from './fake-d1';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {SqliteD1,applyMigrations} from './sqlite-d1';
import {CallSession} from '../src/call-session';
import app from '../src/index';
import type {Env} from '../src/types';
let db:SqliteD1;let env:Env;let session:CallSession;let data:Map<string,any>;let pending:Promise<unknown>[];
beforeEach(()=>{
 db=new SqliteD1();applyMigrations(db);db.exec(readFileSync(new URL('../migrations/0025_livekit_call_events.sql',import.meta.url),'utf8'));
 db.exec("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','fixture');INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','biz','Business');INSERT INTO agent_settings(business_id) VALUES('biz');INSERT INTO calls(id,business_id,connected_at) VALUES('call','biz',CURRENT_TIMESTAMP);");
 data=new Map([['livekit',{room:'room',callId:'call',caller:'caller',callback:'scoped-capability',voice:'marin',instructions:'Facts',greeting:'Hello',language:'en'}]]);pending=[];
 let lock=Promise.resolve();
 const storage={get:async(k:string)=>structuredClone(data.get(k)),put:async(k:string,v:any)=>{data.set(k,structuredClone(v));},delete:async()=>{},deleteAll:async()=>data.clear(),deleteAlarm:async()=>{},setAlarm:async()=>{},transaction:async(fn:Function)=>fn(storage)};
 const state={storage,blockConcurrencyWhile:(fn:()=>Promise<any>)=>{const work=lock.then(fn);lock=work.catch(()=>{});return work;},waitUntil:(p:Promise<any>)=>pending.push(p)};
 env={DB:db,WEB_VOICE_TRANSPORT:'livekit',LIVEKIT_URL:'ws://127.0.0.1:7880',LIVEKIT_API_KEY:'fixture',LIVEKIT_API_SECRET:'fixture-secret',LIVEKIT_AGENT_SERVICE_TOKEN:'service-key'} as unknown as Env;
 session=new CallSession(state as unknown as DurableObjectState,env);
});
afterEach(async()=>{await Promise.allSettled(pending);db.close();vi.unstubAllGlobals();});
const request=(operation:string,body:Record<string,unknown>={},key='service-key',id='call')=>session.fetch(new Request(`https://session/livekit/${operation}?call=${id}`,{method:'POST',headers:{Authorization:'Bearer '+key},body:JSON.stringify({room:'room',jobId:'job',...body})}));
it('pins one worker job and keeps admission scoped to call/room/operator credential',async()=>{
 expect((await request('context',{},'wrong')).status).toBe(404);
 expect((await request('context',{},'service-key','other')).status).toBe(404);
 expect((await request('context',{room:'other'})).status).toBe(403);
 expect((await request('context')).status).toBe(200);
 expect((await request('context',{jobId:'different'})).status).toBe(409);
 db.exec("DELETE FROM users WHERE id='owner'");expect((await request('context')).status).toBe(410);
});
it('allows final transcript drain while closing but refuses new admission and late rewrites',async()=>{
 await request('context');data.set('livekit',{...data.get('livekit'),closing:true});
 expect((await request('context')).status).toBe(410);
 const text={callback:'scoped-capability',type:'transcript',eventId:'sdk_message',revision:0,final:true,role:'agent',text:'Goodbye'};
 expect((await request('events',text)).status).toBe(200);
 expect((await request('events',text)).status).toBe(200);
 expect(db.database.prepare('SELECT text FROM call_turns').all()).toEqual([{text:'Goodbye'}]);
 expect((await request('events',{...text,callback:'wrong'})).status).toBe(403);
 expect((await request('events',{...text,jobId:'different'})).status).toBe(403);
 data.set('livekit',{...data.get('livekit'),finished:true});expect((await request('events',{...text,revision:1,text:'changed'})).status).toBe(410);
});
it('typed commands are cleared only by the admitted worker and cannot be claimed after closing',async()=>{
 await request('context');data.set('livekit',{...data.get('livekit'),commands:[{id:'typed_a',text:'Hello'}]});
 expect((await request('events',{callback:'wrong',type:'command_ack',commandId:'typed_a'})).status).toBe(403);
 expect((await (await request('context')).json() as any).commands).toHaveLength(1);
 expect((await request('events',{callback:'scoped-capability',type:'command_ack',commandId:'typed_a'})).status).toBe(200);
 expect((await (await request('context')).json() as any).commands).toHaveLength(0);
});
it('public callback route requires operator authorization rather than a user cookie',async()=>{
 const forward=vi.fn(async()=>new Response('{}'));
 env.CALL_SESSION={idFromName:(id:string)=>id,get:()=>({fetch:forward})} as any;
 const url='https://example.test/api/internal/livekit/calls/call/context';
 expect((await app.fetch(new Request(url,{method:'POST',headers:{Cookie:'session=fixture'},body:'{}'}),env,fakeCtx)).status).toBe(404);
 expect(forward).not.toHaveBeenCalled();
 expect((await app.fetch(new Request(url,{method:'POST',headers:{Authorization:'Bearer service-key'},body:JSON.stringify({room:'room',jobId:'job'})}),env,fakeCtx)).status).toBe(200);
 expect(forward).toHaveBeenCalledTimes(1);
});
