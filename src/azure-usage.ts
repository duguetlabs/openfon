import type {UsageObservation,UsageMetrics} from './commercial-types';
import {usageHash} from './commercial-usage';
import {azureTextMetrics} from './managed-processing';
const obj=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
export const azureIdentifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(v);
/** Exact decimal form supported by the ledger; never round away provider precision. */
export function azureSeconds(value:unknown):string|undefined{if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>86400)return;const fixed=value.toFixed(9);if(Number(fixed)!==value)return;return fixed.replace(/0+$/,'').replace(/\.$/,'')||'0';}
/** Numeric upstream evidence only; no transcript, tool arguments or provider error is serialized. */
export async function azureUsageObservation(callId:string,jobId:string,sessionId:string,event:Record<string,unknown>):Promise<UsageObservation|undefined>{
 if(!azureIdentifier(sessionId))return;
 let source:UsageObservation['source'],metrics:UsageMetrics={},final=false,responseId:string|undefined,model:string|undefined;
 if(event.type==='session.usage.updated'||event.type==='session.closed'||event.type==='openfon.usage.unreported'){
  source='azure_voice';final=event.type==='session.closed';model='gpt-live-1';const seconds=obj(event.usage)?.seconds;
  const decimal=azureSeconds(seconds);if(decimal!==undefined)metrics.voiceSessionSeconds=decimal;else if(!final&&event.type!=='openfon.usage.unreported')return;
 }else if(event.type==='response.event'){
  const nested=obj(event.event);if(!nested||!['response.completed','response.failed','response.incomplete'].includes(String(nested.type)))return;
  const response=obj(nested.response);if(!azureIdentifier(response?.id))return;responseId=response.id;source='azure_reasoning';final=true;model=azureIdentifier(response.model)?response.model:undefined;metrics=azureTextMetrics(response.usage);
 }else return;
 const eventId='azure_'+await usageHash(JSON.stringify({source,session:sessionId,responseId,final,metrics}));
 return {eventId,callId,jobId,source,providerSessionId:sessionId,...(responseId?{providerResponseId:responseId}:{}),observedAt:new Date().toISOString(),final,metrics,...(model?{model}:{})};
}
