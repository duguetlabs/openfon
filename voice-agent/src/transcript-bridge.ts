export interface ProviderTranscript {sourceItemId:string;revision:number;role:'caller'|'assistant';text:string;final:boolean;timestamp:string}
interface TranscriptInput {id:string;role:'caller'|'assistant';text:string;final:boolean;createdAt?:number}
interface QueuedTranscript {item:TranscriptInput;work:Promise<void>;started:boolean;mergeable:boolean}
/** Uses provider/SDK item IDs; partial text never becomes action evidence. */
export class TranscriptBridge {
  private items=new Map<string,{revision:number;text:string;final:boolean;role:string}>();
  private tail:Promise<void>=Promise.resolve();
  private failure:unknown;
  private pending=0;
  private queuedTail:QueuedTranscript|undefined;
  constructor(private persist:(item:ProviderTranscript)=>Promise<void>,private finalCaller:(id:string)=>Promise<void>,private limit=1000){}
  record(item:TranscriptInput):Promise<void>{
    if(this.failure)return Promise.reject(new Error('Transcript persistence unavailable'));
    // Providers may stream spacing before the first word. Keep the accumulator
    // unchanged, but do not send an empty semantic transcript to the application.
    if(item.text.length<=30000&&!item.text.trim())return Promise.resolve();
    // Validate before a replacement can hide an invalid intermediate update.
    // Rejections remain queued in order, as with a failed persistence request.
    const invalid=item.text.length>30000?new Error('Transcript capacity exhausted'):
      !['caller','assistant'].includes(item.role)?new Error('Transcript role invalid'):
      item.createdAt!==undefined&&!Number.isFinite(new Date(item.createdAt).getTime())?new Error('Transcript timestamp invalid'):undefined;
    const mergeable=!invalid&&!item.final&&Boolean(item.id)&&item.id.length<=120;
    const previous=this.queuedTail;
    if(mergeable&&previous?.mergeable&&!previous.started&&previous.item.id===item.id&&previous.item.role===item.role){
      previous.item={...item};
      return previous.work;
    }
    if(this.pending>=256)return Promise.reject(new Error('Transcript queue capacity exhausted'));
    this.pending++;
    const queued:QueuedTranscript={item:{...item},work:Promise.resolve(),started:false,mergeable};
    const work=this.tail.then(async()=>{
      queued.started=true;
      if(this.queuedTail===queued)this.queuedTail=undefined;
      const item=queued.item;
      if(invalid)throw invalid;
      if(!item.id||item.id.length>120||!item.text)return;
      const prior=this.items.get(item.id);
      if(prior?.role&&prior.role!==item.role)throw new Error('Transcript identity changed role');
      if(prior?.final||prior?.text===item.text&&prior.final===item.final)return;
      if(!prior&&this.items.size>=this.limit)throw new Error('Transcript item capacity exhausted');
      const revision=prior?prior.revision+1:0;
      const timestamp=new Date(item.createdAt??Date.now()).toISOString();
      await this.persist({sourceItemId:item.id,revision,role:item.role,text:item.text,final:item.final,timestamp});
      this.items.set(item.id,{revision,text:item.text,final:item.final,role:item.role});
      if(item.role==='caller'&&item.final)await this.finalCaller(item.id);
    });
    queued.work=work;this.queuedTail=queued;
    this.tail=work.catch(error=>{this.failure=error;}).finally(()=>{this.pending--;});return work;
  }
  async flush(){await this.tail;if(this.failure)throw this.failure;}
}
