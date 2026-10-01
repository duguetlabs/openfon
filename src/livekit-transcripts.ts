import type { Env } from './types';
import {MAX_CALL_TRANSCRIPT_BYTES,MAX_TRANSCRIPT_FIELD_BYTES,transcriptBytes} from './realtime-input';
export interface MediaTranscript {eventId:string;revision:number;final:boolean;role:'caller'|'agent';text:string}
export function parseMediaTranscript(body:Record<string,unknown>):MediaTranscript {
 if(body.type!=='transcript'||typeof body.eventId!=='string'||!/^[a-zA-Z0-9:_-]{1,160}$/.test(body.eventId)||!Number.isSafeInteger(body.revision)||Number(body.revision)<0||Number(body.revision)>10000||typeof body.final!=='boolean'||!['caller','agent'].includes(String(body.role))||typeof body.text!=='string'||!body.text.trim()||transcriptBytes(body.text)>MAX_TRANSCRIPT_FIELD_BYTES)throw new Error('Invalid transcript');
 return {eventId:body.eventId,revision:Number(body.revision),final:body.final,role:body.role as 'caller'|'agent',text:body.text};
}
export async function persistMediaTranscript(env:Env,callId:string,t:MediaTranscript):Promise<boolean>{
 const previous=await env.DB.prepare('SELECT role,text,source_revision,source_final FROM call_turns WHERE call_id=? AND source_id=?').bind(callId,t.eventId).first<{role:string;text:string;source_revision:number;source_final:number}>();
 if(previous){
  if(previous.role!==t.role)throw new Error('Transcript identity conflict');
  if(previous.source_revision===t.revision&&previous.text===t.text&&previous.source_final===Number(t.final))return false;
  if(previous.source_final||previous.source_revision>=t.revision)throw new Error('Transcript revision conflict');
 }
 const result=await env.DB.prepare(`INSERT INTO call_turns(call_id,role,text,source_id,source_revision,source_final)
 SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM calls WHERE id=? AND status='active' AND channel='web')
 AND ((SELECT count(*) FROM call_turns WHERE call_id=?)<200 OR EXISTS(SELECT 1 FROM call_turns WHERE call_id=? AND source_id=?))
 AND (SELECT COALESCE(SUM(length(CAST(text AS BLOB))),0) FROM call_turns WHERE call_id=? AND (source_id IS NULL OR source_id<>?))+?<=${MAX_CALL_TRANSCRIPT_BYTES}
 ON CONFLICT(call_id,source_id) DO UPDATE SET text=excluded.text,source_revision=excluded.source_revision,source_final=excluded.source_final
 WHERE call_turns.role=excluded.role AND call_turns.source_final=0 AND call_turns.source_revision<excluded.source_revision`).bind(callId,t.role,t.text,t.eventId,t.revision,Number(t.final),callId,callId,callId,t.eventId,callId,t.eventId,transcriptBytes(t.text)).run();
 if(!result.meta.changes){
  const winner=await env.DB.prepare('SELECT role,text,source_revision,source_final FROM call_turns WHERE call_id=? AND source_id=?').bind(callId,t.eventId).first<typeof previous>();
  if(winner&&winner.role===t.role&&winner.text===t.text&&winner.source_revision===t.revision&&winner.source_final===Number(t.final))return false;
  throw new Error('Transcript write refused');
 }
 return true;
}
