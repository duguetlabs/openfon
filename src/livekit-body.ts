/** Bound bytes before JSON decoding, including a sender that never finishes its body. */
export async function readLivekitBody(request: Request): Promise<string> {
  const reader=request.body?.getReader();
  if(!reader)throw new Error('Missing body');
  const chunks:Uint8Array[]=[];let bytes=0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Body deadline')),3000);});
  try {
    while(true){
      const {done,value}=await Promise.race([reader.read(),deadline]);
      if(done)break;
      bytes+=value.byteLength;if(bytes>65536)throw new Error('Body limit');chunks.push(value);
    }
    const data=new Uint8Array(bytes);let offset=0;
    for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
    return new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(data);
  } finally {if(timer!==undefined)clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
