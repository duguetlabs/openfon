/** Same multilingual farewell vocabulary as the released application's isFarewell.
 * Kept in the independent agent image; cross-application parity is regression-tested. */
const FAREWELL_RE = /(?<!\p{L})(good\s?bye|bye\s?bye|bye now|bye|see you|that('|’)s all|auf wiederh(ö|oe?)ren|auf wiedersehen|tsch(ü|ue?)ss|au revoir|bonne journ(é|e)e|adi(ó|o)s|hasta luego|arrivederci|buona giornata|tot ziens|doei|hej d(å|a)|vi ses|farvel|n(ä|a)kemiin|heippa|до свидания|всего доброго)(?!\p{L})/iu;
export const isFarewell=(text:string)=>FAREWELL_RE.test(text);
/** Delegation is nondeterministic. Require a real exchange and paired final words,
 * then let SDK playout finish. Renewed caller input invalidates any pending close. */
export class FarewellPair {
  private finalIds=new Set<string>();
  private currentCaller='';
  private revision=0;
  private candidate:number|undefined;
  private agent:{revision:number;text:string}|undefined;
  private requested:number|undefined;
  constructor(private closeAfterPlayout:(stillCurrent:()=>boolean)=>void){}
  record(role:'caller'|'assistant',id:string,text:string,final:boolean):void{
    if(!text.trim()||this.finalIds.has(id))return;
    if(role==='caller'&&id!==this.currentCaller){this.currentCaller=id;this.revision++;this.candidate=undefined;}
    if(!final)return;
    this.finalIds.add(id);
    if(role==='caller')this.candidate=isFarewell(text)&&!text.includes('?')?this.revision:undefined;
    else this.agent={revision:this.revision,text};
    const revision=this.candidate;
    if(this.finalIds.size<3||revision===undefined||this.requested===revision||this.agent?.revision!==revision||!isFarewell(this.agent.text)||this.agent.text.includes('?'))return;
    this.requested=revision;
    this.closeAfterPlayout(()=>this.candidate===revision&&this.revision===revision);
  }
}
