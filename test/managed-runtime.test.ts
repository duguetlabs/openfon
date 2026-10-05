import {readFileSync} from 'node:fs';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {GptLiveEngine,type GptLiveHost,type GptLiveSessionOptions} from '../src/gpt-live';
import {CallSession} from '../src/call-session';
import {resolveRealtime,gptLiveConnection} from '../src/realtime-providers';
import {azureUsageObservation} from '../src/azure-usage';
import type {Env} from '../src/types';
const env={OPENFON_MANAGED_WEB:'true',AZURE_OPENAI_ENDPOINT:'https://fixture.cognitiveservices.azure.com',AZURE_OPENAI_API_KEY:'synthetic-key'} as Env;
class Socket{
 listeners=new Map<string,Array<(event:any)=>void>>();sent:any[]=[];closed=false;accept(){};
 addEventListener(name:string,fn:(event:any)=>void){this.listeners.set(name,[...(this.listeners.get(name)??[]),fn]);}
 receive(event:unknown){for(const fn of this.listeners.get('message')??[])fn({data:JSON.stringify(event)});}
 send(raw:string){this.sent.push(JSON.parse(raw));}
 close(){this.closed=true;for(const fn of this.listeners.get('close')??[])fn({});}
}
const options:GptLiveSessionOptions={instructions:'Business facts',voice:'marin',delegationModel:'gpt-5.4-mini',delegationInstructions:'Delegate',greeting:null};
const microtasks=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
async function connected(){
 const socket=new Socket(),seen:Record<string,unknown>[]=[];const host:GptLiveHost={debug:null,admitAudio:()=>null,audioPaused:()=>{},playAudio:()=>{},turn:()=>{},closeRequested:()=>{},readyToHangUp:()=>{},failed:vi.fn(),disconnected:vi.fn(),providerEvent:e=>seen.push(e)};
 vi.stubGlobal('fetch',vi.fn(async()=>({status:101,webSocket:socket})));
 const engine=new GptLiveEngine(resolveRealtime(env,null),host);const started=engine.start(options);await microtasks();socket.receive({type:'session.started',session:{id:'sess_1',model:'gpt-live-1',delegation:{responses:{model:'gpt-5.4-mini'}},audio:{format:{type:'audio/pcm',rate:24000},output:{voice:'marin'}}}});expect(await started).toBe(true);return{engine,socket,host,seen};
}
describe('direct Azure carrier and customer disclosure boundary',()=>{
 it('uses only operator Azure authentication and preserved live protocol',()=>{expect(gptLiveConnection(resolveRealtime(env,null))).toEqual({url:'https://fixture.cognitiveservices.azure.com/openai/v1/live/sessions',headers:{Upgrade:'websocket','api-key':'synthetic-key'}});});
 it('ends after two seconds when provider sends no final usage and never closes',async()=>{
  vi.useFakeTimers();const{engine,socket}=await connected();let completed=false;const closing=engine.closeAndDrain().then(()=>{completed=true;});await vi.advanceTimersByTimeAsync(1999);expect(completed).toBe(false);await vi.advanceTimersByTimeAsync(1);await closing;expect(socket.closed).toBe(true);expect(socket.sent.filter(e=>e.type==='session.close')).toHaveLength(1);
 });
 it('drains a late terminal usage frame once before closing; repeated close never reopens',async()=>{
  vi.useFakeTimers();const{engine,socket,seen}=await connected();const closing=engine.closeAndDrain();await vi.advanceTimersByTimeAsync(1500);socket.receive({type:'session.closed',usage:{seconds:1.5}});await closing;await engine.closeAndDrain();expect(seen.filter(e=>e.type==='session.closed')).toHaveLength(1);expect(socket.sent.filter(e=>e.type==='session.close')).toHaveLength(1);
 });
 it('provider error content never reaches a managed customer or its persisted failure',async()=>{
  const{engine,socket,host}=await connected();socket.receive({type:'error',error:{code:'invalid',message:'SECRET_MARKER endpoint provider-model'}});const error=vi.mocked(host.failed).mock.calls[0]![0];expect(error.message).not.toContain('SECRET_MARKER');
  const outgoing:string[]=[];const session=new CallSession({} as DurableObjectState,env) as any;session.ws={send:(s:string)=>outgoing.push(s)};const logged=vi.spyOn(console,'error').mockImplementation(()=>{});session.gptLiveHost().failed(error);expect(outgoing.join('')).toContain('Please try again');expect(outgoing.join('')).not.toMatch(/GPT|provider|Azure|SECRET_MARKER/);expect(session.failure).not.toMatch(/GPT|provider|Azure|SECRET_MARKER/);expect(JSON.stringify(logged.mock.calls)).not.toContain('SECRET_MARKER');engine.close();
 });
 it('tracks missing and late usage without fabricating zero seconds or changing repeated identity',async()=>{
  const unknown=await azureUsageObservation('c','j','s',{type:'openfon.usage.unreported'});expect(unknown).toMatchObject({final:false,metrics:{}});
  const first=await azureUsageObservation('c','j','s',{type:'session.closed',usage:{seconds:2.125}}),repeat=await azureUsageObservation('c','j','s',{type:'session.closed',usage:{seconds:2.125}});expect(first?.eventId).toBe(repeat?.eventId);expect(first?.metrics.voiceSessionSeconds).toBe('2.125');expect(first?.eventId).not.toBe(unknown?.eventId);
 });
});
it('carrier queues only usage events and retries failed durable writes without dropping subsequent records',async()=>{
 const values=new Map<string,unknown>();let fail=true;const storage={get:async(k:string)=>values.get(k),list:async({prefix}:{prefix:string})=>new Map([...values].filter(([key])=>key.startsWith(prefix))),put:async(k:string,v:unknown)=>{if(fail){fail=false;throw Error('temporary storage failure');}values.set(k,v);}};
 const session=new CallSession({storage,waitUntil:()=>{}} as unknown as DurableObjectState,env) as any;session.callId='c';session.ended=true;session.captureCarrierUsage({type:'session.started',session:{id:'s'}});for(let i=0;i<2000;i++)session.captureCarrierUsage({type:'session.output_audio.delta',delta:'not retained'});expect(session.carrierPendingWrites.size).toBe(0);
 session.captureCarrierUsage({type:'session.usage.updated',usage:{seconds:1}});session.captureCarrierUsage({type:'session.closed',usage:{seconds:2}});await session.flushCarrierUsage();expect(values.size).toBe(2);expect(session.carrierPendingWrites.size).toBe(0);expect([...values.values()].map((v:any)=>v.observation.metrics.voiceSessionSeconds).sort()).toEqual(['1','2']);
});
it('selected Azure preview returns PCM WAV and preserves terminal usage; missing closure stays bounded and unknown',async()=>{
 vi.useFakeTimers();const{azureVoicePreview}=await import('../src/managed-voice-preview');const socket=new Socket(),observations:unknown[]=[];vi.stubGlobal('fetch',vi.fn(async()=>({status:101,webSocket:socket})));
 const sample=azureVoicePreview(env,{voice:'cedar',language:'en'},new AbortController().signal,async usage=>{observations.push(usage);});await microtasks();expect(socket.sent[0].session.audio.output.voice).toBe('cedar');socket.receive({type:'session.started',session:{id:'preview_1',model:'gpt-live-1',audio:{format:{type:'audio/pcm',rate:24000},output:{voice:'cedar'}}}});
 const speech=Buffer.alloc(4800);for(let i=0;i<speech.length;i+=2)speech.writeInt16LE(6000,i);socket.receive({type:'session.output_audio.delta',delta:speech.toString('base64')});for(let i=0;i<8;i++)socket.receive({type:'session.output_audio.delta',delta:Buffer.alloc(4800).toString('base64')});await vi.advanceTimersByTimeAsync(3000);
 const wav=await sample;expect(new TextDecoder().decode(wav.slice(0,4))).toBe('RIFF');expect(observations).toEqual([{sessionId:'preview_1',final:false}]);expect(socket.closed).toBe(true);
});
it('unconfirmed setup failures finish without a fictitious billed interval, while failed connected service is idempotently metered',async()=>{
 const{SqliteD1,applyMigrations}=await import('./sqlite-d1');const db=new SqliteD1();try{applyMigrations(db);db.exec(readFileSync('migrations/0027_commercial.sql','utf8'));db.exec("INSERT INTO users(id,email,password_hash) VALUES('u','u@example.invalid','unused');INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','Business');INSERT INTO calls(id,business_id,status) VALUES('setup','b','failed');INSERT INTO calls(id,business_id,status,connected_at) VALUES('service','b','failed','2026-10-05 00:00:00')");
 const values=new Map<string,unknown>([['managed-service-start',1000]]);const storage={get:async(k:string)=>values.get(k),list:async()=>new Map()};const session=new CallSession({storage} as unknown as DurableObjectState,{...env,DB:db as unknown as D1Database}) as any;
 session.callId='setup';await session.finishManagedAccounting(2000);expect(db.database.prepare('SELECT COUNT(*) n FROM commercial_call_usage').get()).toEqual({n:0});session.callId='service';await session.finishManagedAccounting(2000);await session.finishManagedAccounting(2000);expect(db.database.prepare('SELECT duration_ms FROM commercial_call_usage').get()).toEqual({duration_ms:1000});
 }finally{db.close();}
});
