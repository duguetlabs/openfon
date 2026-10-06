import {ReadableStream} from 'node:stream/web';
import type {AudioFrame} from '@livekit/rtc-node';

type RecordRow = {kind:string;sourceMs:number;[key:string]:unknown};
/** Diagnostics never await storage on an RTC forwarding path. One upload at a time. */
export class DebugRecording {
  private queue:RecordRow[]=[];
  private bytes=0;
  private sequence=0;
  private partial=false;
  private stopped=false;
  private disabled=false;
  private chain:Promise<void>=Promise.resolve();
  private scheduled=false;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private start=performance.now();
  constructor(private send:(body:Record<string,unknown>)=>Promise<unknown>){}
  event(name:string):void {this.add({kind:'capture',name,sourceMs:performance.now()-this.start});}
  protocol(type:unknown):void {
    const names:Record<string,string>={'input_audio_buffer.speech_started':'speech_start','input_audio_buffer.speech_stopped':'speech_end','response.cancel':'cancel','conversation.item.truncate':'truncate','error':'error'};
    if(typeof type==='string'&&Object.hasOwn(names,type))this.event(names[type]!);
  }
  audio(track:'caller'|'agent',frame:AudioFrame):void {
    if(this.stopped||this.disabled)return;
    try {
      if(frame.channels!==1||![16000,24000,48000].includes(frame.sampleRate)||frame.data.byteLength>192000){this.partial=true;return;}
      const data=Buffer.from(frame.data.buffer,frame.data.byteOffset,frame.data.byteLength);
      const sourceMs=performance.now()-this.start;
      for(let offset=0;offset<data.length;offset+=6000)this.add({kind:'audio',sourceMs:sourceMs+offset/(frame.sampleRate*2)*1000,track,format:`pcm_s16le_${frame.sampleRate}`,data:data.subarray(offset,offset+6000).toString('base64')});
    }catch{this.partial=true;}
  }
  private add(record:RecordRow):void {
    if(this.stopped||this.disabled)return;
    try {
      const size=Buffer.byteLength(JSON.stringify(record));
      if(this.bytes+size>1024*1024){this.partial=true;return;}
      this.queue.push(record);this.bytes+=size;
      if(this.bytes>30000)this.schedule();
      else this.timer??=setTimeout(()=>{this.timer=undefined;this.schedule();},250);
    }catch{this.partial=true;}
  }
  private schedule():void {
    if(this.scheduled||this.disabled)return;
    this.scheduled=true;
    this.chain=this.chain.then(async()=>{
      while(this.queue.length&&!this.disabled){
        const records:RecordRow[]=[];let size=0;
        while(this.queue.length&&records.length<32){
          const next=this.queue[0]!,length=Buffer.byteLength(JSON.stringify(next));
          if(size+length>40000)break;
          records.push(this.queue.shift()!);this.bytes-=length;size+=length;
        }
        try{await this.send({type:'debug_upload',sequence:this.sequence,records,partial:this.partial,complete:false});this.sequence++;}
        catch{this.disabled=true;this.partial=true;this.queue=[];this.bytes=0;}
      }
    }).finally(()=>{this.scheduled=false;});
  }
  /** Caller puts a deadline around this, then proceeds with normal call finalization. */
  async finish():Promise<void>{
    if(this.stopped)return;
    this.event('stopped');this.stopped=true;clearTimeout(this.timer);
    do {this.schedule();await this.chain;} while(this.queue.length&&!this.disabled);
    if(!this.disabled)await this.send({type:'debug_upload',sequence:this.sequence,records:[],partial:this.partial,complete:true});
  }
}

/** Pull-through observation preserves backpressure and forwards cancellation. */
export function observeAudio(source:ReadableStream<AudioFrame>,observe:(frame:AudioFrame)=>void):ReadableStream<AudioFrame>{
  const reader=source.getReader();
  return new ReadableStream<AudioFrame>({
    async pull(controller){
      try{const next=await reader.read();if(next.done){controller.close();reader.releaseLock();return;}
        try{observe(next.value);}catch{/* recording cannot break speech */}controller.enqueue(next.value);
      }catch(error){controller.error(error);reader.releaseLock();}
    },
    async cancel(reason){try{await reader.cancel(reason);}finally{reader.releaseLock();}},
  },{highWaterMark:0});
}
