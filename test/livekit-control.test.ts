import {fakeCtx} from './fake-d1';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SqliteD1,applyMigrations} from './sqlite-d1';
import {CallSession} from '../src/call-session';
import app from '../src/index';
import type {Env} from '../src/types';
let db:SqliteD1;let env:Env;let session:CallSession;let data:Map<string,any>;let pending:Promise<unknown>[];
beforeEach(()=>{
 db=new SqliteD1();applyMigrations(db);
 db.exec("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','fixture');INSERT INTO businesses(id,user_id,slug,name) VALUES('biz','owner','biz','Business');INSERT INTO agent_settings(business_id) VALUES('biz');INSERT INTO calls(id,business_id,connected_at) VALUES('call','biz',CURRENT_TIMESTAMP);");
 data=new Map([['livekit',{room:'room',callId:'call',caller:'caller',callback:'scoped-capability',voice:'marin',instructions:'Facts',greeting:'Hello',language:'en'}]]);pending=[];
 let lock=Promise.resolve();
 const storage={get:async(k:string)=>structuredClone(data.get(k)),put:async(k:string,v:any)=>{data.set(k,structuredClone(v));},delete:async()=>{},deleteAll:async()=>data.clear(),deleteAlarm:async()=>{},setAlarm:async()=>{},transaction:async(fn:Function)=>fn(storage)};
 const state={storage,blockConcurrencyWhile:(fn:()=>Promise<any>)=>{const work=lock.then(fn);lock=work.catch(()=>{});return work;},waitUntil:(p:Promise<any>)=>pending.push(p)};
 env={DB:db,WEB_VOICE_TRANSPORT:'livekit',LIVEKIT_URL:'ws://127.0.0.1:7880',LIVEKIT_API_KEY:'fixture',LIVEKIT_API_SECRET:'fixture-secret',LIVEKIT_AGENT_SERVICE_TOKEN:'service-key'} as unknown as Env;
 session=new CallSession(state as unknown as DurableObjectState,env);
});
afterEach(async()=>{await Promise.allSettled(pending);db.close();vi.unstubAllGlobals();vi.useRealTimers();});
const request=(operation:string,body:Record<string,unknown>={},key='service-key',id='call')=>session.fetch(new Request(`https://session/livekit/${operation}?call=${id}`,{method:'POST',headers:{Authorization:'Bearer '+key},body:JSON.stringify({room:'room',jobId:'job',...body})}));
it('alarm recovery excludes unfinished media transcripts from summary evidence after eviction',async()=>{
 data.set('callId','call');
 data.set('livekit',{...data.get('livekit'),finished:true});
 db.exec("INSERT INTO call_turns(call_id,role,text,source_id,source_final) VALUES('call','caller','UNCONFIRMED booking','partial',0),('call','agent','How can I help?','greeting',1),('call','caller','Please call me tomorrow','request',1)");
 env.DEFAULT_LLM_BASE_URL='https://summary.example/v1';env.DEFAULT_LLM_API_KEY='fixture';env.DEFAULT_LLM_MODEL='fixture-model';
 const summaries:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{
  if(String(url).includes('/chat/completions')) {
   summaries.push(JSON.parse(init.body as string).messages[1].content);
   return Response.json({choices:[{message:{content:JSON.stringify({summary:'Callback requested',intent:'message',message:'Call tomorrow'})}}]});
  }
  return Response.json({});
 }));
 await session.alarm();
 expect(summaries).toEqual(['Agent: How can I help?\nCaller: Please call me tomorrow']);
 expect(db.database.prepare('SELECT status FROM calls WHERE id=?').get('call')).toEqual({status:'completed'});
 expect(db.database.prepare('SELECT text FROM call_turns WHERE source_id=?').get('partial')).toEqual({text:'UNCONFIRMED booking'});
});
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

