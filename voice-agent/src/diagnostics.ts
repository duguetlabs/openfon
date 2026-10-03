const PHASES=['startup','session_starting','agent_session_started','session_started','readiness_ack','greeting_queued','speech_created','reply_authorized','generation_created'] as const;
const EVENTS=['session.start','session.started','session.output_audio.delta','session.input_transcript.delta','session.output_transcript.delta','session.delegation.created','response.event','session.closed','error','session.commentary.append','session.commentary.appended','session.input_audio.append','idle_frame_forwarded'] as const;
/** Fixed names and saturating counts only. Never serialize provider payloads. */
export class VoiceDiagnostics {
  private phases=new Map<string,number>();
  private counts=new Map<string,number>();
  private snapshots=0;
  private ended=false;
  private started:number;
  constructor(private callId:string,private emit:(record:Record<string,unknown>)=>void,private now:()=>number=()=>performance.now()){
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(callId))throw new Error('Invalid diagnostic call');
    this.started=now();
  }
  phase(name:typeof PHASES[number]):void{
    if(this.ended||!(PHASES as readonly string[]).includes(name))return;
    const previous=this.phases.get(name)??0;
    this.phases.set(name,Math.min(1000000,previous+1));
    if(!previous)this.emit({event:'openfon_voice_diagnostic',callId:this.callId,phase:name,elapsedMs:this.elapsed()});
  }
  count(name:unknown):void{
    if(this.ended||typeof name!=='string'||!(EVENTS as readonly string[]).includes(name))return;
    this.counts.set(name,Math.min(1000000,(this.counts.get(name)??0)+1));
  }
  snapshot(final=false):void{
    if(this.ended||(!final&&this.snapshots>=12))return;
    if(final)this.ended=true;else this.snapshots++;
    this.emit({event:'openfon_voice_diagnostic',callId:this.callId,phase:final?'final_counts':'counts',elapsedMs:this.elapsed(),
      phases:Object.fromEntries(this.phases),counts:Object.fromEntries(this.counts)});
  }
  private elapsed():number{return Math.max(0,Math.min(3600000,Math.round(this.now()-this.started)));}
}
