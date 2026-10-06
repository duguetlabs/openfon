export interface ClosureTicket {readonly inputRevision:number;readonly attempt:number}
/** A goodbye belongs to the caller input that requested it, never to newer input. */
export class ToolClosure {
  private revision=0;
  private attempt=0;
  private pending:ClosureTicket|undefined;
  private inputs=new Map<string,{text:string;final:boolean}>();
  observe(id:string,text:string,final:boolean):void {
    if(!id||!text.trim())return;
    const previous=this.inputs.get(id);
    if(previous?.final)return;
    this.inputs.set(id,{text,final});
    if(this.inputs.size>200)this.inputs.delete(this.inputs.keys().next().value!);
    // SDK final reconciliation with unchanged text is not renewed caller input.
    if(previous?.text===text)return;
    this.revision++;
    this.pending=undefined;
  }
  cancel():void{this.revision++;this.pending=undefined;}
  begin():ClosureTicket|undefined {
    if(this.pending)return;
    return this.pending={inputRevision:this.revision,attempt:++this.attempt};
  }
  current(ticket:ClosureTicket):boolean {
    return this.pending===ticket&&ticket.inputRevision===this.revision;
  }
  release(ticket:ClosureTicket):void {if(this.pending===ticket)this.pending=undefined;}
}

/** SDK interruption can omit already-returned tool output. Normal completion does not release its reservation. */
export function watchClosureInterruption(
  signal: AbortSignal,
  speech: Pick<import('@livekit/agents').voice.SpeechHandle, 'interrupted' | 'addDoneCallback' | 'removeDoneCallback'>,
  release: () => void,
): void {
  let finished=false;
  const cleanup=()=>{signal.removeEventListener('abort',interrupted);speech.removeDoneCallback(done);};
  const interrupted=()=>{if(finished)return;finished=true;cleanup();release();};
  const done=(handle:import('@livekit/agents').voice.SpeechHandle)=>{
    if(handle.interrupted){interrupted();return;}
    if(finished)return;finished=true;cleanup();
  };
  if(signal.aborted||speech.interrupted){interrupted();return;}
  signal.addEventListener('abort',interrupted,{once:true});
  speech.addDoneCallback(done);
}
