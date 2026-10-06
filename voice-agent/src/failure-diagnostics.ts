import {createHash} from 'node:crypto';

export type FailureStage='mini_terminal'|'sdk_session'|'control_request'|'control_monitor';
const codes=new Set(['configuration_invalid','protocol_invalid','protocol_rejected','authentication_failed','quota_unavailable','session_identity_changed','transport_unavailable','protocol_limit','audio_format_invalid','input_backpressure','invalid_api_key','authentication_error','insufficient_quota','rate_limit_exceeded','invalid_value','invalid_request_error','invalid_type','response_cancel_not_active','conversation_already_has_active_response','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET']);
const classes=new Set(['Error','TypeError','RangeError','AbortError','TimeoutError','APIError','APIConnectionError','ResponseUnavailable','AdmissionError']);
const types=new Set(['realtime_model_error','llm_error','stt_error','tts_error','interruption_detection_error','invalid_request_error','server_error']);
const parameters=new Set(['audio','audio_end_ms','item_id','response_id','content_index','input','model','voice','tools','session','session.audio','session.audio.input','session.audio.output','session.audio.input.turn_detection','session.audio.output.voice']);
const reported=new WeakSet<object>();
const fingerprint=(value:string)=>createHash('sha256').update(value.slice(0,4096)).update('\0'+value.length).digest('hex').slice(0,16);
// Read own data fields only: logging must not invoke arbitrary getters or toJSON.
function field(value:object,key:string):unknown {return Object.getOwnPropertyDescriptor(value,key)?.value;}
function chain(error:unknown):object[]{
  const result:object[]=[];const pending:Array<{value:unknown;depth:number}>=[{value:error,depth:0}];
  for(let n=0;n<pending.length&&result.length<8;n++){
    const {value,depth}=pending[n]!;
    if(!value||typeof value!=='object'||result.includes(value))continue;
    result.push(value);
    if(depth<3)for(const key of ['error','cause'])pending.push({value:field(value,key),depth:depth+1});
  }
  return result;
}

/** Fixed names and hashes only. Never expose raw error text, URLs, payloads or credentials. */
export function classifyFailure(stage:FailureStage,error:unknown,detail?:unknown):Record<string,string|number>{
  const record:Record<string,string|number>={stage};
  const nodes=[...chain(detail),...chain(error)].slice(0,16);
  const select=(key:string,value:unknown,allowed:Set<string>)=>{
    if(typeof value!=='string'||record[key]!==undefined||record[key+'Hash']!==undefined)return;
    if(allowed.has(value))record[key]=value;else record[key+'Hash']=fingerprint(value);
  };
  for(const node of nodes){
    select('code',field(node,'code'),codes);
    select('category',field(node,'category'),codes);
    select('parameter',field(node,'param'),parameters);
    select('type',field(node,'type'),types);
    select('errorClass',field(node,'name'),classes);
    if(node instanceof Error&&!record.errorClass&&!record.errorClassHash)record.errorClass=node instanceof TypeError?'TypeError':node instanceof RangeError?'RangeError':'Error';
    for(const key of ['status','statusCode']){
      const status=field(node,key);
      if(record.httpStatus===undefined&&typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599)record.httpStatus=status;
    }
    // Message fingerprints are diagnostic correlations, never authoritative error categories.
    const message=field(node,'message');
    if(typeof message==='string'&&record.messageHash===undefined)record.messageHash=fingerprint(message);
  }
  if(!nodes.length)record.unknown='true';
  return record;
}

/** Deduplicate the same initiating exception as the SDK wraps and re-emits it. */
export function reportFailure(stage:FailureStage,error:unknown,emit:(record:Record<string,string|number>)=>void,detail?:unknown):void{
  try{
    const nodes=chain(error);
    if(nodes.some(node=>reported.has(node)))return;
    emit(classifyFailure(stage,error,detail));
    for(const node of nodes)reported.add(node);
  }catch{/* Diagnostics must never change the existing failure path. */}
}
