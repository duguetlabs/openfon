import {within} from './deadline.js';

/** Retains an early accepted echo and releases shutdown without an unhandled rejection. */
export class ProviderReadiness {
  private resolve!:(accepted:boolean)=>void;
  private settled=false;
  private outcome=new Promise<boolean>(resolve=>{this.resolve=resolve;});
  accept():boolean{if(this.settled)return false;this.settled=true;this.resolve(true);return true;}
  close():void{if(!this.settled){this.settled=true;this.resolve(false);}}
  async wait(milliseconds?:number):Promise<boolean>{
    return milliseconds===undefined?await this.outcome:await within(this.outcome,milliseconds);
  }
}
