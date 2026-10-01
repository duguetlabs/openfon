export interface ProviderTranscript {sourceItemId:string;revision:number;role:'caller'|'assistant';text:string;final:boolean;timestamp:string}
/** Uses provider/SDK item IDs; partial text never becomes action evidence. */
export class TranscriptBridge {
  private items=new Map<string,{revision:number;text:string;final:boolean;role:string}>();
  private tail:Promise<void>=Promise.resolve();
  private failure:unknown;
  private pending=0;
  constructor(private persist:(item:ProviderTranscript)=>Promise<void>,private finalCaller:(id:string)=>Promise<void>,private limit=1000){}
  record(item:{id:string;role:'caller'|'assistant';text:string;final:boolean;createdAt?:number}):Promise<void>{
    if(this.failure)return Promise.reject(new Error('Transcript persistence unavailable'));
    if(this.pending>=256)return Promise.reject(new Error('Transcript queue capacity exhausted'));
    this.pending++;
    const work=this.tail.then(async()=>{
      if(!item.id||item.id.length>120||!item.text)return;
      if(item.text.length>30000)throw new Error('Transcript capacity exhausted');
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
    this.tail=work.catch(error=>{this.failure=error;}).finally(()=>{this.pending--;});return work;
  }
  async flush(){await this.tail;if(this.failure)throw this.failure;}
}