it('rollback preserves admitted context and authenticated final drain through the public route',async()=>{
 await request('context');
 env.WEB_VOICE_TRANSPORT=undefined;
 env.CALL_SESSION={idFromName:(id:string)=>id,get:()=>({fetch:(req:Request)=>session.fetch(req)})} as any;
 const post=(operation:string,body:Record<string,unknown>,key='service-key')=>app.fetch(new Request('https://example.test/api/internal/livekit/calls/call/'+operation,{method:'POST',headers:{Authorization:'Bearer '+key},body:JSON.stringify({room:'room',jobId:'job',callback:'scoped-capability',...body})}),env,fakeCtx);
 expect((await post('context',{})).status).toBe(200);
 expect((await post('context',{jobId:'replacement'})).status).toBe(409);
 expect((await post('events',{},'wrong')).status).toBe(404);
 data.set('livekit',{...data.get('livekit'),closing:true});
 expect((await post('context',{})).status).toBe(410);
 expect((await post('events',{type:'transcript',eventId:'final',revision:0,final:true,role:'caller',text:'Call me tomorrow'})).status).toBe(200);
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({})));
 expect((await post('events',{type:'finished'})).status).toBe(200);
 await Promise.all(pending);
 expect(db.database.prepare('SELECT text,source_final FROM call_turns').all()).toEqual([{text:'Call me tomorrow',source_final:1}]);
 expect(db.database.prepare('SELECT status FROM calls').get()).toEqual({status:'completed'});
 data.delete('livekit');
 expect((await post('context',{})).status).toBe(404);
});
it('freezes hangup before held room cleanup and preserves the original duration',async()=>{
 vi.useFakeTimers();const ended=Math.floor(Date.now()/1000)*1000;vi.setSystemTime(ended);
 data.set('callId','call');data.set('livekit',{...data.get('livekit'),finished:true});
 db.database.prepare("UPDATE calls SET connected_at=?").run(new Date(ended-10000).toISOString().replace('T',' ').slice(0,19));
 let release!:()=>void;let started!:()=>void;const entered=new Promise<void>(resolve=>started=resolve);
 vi.stubGlobal('fetch',vi.fn(async()=>{started();await new Promise<void>(resolve=>release=resolve);return Response.json({});}));
 const work=session.alarm();await entered;
 expect(data.get('ending')).toEqual({endedAt:ended,failure:null});
 vi.setSystemTime(ended+18000);release();await work;
 expect(db.database.prepare('SELECT duration_s FROM calls').get()).toEqual({duration_s:10});
});
it('keeps a durable retry clock when room deletion fails',async()=>{
 data.set('callId','call');
 const alarm=vi.spyOn((session as any).state.storage,'setAlarm');
 vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('temporary room service outage');}));
 await expect(session.alarm()).resolves.toBeUndefined();
 expect(data.get('ending').endedAt).toBeTypeOf('number');
 expect(alarm).toHaveBeenCalled();
 expect(db.database.prepare('SELECT status FROM calls').get()).toEqual({status:'active'});
});
it('persists a drain failure discovered after the frozen ending',async()=>{
 data.set('callId','call');data.set('livekit',{...data.get('livekit'),finished:true,failed:true});
 const put=vi.spyOn((session as any).state.storage,'put');
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({})));
 await session.alarm();
 expect(put.mock.calls.some(([key,value]:any[])=>key==='ending'&&value.failure?.includes('could not be saved completely'))).toBe(true);
 expect(db.database.prepare('SELECT status FROM calls').get()).toEqual({status:'failed'});
});

it('bounds agent startup independently of caller pings and survives object reconstruction',async()=>{
 vi.useFakeTimers();const now=Date.now();
 data.set('callId','call');data.set('lastActivity',now);data.set('hardDeadline',now+1800000);
 data.set('livekit',{...data.get('livekit'),startupDeadline:now+90000});
 const alarm=vi.spyOn((session as any).state.storage,'setAlarm');
 vi.setSystemTime(now+60000);data.set('lastActivity',Date.now());await session.alarm();
 expect(alarm).toHaveBeenLastCalledWith(now+90000);
 vi.setSystemTime(now+90000);data.set('lastActivity',Date.now());
 vi.stubGlobal('fetch',vi.fn(async()=>{data.set('livekit',{...data.get('livekit'),finished:true});return Response.json({});}));
 await session.alarm();
 expect(db.database.prepare('SELECT status,summary FROM calls').get()).toEqual({status:'failed',summary:expect.stringContaining('did not finish connecting')});
});
it('only the admitted worker can acknowledge readiness before the startup deadline',async()=>{
 vi.useFakeTimers();const now=Date.now();data.set('callId','call');data.set('lastActivity',now);
 data.set('livekit',{...data.get('livekit'),startupDeadline:now+90000});
 await request('context');
 const send=vi.spyOn(session as any,'send');
 expect((await request('events',{type:'ready',callback:'wrong'})).status).toBe(403);
 expect(data.get('livekit').ready).toBeUndefined();expect(send).not.toHaveBeenCalled();
 expect((await request('events',{type:'ready',callback:'scoped-capability'})).status).toBe(200);
 expect(send).toHaveBeenCalledWith({type:'agent_ready'});
 vi.setSystemTime(now+90001);data.set('lastActivity',Date.now());await session.alarm();
 expect(db.database.prepare('SELECT status FROM calls').get()).toEqual({status:'active'});
 expect((await request('context')).status).toBe(200);
});
it('rejects delayed startup context and readiness without reviving the call',async()=>{
 vi.useFakeTimers();const now=Date.now();
 data.set('livekit',{...data.get('livekit'),startupDeadline:now+90000});await request('context');
 vi.setSystemTime(now+90000);
 expect((await request('context')).status).toBe(410);
 expect((await request('events',{type:'ready',callback:'scoped-capability'})).status).toBe(410);
 expect(data.get('livekit').ready).toBeUndefined();
});

