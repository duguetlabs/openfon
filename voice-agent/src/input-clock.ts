/** GPT-Live advances only while audio input flows, including text-only calls.
 * Fill genuine input gaps at wall-clock pace; never replay or resubmit mic frames. */
export class IdleInputClock<T extends {samplesPerChannel:number}> {
  private lastReal=-Infinity;
  private lastSilence=-Infinity;
  private timer:ReturnType<typeof setInterval>|undefined;
  private closed=false;
  constructor(private send:(frame:T)=>void,private silence:()=>T,private onError:()=>void,
    private now:()=>number=()=>performance.now(),private onIdleFrame:()=>void=()=>{}){}
  start():void {
    if(this.closed||this.timer!==undefined)return;
    this.timer=setInterval(()=>this.tick(),100);
    this.tick();
  }
  push(frame:T):void {
    if(this.closed||frame.samplesPerChannel<=0)return;
    this.lastReal=this.now();
    this.deliver(frame);
  }
  tick():void {
    if(this.closed||this.timer===undefined)return;
    const now=this.now();
    if(now-this.lastReal<200||now-this.lastSilence<100)return;
    this.lastSilence=now;
    if(this.deliver(this.silence()))this.onIdleFrame();
  }
  private deliver(frame:T):boolean {
    try{this.send(frame);return true;}catch{this.stop();this.onError();return false;}
  }
  stop():void {
    this.closed=true;
    clearInterval(this.timer);this.timer=undefined;
  }
}
