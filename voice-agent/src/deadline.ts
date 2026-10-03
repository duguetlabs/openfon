/** A deadline limits waiting; callers must still stop the underlying transport. */
export async function within<T>(work:Promise<T>,milliseconds:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Call operation deadline')),milliseconds);})]);}
  finally{clearTimeout(timer);}
}