it('late failed completion preserves a durable startup diagnosis after reconstruction',async()=>{
 await request('context');
 const failure='Call failed: the conversation service did not finish connecting. Please try again.';
 data.set('ending',{endedAt:Date.now()-1000,failure});
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({})));
 expect((await request('events',{type:'finished',callback:'scoped-capability',failed:true})).status).toBe(200);
 await Promise.all(pending);
 expect(db.database.prepare('SELECT status,summary FROM calls').get()).toEqual({status:'failed',summary:failure});
});

it.each([false,true])('validates the selected summary route before dispatch (independent=%s)',async independent=>{
 env.DEFAULT_LLM_BASE_URL='https://default.example/v1';env.DEFAULT_LLM_MODEL='default';
 const state=session as any;state.callId='call';
 vi.spyOn(state,'loadCall').mockImplementation(async()=>{state.biz={id:'biz'};state.settings={llm_base_url:'https://custom.example/v1',llm_api_key:'',llm_model:'unused'};});
 const dispatch=vi.spyOn(state,'startLivekit').mockResolvedValue(undefined);
 const finish=vi.spyOn(state,'finalize').mockResolvedValue(undefined);
 if(independent)db.exec("INSERT INTO summary_settings(business_id,mode,base_url,api_key,model,revision) VALUES('biz','custom','https://summary.example/v1','fixture','summary-model','fixture')");
 await state.handleStart();
 expect(dispatch).toHaveBeenCalledTimes(independent?1:0);
 expect(finish).toHaveBeenCalledTimes(independent?0:1);
 if(!independent)expect(state.failure).toContain('Check summary settings');
});

it.each(['context','ready'])('expired %s freezes failure before a normal worker finish and eviction',async operation=>{
 vi.useFakeTimers();const now=Date.now();
 data.set('livekit',{...data.get('livekit'),startupDeadline:now+90000});await request('context');
 vi.setSystemTime(now+90000);
 const response=operation==='context'?await request('context'):await request('events',{type:'ready',callback:'scoped-capability'});
 expect(response.status).toBe(410);
 expect(data.get('ending')).toEqual({endedAt:now+90000,failure:expect.stringContaining('did not finish connecting')});
 expect(data.get('livekit').closing).toBe(true);
 session=new CallSession((session as any).state,env);
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({})));
 expect((await request('events',{type:'finished',callback:'scoped-capability',failed:false})).status).toBe(200);
 await Promise.all(pending);
 expect(db.database.prepare('SELECT status,summary FROM calls').get()).toEqual({status:'failed',summary:expect.stringContaining('did not finish connecting')});
});
it('normal closing before startup expiry is not reclassified by a later poll',async()=>{
 vi.useFakeTimers();const now=Date.now();data.set('livekit',{...data.get('livekit'),startupDeadline:now+90000});await request('context');
 data.set('livekit',{...data.get('livekit'),closing:true});data.set('ending',{endedAt:now+1000,failure:null});
 vi.setSystemTime(now+90000);expect((await request('context')).status).toBe(410);
 expect(data.get('ending')).toEqual({endedAt:now+1000,failure:null});
});

it.each([false,true])('startup deadline cannot reclassify normal cleanup (finished=%s)',async finished=>{
 vi.useFakeTimers();const now=Date.now();data.set('callId','call');
 data.set('livekit',{...data.get('livekit'),startupDeadline:now+90000,closing:true,finished});
 data.set('ending',{endedAt:now+1000,failure:null});
 vi.setSystemTime(now+90001);
 vi.stubGlobal('fetch',vi.fn(async()=>{data.set('livekit',{...data.get('livekit'),finished:true});return Response.json({});}));
 await session.alarm();
 expect(db.database.prepare('SELECT status,summary FROM calls').get()).toEqual({status:'completed',summary:null});
});
it('frozen normal ending survives an alarm before the closing flag was saved',async()=>{
 vi.useFakeTimers();const now=Date.now();data.set('callId','call');
 data.set('livekit',{...data.get('livekit'),startupDeadline:now+90000});data.set('ending',{endedAt:now+1000,failure:null});
 vi.setSystemTime(now+90001);
 vi.stubGlobal('fetch',vi.fn(async()=>{data.set('livekit',{...data.get('livekit'),finished:true});return Response.json({});}));
 await session.alarm();
 expect(db.database.prepare('SELECT status,summary FROM calls').get()).toEqual({status:'completed',summary:null});
});
