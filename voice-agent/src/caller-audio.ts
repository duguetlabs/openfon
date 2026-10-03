/** Select only the server-admitted caller's microphone, including late publications. */
export function createCallerAudioSubscription<T extends {source?:number;setSubscribed(value:boolean):void}>(callerIdentity:string,microphoneSource:number,onSubscribed:()=>void){
  let active=true;
  const subscriptions=new Set<T>();
  return {
    subscribe:(publication:T,participant:{identity:string})=>{
      if(!active||participant.identity!==callerIdentity||publication.source!==microphoneSource||subscriptions.has(publication))return;
      subscriptions.add(publication);publication.setSubscribed(true);onSubscribed();
    },
    stop:()=>{
      active=false;let confirmed=true;
      // Room disconnection can dispose native publication handles first. Still
      // clear every handle and let the caller finish persistence and shutdown.
      for(const publication of subscriptions){try{publication.setSubscribed(false);}catch{confirmed=false;}}
      subscriptions.clear();return confirmed;
    },
  };
}
