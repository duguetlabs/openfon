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
  begin():ClosureTicket|undefined {
    if(this.pending)return;
    return this.pending={inputRevision:this.revision,attempt:++this.attempt};
  }
  current(ticket:ClosureTicket):boolean {
    return this.pending===ticket&&ticket.inputRevision===this.revision;
  }
  release(ticket:ClosureTicket):void {if(this.pending===ticket)this.pending=undefined;}
}
