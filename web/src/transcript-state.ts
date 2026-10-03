export interface TranscriptRevision {eventId?:string;revision?:number;final?:boolean}
/** Legacy events append; SDK-identified revisions replace their existing utterance. */
export function updateTranscript<T extends {text:string}&TranscriptRevision>(rows:T[],next:T):T[] {
  if(!next.eventId)return [...rows,next];
  const index=rows.findIndex(row=>row.eventId===next.eventId);
  if(index<0)return [...rows,next];
  const prior=rows[index];
  if(prior.final || (prior.revision??-1)>=(next.revision??-1))return rows;
  return rows.map((row,i)=>i===index?next:row);
}
