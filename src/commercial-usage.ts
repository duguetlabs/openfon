import type {Env} from './types';
import {PLANS, type UsageObservation, type UsageMetrics, type PlanId, type BillingCadence} from './commercial-types';
type Store=Pick<Env,'DB'>;
const ident=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(v);
const int=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const tokenFields=['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningTokens','totalTokens'] as const;
export class UsageError extends Error {}
export async function usageHash(value:string):Promise<string>{
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function normalizeUsage(observation:UsageObservation):Record<string,number>{
 if(!observation||!ident(observation.eventId)||!ident(observation.providerSessionId)||
  !['azure_voice','azure_reasoning','azure_text'].includes(observation.source)||typeof observation.final!=='boolean'||
  !Number.isFinite(Date.parse(observation.observedAt))||!observation.metrics||typeof observation.metrics!=='object'||Array.isArray(observation.metrics))throw new UsageError('Invalid usage observation');
 if(observation.source!=='azure_voice'&&!ident(observation.providerResponseId))throw new UsageError('Missing response identity');
 if(observation.providerResponseId!==undefined&&!ident(observation.providerResponseId))throw new UsageError('Invalid response identity');
 if(observation.model!==undefined&&(typeof observation.model!=='string'||observation.model.length>200))throw new UsageError('Invalid model');
 const output:Record<string,number>={};
 for(const [key,value] of Object.entries(observation.metrics)){
  if(key==='voiceSessionSeconds'){
   if(typeof value!=='string'||!/^\d{1,10}(\.\d{1,3})?$/.test(value))throw new UsageError('Invalid provider seconds');
   const [whole,fraction='']=value.split('.');const ms=Number(whole)*1000+Number(fraction.padEnd(3,'0'));
   if(!int(ms))throw new UsageError('Invalid provider seconds');output.voiceSessionMs=ms;
  }else if(tokenFields.includes(key as typeof tokenFields[number])&&int(value)){output[key]=value;}
  else throw new UsageError('Invalid usage metric');
 }
 if(output.cachedInputTokens!==undefined&&output.inputTokens!==undefined&&output.cachedInputTokens>output.inputTokens)throw new UsageError('Invalid cached usage');
 if(output.reasoningTokens!==undefined&&output.outputTokens!==undefined&&output.reasoningTokens>output.outputTokens)throw new UsageError('Invalid reasoning usage');
 return output;
}

async function record(env:Store,scope:{businessId:string;operationId:string;callId?:string},observation:UsageObservation){
 if(!ident(scope.operationId)||!ident(scope.businessId))throw new UsageError('Invalid operation');
 const metrics=normalizeUsage(observation);
 const usageKey=observation.source==='azure_voice'?observation.providerSessionId:observation.providerResponseId!;
 const canonical=JSON.stringify({scope,source:observation.source,usageKey,observedAt:observation.observedAt,final:observation.final,model:observation.model??null,metrics:Object.fromEntries(Object.entries(metrics).sort())});
 const hash=await usageHash(canonical);
 const prior=await env.DB.prepare('SELECT payload_hash FROM commercial_provider_observations WHERE event_id=?').bind(observation.eventId).first<{payload_hash:string}>();
 if(prior){if(prior.payload_hash!==hash)throw new UsageError('Conflicting usage event');return {duplicate:true};}
 const writes=[env.DB.prepare(`INSERT INTO commercial_provider_observations(event_id,business_id,call_id,operation_id,source,usage_key,observed_at,is_final,payload_hash,metrics_json,model)
 SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM businesses WHERE id=?)
 ON CONFLICT(event_id) DO NOTHING`).bind(observation.eventId,scope.businessId,scope.callId??null,scope.operationId,observation.source,usageKey,observation.observedAt,observation.final?1:0,hash,JSON.stringify(metrics),observation.model??null,scope.businessId)];
 // Snapshot counters are not additive. Missing fields remain absent. Token
 // details are independent measurements, never added to their parent total.
 for(const [metric,value] of Object.entries(metrics))writes.push(env.DB.prepare(`INSERT INTO commercial_provider_metrics(business_id,source,usage_key,metric,value,is_final)
 SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM commercial_provider_observations WHERE event_id=? AND payload_hash=? AND business_id=?)
 ON CONFLICT(business_id,source,usage_key,metric) DO UPDATE SET value=MAX(value,excluded.value),is_final=MAX(is_final,excluded.is_final)`)
 .bind(scope.businessId,observation.source,usageKey,metric,value,observation.final?1:0,observation.eventId,hash,scope.businessId));
 await env.DB.batch(writes);
 const stored=await env.DB.prepare('SELECT payload_hash FROM commercial_provider_observations WHERE event_id=?').bind(observation.eventId).first<{payload_hash:string}>();
 if(stored?.payload_hash!==hash)throw new UsageError('Usage event could not be recorded');
 return {duplicate:false};
}

/** Invoke only after the existing authenticated job/call admission checks. */
export async function ingestProviderUsage(env:Store,context:{callId:string;jobId:string;businessId:string},observation:UsageObservation){
 if(observation.callId!==context.callId||observation.jobId!==context.jobId)throw new UsageError('Usage scope mismatch');
 const call=await env.DB.prepare('SELECT business_id FROM calls WHERE id=? AND business_id=?').bind(context.callId,context.businessId).first();
 if(!call)throw new UsageError('Usage call missing');
 return record(env,{businessId:context.businessId,operationId:context.callId,callId:context.callId},observation);
}
/** Trusted Worker operations only; not exposed as customer-supplied usage. */
export async function recordOperationUsage(env:Store,context:{businessId:string;operationId:string;callId?:string;kind:'preview'|'summary'|'extraction'},observation:UsageObservation){
 if(context.callId){const call=await env.DB.prepare('SELECT id FROM calls WHERE id=? AND business_id=?').bind(context.callId,context.businessId).first();if(!call)throw new UsageError('Usage call missing');}
 return record(env,{businessId:context.businessId,operationId:context.kind+':'+context.operationId,...(context.callId?{callId:context.callId}:{})},observation);
}
export const recordPreviewUsage=(env:Store,context:{businessId:string;operationId:string},observation:UsageObservation)=>recordOperationUsage(env,{...context,kind:'preview'},observation);
export const recordTextUsage=(env:Store,context:{businessId:string;operationId:string;callId?:string},observation:UsageObservation)=>recordOperationUsage(env,{...context,kind:'summary'},observation);

/** Operator-authenticated call reservation only, never a customer flag. */
export async function markOperatorQaCall(env:Store,callId:string,actor:string){
 if(!ident(callId)||!ident(actor))throw new UsageError('Invalid QA marker');
 const result=await env.DB.prepare(`INSERT INTO commercial_qa_calls(call_id,marked_by,marked_at)
 SELECT id,?,? FROM calls WHERE id=? AND status='active'
 AND NOT EXISTS(SELECT 1 FROM commercial_call_usage WHERE call_id=?) ON CONFLICT(call_id) DO NOTHING`)
 .bind(actor,new Date().toISOString(),callId,callId).run();
 return {marked:result.meta.changes===1};
}

/** Server finalization clock only. No browser-supplied duration is accepted. */
export async function recordCompletedCallUsage(env:Store,input:{callId:string;connectedAtMs:number;endedAtMs:number}){
 if(!ident(input.callId)||!int(input.connectedAtMs)||!int(input.endedAtMs)||input.endedAtMs<input.connectedAtMs||input.endedAtMs-input.connectedAtMs>86400000)throw new UsageError('Invalid completed interval');
 const call=await env.DB.prepare("SELECT business_id,connected_at,status FROM calls WHERE id=? AND status IN ('completed','failed')").bind(input.callId).first<{business_id:string;connected_at:string|null;status:string}>();
 if(!call?.connected_at)throw new UsageError('Call has no confirmed connection');
 const result=await env.DB.prepare(`INSERT INTO commercial_call_usage(call_id,business_id,connected_at_ms,ended_at_ms,duration_ms,recorded_at)
 VALUES(?,?,?,?,?,?) ON CONFLICT(call_id) DO NOTHING`).bind(input.callId,call.business_id,input.connectedAtMs,input.endedAtMs,input.endedAtMs-input.connectedAtMs,new Date().toISOString()).run();
 const stored=await env.DB.prepare('SELECT connected_at_ms,ended_at_ms FROM commercial_call_usage WHERE call_id=?').bind(input.callId).first<{connected_at_ms:number;ended_at_ms:number}>();
 if(stored?.connected_at_ms!==input.connectedAtMs||stored.ended_at_ms!==input.endedAtMs)throw new UsageError('Completed usage changed; an audited adjustment is required');
 return {duplicate:result.meta.changes===0};
}

/** UTC subscription anniversary, retaining original day through short months. */
export function monthlyWindow(anchor:string,at:number):{start:string;end:string}{
 const a=new Date(anchor);if(!Number.isFinite(a.getTime())||!Number.isFinite(at)||at<a.getTime())throw new UsageError('Invalid billing anchor');
 const date=(month:number)=>{const y=a.getUTCFullYear()+Math.floor(month/12),m=((month%12)+12)%12;return Date.UTC(y,m,Math.min(a.getUTCDate(),new Date(Date.UTC(y,m+1,0)).getUTCDate()),a.getUTCHours(),a.getUTCMinutes(),a.getUTCSeconds(),a.getUTCMilliseconds());};
 const n=new Date(at);let month=(n.getUTCFullYear()-a.getUTCFullYear())*12+n.getUTCMonth();
 if(date(month)>at)--month;
 return {start:new Date(date(month)).toISOString(),end:new Date(date(month+1)).toISOString()};
}
export function retailOverage(durationMs:number,planId:PlanId,cadence:BillingCadence){
 if(!int(durationMs))throw new UsageError('Invalid duration');const plan=PLANS.find(p=>p.id===planId);if(!plan)throw new UsageError('Invalid plan');
 const includedMs=plan.includedMinutes*60000,overageMs=Math.max(0,durationMs-includedMs);
 const rate=cadence==='annual'?plan.annualOverageMinorPerMinute:plan.monthlyOverageMinorPerMinute;
 // Round once at the cycle total, not each call, second, minute or carrier leg.
 const overageMinor=Number((BigInt(overageMs)*BigInt(rate)+30000n)/60000n);
 return {durationMs,includedMs,overageMs,overageMinor};
}
