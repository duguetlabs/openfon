import {realtime} from '@livekit/agents-plugin-openai';
import {AudioFrame} from '@livekit/rtc-node';
import {IdleInputClock} from './input-clock.js';
/** A single forwarding seam covers SDK microphone frames and idle clock frames. */
export class ClockedGPTLiveSession extends realtime.GPTLiveSession {
  private readonly inputClock:IdleInputClock<AudioFrame>;
  constructor(model:realtime.GPTLiveModel,onClockError:()=>void,private diagnostics?:{idleFrame:()=>void;replyAuthorized:()=>void}){
    super(model);
    this.inputClock=new IdleInputClock(frame=>super.pushAudio(frame),
      ()=>new AudioFrame(new Int16Array(2400),24000,1,2400),onClockError,undefined,()=>this.diagnostics?.idleFrame());
  }
  override pushAudio(frame:AudioFrame):void {this.inputClock.push(frame);}
  override _generateReply(instructions?:string):void {this.diagnostics?.replyAuthorized();super._generateReply(instructions);}
  startInputClock():void {this.inputClock.start();}
  stopInputClock():void {this.inputClock.stop();}
  override async close():Promise<void>{this.stopInputClock();await super.close();}
}
