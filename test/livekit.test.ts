import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {SqliteD1,applyMigrations} from './sqlite-d1';
import {parseMediaTranscript,persistMediaTranscript,type MediaTranscript} from '../src/livekit-transcripts';
import {createLivekitRoom,livekitJwt,type LivekitSession} from '../src/livekit';
import {readLivekitBody} from '../src/livekit-body';
import {updateTranscript} from '../web/src/transcript-state';
import type {Env} from '../src/types';
let db:SqliteD1;let env:Env;
beforeEach(()=>{
 db=new SqliteD1();applyMigrations(db);
 db.exec("INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','fixture'),('other','other@example.invalid','fixture'); INSERT INTO businesses(id,user_id,slug,name) VALUES('business','owner','business','Business'),('other','other','other','Other'); INSERT INTO calls(id,business_id,connected_at) VALUES('call','business',CURRENT_TIMESTAMP),('other-call','other',CURRENT_TIMESTAMP); INSERT INTO call_turns(call_id,role,text) VALUES('call','caller','Historical turn');");

 env={DB:db,LIVEKIT_URL:'ws://127.0.0.1:7880',LIVEKIT_API_KEY:'synthetic-key',LIVEKIT_API_SECRET:'synthetic-secret',LIVEKIT_AGENT_SERVICE_TOKEN:'synthetic-control'} as unknown as Env;
});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();db.close();});
const item=(patch:Partial<MediaTranscript>={}):MediaTranscript=>({eventId:'sdk_a',revision:0,final:false,role:'caller',text:'Please',...patch});
describe('LiveKit durable transcripts',()=>{
 it('preserves pre-migration rows and replaces partials with one final row',async()=>{
  expect(await persistMediaTranscript(env,'call',item())).toBe(true);
  expect(await persistMediaTranscript(env,'call',item({revision:1,text:'Please call me',final:true}))).toBe(true);
  expect(await persistMediaTranscript(env,'call',item({revision:1,text:'Please call me',final:true}))).toBe(false);
  const rows=db.database.prepare('SELECT text,source_id,source_revision,source_final FROM call_turns ORDER BY id').all();
  expect(rows).toEqual([{text:'Historical turn',source_id:null,source_revision:0,source_final:1},{text:'Please call me',source_id:'sdk_a',source_revision:1,source_final:1}]);
 });
 it('rejects identity, revision and final-text changes without overwriting',async()=>{
  await persistMediaTranscript(env,'call',item());
  await expect(persistMediaTranscript(env,'call',item({text:'rewrite'}))).rejects.toThrow();
  await expect(persistMediaTranscript(env,'call',item({revision:1,role:'agent'}))).rejects.toThrow();
  await persistMediaTranscript(env,'call',item({revision:1,final:true}));
  await expect(persistMediaTranscript(env,'call',item({revision:2,text:'late'}))).rejects.toThrow();
 });
 it('isolates identities per call and rejects deleted or terminal calls',async()=>{
  await persistMediaTranscript(env,'call',item());await persistMediaTranscript(env,'other-call',item({text:'Other caller'}));
  db.exec("UPDATE calls SET status='completed' WHERE id='call'");
  await expect(persistMediaTranscript(env,'call',item({revision:1}))).rejects.toThrow();
  db.exec("DELETE FROM users WHERE id='owner'");
  await expect(persistMediaTranscript(env,'call',item({eventId:'new'}))).rejects.toThrow();
  expect(db.database.prepare('SELECT text FROM call_turns').all()).toEqual([{text:'Other caller'}]);
 });
 it('allows finalization at turn capacity but never adds an extra turn',async()=>{
  await persistMediaTranscript(env,'call',item());
  for(let n=2;n<200;n++)db.database.prepare('INSERT INTO call_turns(call_id,role,text) VALUES(?,?,?)').run('call','caller','x');
  await expect(persistMediaTranscript(env,'call',item({eventId:'overflow'}))).rejects.toThrow();
  expect(await persistMediaTranscript(env,'call',item({revision:1,final:true}))).toBe(true);
 });
 it('validates bytes, IDs and final markers before writes',()=>{
  expect(()=>parseMediaTranscript({type:'transcript',...item(),text:'x'.repeat(100000)})).toThrow();
  expect(()=>parseMediaTranscript({type:'transcript',...item(),revision:-1})).toThrow();
  expect(()=>parseMediaTranscript({type:'transcript',...item(),final:'true'})).toThrow();
 });
});
it('room creation precedes dispatch; grant has SDK-serialized microphone-only source and no data publish',async()=>{
 const calls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string)=>{calls.push(url);return new Response('{}');}));
 const session={callId:'call',room:'openfon-call',caller:'caller-call'} as LivekitSession;
 const grant=await createLivekitRoom(env,session);
 expect(calls.map(u=>u.split('/').pop())).toEqual(['CreateRoom','CreateDispatch']);
 const claims=JSON.parse(atob(grant.participantToken.split('.')[1]));
 expect(claims.sub).toBe('caller-call');expect(claims.video).toMatchObject({room:'openfon-call',canPublishSources:['microphone'],canPublishData:false,canUpdateOwnMetadata:false});
 const [header,payload,signature]=grant.participantToken.split('.');
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('synthetic-secret'),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 expect(await crypto.subtle.verify('HMAC',key,Uint8Array.from(atob(signature.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)),new TextEncoder().encode(header+'.'+payload))).toBe(true);
});
it('does not dispatch when room creation is refused',async()=>{
 const fetcher=vi.fn(async()=>new Response('',{status:503}));vi.stubGlobal('fetch',fetcher);
 await expect(createLivekitRoom(env,{room:'x'} as LivekitSession)).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
});
it('uses Worker-compatible manual redirects and refuses a redirected control operation',async()=>{
 const fetcher=vi.fn(async(_url:string,init:RequestInit)=>{
  expect(init.redirect).toBe('manual');
  return new Response(null,{status:302,headers:{Location:'https://other.example/control'}});
 });
 vi.stubGlobal('fetch',fetcher);
 await expect(createLivekitRoom(env,{room:'x'} as LivekitSession)).rejects.toThrow('Calling service operation failed');
 expect(fetcher).toHaveBeenCalledTimes(1);
});
it('refuses insecure remote media configuration',async()=>{env.LIVEKIT_URL='ws://example.com';await expect(livekitJwt(env,'caller',{})).rejects.toThrow();});
it('bounds a stalled callback body without waiting for cancellation settlement',async()=>{
 vi.useFakeTimers();const cancel=vi.fn(()=>new Promise<void>(()=>{}));
 const body=new ReadableStream<Uint8Array>({cancel});
 const request=new Request('https://example.test',{method:'POST',body,duplex:'half'} as RequestInit);
 const work=readLivekitBody(request);const check=expect(work).rejects.toThrow('deadline');await vi.advanceTimersByTimeAsync(3000);await check;expect(cancel).toHaveBeenCalledTimes(1);
});
it('rejects callback bytes before decoding oversized content',async()=>{
 const request=new Request('https://example.test',{method:'POST',body:'x'.repeat(65537)});await expect(readLivekitBody(request)).rejects.toThrow('limit');
});
it('UI replaces the same utterance, ignores stale/final duplicates, and preserves legacy append',()=>{
 let rows=updateTranscript([],{text:'Hi',eventId:'sdk_a',revision:0,final:false});
 rows=updateTranscript(rows,{text:'Hi there',eventId:'sdk_a',revision:1,final:true});
 expect(updateTranscript(rows,{text:'late',eventId:'sdk_a',revision:0,final:false})).toBe(rows);
 expect(rows).toHaveLength(1);expect(rows[0].text).toBe('Hi there');
 expect(updateTranscript(rows,{text:'Legacy'})).toHaveLength(2);
});
it('managed voice previews use the selected conversation voice and keep stored provider credentials unchanged',async()=>{
 const {managedBrowserSettings}=await import('../src/livekit-settings');
 const stored={engine:'pipeline',voice:'cedar',realtime_voice:'marin',realtime_provider:'custom',realtime_api_key:'workspace-only'} as any;
 const original=structuredClone(stored);env.REALTIME_API_KEY='synthetic-operator';
 const routed=managedBrowserSettings(env,stored);
 expect(routed.realtime_voice).toBe('cedar');expect(routed.realtime_model).toBe('gpt-live-1');expect(routed.realtime_api_key).toBe('synthetic-operator');expect(stored).toEqual(original);
 expect(()=>managedBrowserSettings(env,{...stored,voice:'azure-only'})).toThrow();
});
