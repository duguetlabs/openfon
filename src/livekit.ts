import type { Env } from './types';

export interface LivekitSession {
  room: string; caller: string; callId: string; callback: string;
  instructions: string; greeting: string; voice: string; language: string;
  commands?:Array<{id:string;text:string}>;
  jobId?: string; closing?: boolean; finished?: boolean; failed?: boolean;
}
export function livekitEnabled(env: Env): boolean { return env.WEB_VOICE_TRANSPORT === 'livekit'; }
export function secureEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff=0; for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i); return diff===0;
}
export function livekitConfig(env: Env) {
  if(!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_AGENT_SERVICE_TOKEN)throw new Error('Calling service is not configured');
  const url=new URL(env.LIVEKIT_URL);
  if(url.username||url.password||url.search||url.hash||!['wss:','ws:'].includes(url.protocol))throw new Error('Invalid calling service address');
  if(url.protocol==='ws:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Calling service requires TLS');
  return {url:url.href.replace(/\/$/,''),key:env.LIVEKIT_API_KEY,secret:env.LIVEKIT_API_SECRET};
}
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
/** LiveKit-compatible HS256 grants, signed in the Worker; no signing key reaches a browser. */
export async function livekitJwt(env:Env,subject:string,video:Record<string,unknown>,ttl=120):Promise<string>{
 const cfg=livekitConfig(env),now=Math.floor(Date.now()/1000),encoder=new TextEncoder();
 const body=[{alg:'HS256',typ:'JWT'},{iss:cfg.key,sub:subject,nbf:now-5,exp:now+ttl,video}].map(x=>encode(encoder.encode(JSON.stringify(x)))).join('.');
 const key=await crypto.subtle.importKey('raw',encoder.encode(cfg.secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return body+'.'+encode(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(body))));
}
export async function livekitRpc(env:Env,service:'RoomService'|'AgentDispatchService',method:string,body:Record<string,unknown>,room:string):Promise<void>{
 const cfg=livekitConfig(env);
 const token=await livekitJwt(env,'openfon-control',{roomCreate:true,roomAdmin:true,room});
 // Workers supports manual/follow, not redirect:error. Refuse redirects below
 // so an operator bearer token is never forwarded to a different endpoint.
 const response=await fetch(cfg.url.replace(/^ws/,'http')+'/twirp/livekit.'+service+'/'+method,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(8000)});
 // A repeat cleanup of an absent room is already complete. Never print response bodies/tokens.
 if(!response.ok && !(method==='DeleteRoom'&&response.status===404))throw new Error('Calling service operation failed');
 await response.body?.cancel();
}
export async function createLivekitRoom(env:Env,s:LivekitSession){
 await livekitRpc(env,'RoomService','CreateRoom',{name:s.room,emptyTimeout:60,departureTimeout:10,maxParticipants:2},s.room);
 await livekitRpc(env,'AgentDispatchService','CreateDispatch',{room:s.room,agentName:'openfon-released-web',metadata:JSON.stringify({callId:s.callId})},s.room);
 return {serverUrl:livekitConfig(env).url,participantToken:await livekitJwt(env,s.caller,{roomJoin:true,room:s.room,canPublish:true,canPublishSources:['microphone'],canPublishData:false,canSubscribe:true,canUpdateOwnMetadata:false},300)};
}
export function deleteLivekitRoom(env:Env,room:string){return livekitRpc(env,'RoomService','DeleteRoom',{room},room);}
