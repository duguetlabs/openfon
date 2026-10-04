import type { Hono } from 'hono';
import type { Env } from './types';
type App=Hono<{Bindings:Env;Variables:{userId:string}}>;
const technical=new Set(['engine','realtime_model','realtime_voice','llm_model','llm_base_url','llm_api_key','providerConfigured','apiKeyConfigured','workspaceApiKeyConfigured','effective_text_model','effective_stt_model','effective_realtime_model']);
const restricted=/^\/api\/me\/(?:provider(?:s|-catalog)?|engine-presets|profiles|summary-settings|call-summaries|business\/[^/]+\/(?:agent|profiles|engine-profiles))(?:\/|$)/;
/** Operator-controlled customer boundary. Saved routing is retained privately, never editable through this surface. */
export function registerManagedWebBoundary(app:App){
 app.use('/api/me/*',async(c,next)=>{
  if(c.env.OPENFON_MANAGED_WEB!=='true')return next();
  const path=c.req.path;
  if(restricted.test(path))return c.json({error:'This setting is unavailable.'},404);
  const assistantRoute=/^\/api\/me\/assistants(?:\/[^/]+)?$/.test(path);
  if(assistantRoute&&['POST','PUT'].includes(c.req.method)){
   const body=await c.req.raw.clone().json().catch(()=>null);
   if(body&&typeof body==='object'&&Object.keys(body).some(k=>technical.has(k)))return c.json({error:'Only assistant details can be changed here.'},400);
  }
  await next();
  if(!c.res.headers.get('content-type')?.includes('application/json'))return;
  const data=await c.res.clone().json() as Record<string,unknown>;
  if(!c.res.ok&&data&&typeof data.error==='string'){
   // Technical diagnostics stay in operator logs; customer recovery is status based.
   if(/provider|model|engine|api.?key|endpoint|kataleptic|azure|openai|livekit|credential/i.test(data.error)){
    console.warn('managed_customer_error',{path,status:c.res.status});
    data.error=c.res.status===409?'The saved details changed. Refresh and try again.':'This action could not complete. Please try again.';
   }
  }
  function assistant(value:unknown):unknown{
   if(!value||typeof value!=='object')return value;
   const out={...value as Record<string,unknown>};
   if('realtime_voice' in out)out.voice=out.realtime_voice||out.voice||'';
   for(const key of technical)delete out[key];
   if('greeting' in out){out.engine='';out.realtime_voice='';}
   return out;
  }
  let output:unknown=data;
  if(assistantRoute) output=Array.isArray(data)?data.map(assistant):assistant(data);
  if(path==='/api/me/business' && data && typeof data==='object' && 'agent' in data)data.agent=assistant(data.agent);
  if(path==='/api/me/bootstrap'){
   if(Array.isArray(data.assistants))data.assistants=data.assistants.map(assistant);
   if(data.readiness&&typeof data.readiness==='object')delete(data.readiness as Record<string,unknown>).providerConfigured;
  }
  if(path==='/api/me/calls'&&Array.isArray(data.items))data.items=data.items.map(call=>({...call,failure_code:null,failure_message:call.failure_message?'The call could not complete. Please try again.':null}));
  if(/^\/api\/me\/calls\/[^/]+$/.test(path)&&data.failure_message){data.failure_code=null;data.failure_message='The call could not complete. Please try again.';}
  const headers=new Headers(c.res.headers);headers.delete('content-length');
  c.res=new Response(JSON.stringify(output),{status:c.res.status,headers});
 });
}
