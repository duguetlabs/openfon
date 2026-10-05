import {mkdir,open,rename,readdir,readFile,unlink,stat,rmdir} from 'node:fs/promises';
import {join} from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {ControlClient,AdmissionError} from './control.js';import type {UsageObservation} from './usage.js';
export interface PendingUsage{callId:string;room:string;jobId:string;callback:string;observation:UsageObservation;}
interface Stored{createdAt:number;value:PendingUsage;}
const LIMIT=1000,MAX_BYTES=16384,RETENTION_MS=7*86400000;
/** Restricted persistent volume. No transcript, destination URL or provider/service key is stored. */
export class UsageOutbox{
 constructor(private directory:string,private base:string,private serviceKey:string,private deliverOverride?:(value:PendingUsage)=>Promise<void>){if(!directory.startsWith('/')||directory.includes('\0'))throw Error('Usage outbox requires an absolute path');}
 private file(value:PendingUsage){return join(this.directory,createHash('sha256').update(value.callId+'\0'+value.observation.eventId).digest('hex')+'.json');}
 private async pruneTemporary():Promise<void>{
  for(const name of await readdir(this.directory))if(/^(?:[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp|[a-f0-9-]{36}\.probe)$/.test(name))await this.remove(join(this.directory,name));
 }
 private async syncDirectory(){const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}}
 private async withLock<T>(fn:()=>Promise<T>):Promise<T>{
  await mkdir(this.directory,{recursive:true,mode:0o700});const lock=join(this.directory,'writer.lock');
  for(let attempt=0;;attempt++){
   try{await mkdir(lock,{mode:0o700});const owner=await open(join(lock,'pid'),'wx',0o600);try{await owner.writeFile(String(process.pid));}finally{await owner.close();}break;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||attempt>=50)throw Error('Usage journal unavailable');
    // Recover a process crash, never steal a live writer's lock based on a lease timer.
    try{const pid=Number(await readFile(join(lock,'pid'),'utf8'));try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH'){await unlink(join(lock,'pid'));await rmdir(lock);}}}catch{try{if(Date.now()-(await stat(lock)).mtimeMs>30000){await rmdir(lock);}}catch{}}
    await new Promise(resolve=>setTimeout(resolve,20));
   }
  }
  try{return await fn();}finally{await unlink(join(lock,'pid'));await rmdir(lock);}
 }
 /** Before opening paid inference, fail closed if storage is unavailable or the bounded queue is full. */
 async assertAvailable():Promise<void>{await this.withLock(async()=>{await this.pruneTemporary();const names=await readdir(this.directory);if(names.filter(n=>/\.(json|dead)$/.test(n)).length>=LIMIT)throw Error('Usage journal full');const probe=join(this.directory,randomUUID()+'.probe');const file=await open(probe,'wx',0o600);try{await file.sync();}finally{await file.close();await unlink(probe);}await this.syncDirectory();});}
 async send(value:PendingUsage):Promise<void>{
  this.valid(value);const target=this.file(value);
  const stored=await this.withLock(async()=>{
   try{return JSON.parse(await readFile(target,'utf8')) as Stored;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   await this.pruneTemporary();const names=await readdir(this.directory);if(names.filter(n=>/\.(json|dead)$/.test(n)).length>=LIMIT)throw Error('Usage journal full');
   const stored:Stored={createdAt:Date.now(),value},serialized=JSON.stringify(stored);if(Buffer.byteLength(serialized)>MAX_BYTES)throw Error('Usage record exceeds bound');
   const tmp=target+'.'+randomUUID()+'.tmp',file=await open(tmp,'wx',0o600);try{await file.writeFile(serialized);await file.sync();}finally{await file.close();}
   await rename(tmp,target);await this.syncDirectory();return stored;
  });
  await this.deliver(stored.value);await this.remove(target);
 }
 private async remove(file:string){await unlink(file).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});await this.syncDirectory();}
 private valid(value:PendingUsage):void{
  if(!value||!['callId','room','jobId','callback'].every(key=>typeof value[key as keyof PendingUsage]==='string'&&(value[key as keyof PendingUsage] as string).length>0&&(value[key as keyof PendingUsage] as string).length<=200)||!value.observation||typeof value.observation.eventId!=='string'||value.observation.eventId.length>200||value.observation.callId!==value.callId||value.observation.jobId!==value.jobId)throw new AdmissionError(400);
 }
 private async deliver(value:PendingUsage){
  this.valid(value);
  if(this.deliverOverride)return this.deliverOverride(value);
  const control=new ControlClient(this.base,this.serviceKey,value.callId,value.room,value.jobId);
  await control.post('events',{callback:value.callback,type:'usage',observation:value.observation});
 }
 async replay(limit=20):Promise<{sent:number;pending:number;dead:number;expired:number}>{
  const names=await this.withLock(async()=>{await this.pruneTemporary();return (await readdir(this.directory)).filter(name=>/^[a-f0-9]{64}\.(json|dead)$/.test(name));});
  let sent=0,dead=0,expired=0,attempted=0,pending=0;
  for(const name of names){const file=join(this.directory,name);try{
    const info=await stat(file);
    // Invalid records have no trustworthy createdAt; filesystem age bounds their quarantine.
    if(Date.now()-info.mtimeMs>RETENTION_MS){await this.remove(file);expired++;continue;}
    if(name.endsWith('.dead')){dead++;continue;}
    if(info.size>MAX_BYTES)throw new AdmissionError(400);
    let stored:Stored;try{stored=JSON.parse(await readFile(file,'utf8')) as Stored;}catch{throw new AdmissionError(400);}
    if(!stored||!Number.isFinite(stored.createdAt)||stored.createdAt>Date.now()+60000||!stored.value)throw new AdmissionError(400);
    this.valid(stored.value);
    if(Date.now()-stored.createdAt>RETENTION_MS){await this.remove(file);expired++;continue;}
    if(this.file(stored.value)!==file)throw new AdmissionError(400);
    if(attempted++>=limit){pending++;continue;}
    await this.deliver(stored.value);await this.remove(file);sent++;
   }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')continue;
    if(error instanceof AdmissionError&&[400,403,404,409,410].includes(error.status)){
      try{await rename(file,file.replace(/\.json$/,'.dead'));await this.syncDirectory();dead++;}catch{pending++;}
    }else pending++;
    // Transient failures remain queued; revoked/deleted/malformed records never change account.
   }}
  return {sent,pending,dead,expired};
 }
}
