import type {voice} from '@livekit/agents';

/** Let the SDK associate a queued reply with its own user item. The command ID
 * governs delivery; ConversationItemAdded supplies the single transcript ID. */
export function submitTypedInput(
  session: Pick<voice.AgentSession, 'generateReply'>,
  command: {id: string; text: string},
): voice.SpeechHandle {
  return session.generateReply({userInput: command.text});
}

/** Admission precedes SDK authorization. Closures wait for all admitted typed
 * turns, without blocking the monitor or making a tool await its own handle. */
export class PendingTypedInput {
  private pending=new Set<string>();
  private waiters=new Set<()=>void>();
  private closed=false;
  get idle():boolean{return !this.closed&&this.pending.size===0;}
  admit(id:string):void{if(!this.closed)this.pending.add(id);}
  track(id:string,handle:Pick<voice.SpeechHandle,'waitForPlayout'>,fail:()=>void):void{
    void handle.waitForPlayout().then(()=>this.release(id),()=>{
      if(!this.closed)fail();
      this.release(id);
    });
  }
  async waitUntilIdle():Promise<boolean>{
    while(!this.closed&&this.pending.size)await new Promise<void>(resolve=>this.waiters.add(resolve));
    return !this.closed;
  }
  close():void{this.closed=true;this.pending.clear();this.wake();}
  private release(id:string):void{this.pending.delete(id);if(!this.pending.size)this.wake();}
  private wake():void{for(const wake of this.waiters)wake();this.waiters.clear();}
}
