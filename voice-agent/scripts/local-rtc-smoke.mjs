/** Local SFU-only smoke: synthetic tone, no microphone, provider, or cloud credentials. */
import {execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {Room,RoomEvent,AudioSource,AudioFrame,AudioStream,LocalAudioTrack,TrackPublishOptions,TrackSource,dispose} from '@livekit/rtc-node';
import {createLivekitRoom,livekitJwt,deleteLivekitRoom} from '../../src/livekit.ts';
const docker=process.env.DOCKER_BIN||'/usr/local/bin/docker';
const image='livekit/livekit-server@sha256:6fd3b7088874c4d119160dd688798dfec852bc014786d392caad15f6f63912a3';
const run=randomUUID(),label='openfon.local-rtc-smoke';
const env={LIVEKIT_URL:'ws://127.0.0.1:18881',LIVEKIT_API_KEY:'fixture-'+run,LIVEKIT_API_SECRET:randomBytes(32).toString('hex'),LIVEKIT_AGENT_SERVICE_TOKEN:randomBytes(32).toString('hex')};
const config={port:18881,bind_addresses:['0.0.0.0'],rtc:{tcp_port:18882,udp_port:18883,node_ip:'127.0.0.1',use_external_ip:false},keys:{[env.LIVEKIT_API_KEY]:env.LIVEKIT_API_SECRET},logging:{level:'error'}};
const rooms=[];let container='',source,reader;
let timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Local RTC deadline')),30000);});
async function smoke(){
 // Never pulls images or acts on a pre-existing container name.
 container=execFileSync(docker,['run','-d','--rm','--pull=never','--label',label+'='+run,'-p','127.0.0.1:18881:18881','-p','127.0.0.1:18882:18882','-p','127.0.0.1:18883:18883/udp','-e','LIVEKIT_CONFIG',image],{env:{...process.env,LIVEKIT_CONFIG:JSON.stringify(config)},encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 if(!/^[0-9a-f]{64}$/.test(container))throw new Error('Missing owned container identity');
 let ready=false;
 for(let attempt=0;attempt<60;attempt++){try{await fetch('http://127.0.0.1:18881/',{signal:AbortSignal.timeout(250)});ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 if(!ready)throw new Error('SFU unavailable');
 const media={callId:run,room:'smoke-'+run,caller:'caller-'+run};
 const grant=await createLivekitRoom(env,media);
 const observer=new Room(),caller=new Room();rooms.push(observer,caller);
 const received=new Promise(resolve=>observer.on(RoomEvent.TrackSubscribed,(track)=>resolve(track)));
 await observer.connect(env.LIVEKIT_URL,await livekitJwt(env,'observer',{roomJoin:true,room:media.room,canPublish:false,canSubscribe:true,canPublishData:false}));
 await caller.connect(grant.serverUrl,grant.participantToken);
 source=new AudioSource(24000,1);
 const options=new TrackPublishOptions();options.source=TrackSource.SOURCE_MICROPHONE;
 await caller.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack('synthetic microphone',source),options);
 const remote=await received;reader=new AudioStream(remote,24000,1).getReader();
 let frames=0,samples=0,peak=0;
 const consume=(async()=>{while(frames<20){const result=await reader.read();if(result.done)break;frames++;for(const v of result.value.data){samples++;peak=Math.max(peak,Math.abs(v));}}})();
 for(let n=0;n<20;n++){const pcm=new Int16Array(2400);for(let i=0;i<pcm.length;i++)pcm[i]=Math.round(4000*Math.sin(2*Math.PI*440*(n*2400+i)/24000));await source.captureFrame(new AudioFrame(pcm,24000,1,2400));}
 await source.waitForPlayout();await consume;
 if(!frames||!samples||!peak)throw new Error('Synthetic audio not received');
 await deleteLivekitRoom(env,media.room);
 return {roomAndDispatch:true,microphonePublished:true,frames,samples,nonzeroAudio:peak>0,providerCalls:0,physicalMicrophone:false};
}
let result,failed=false;
try{result=await Promise.race([smoke(),deadline]);}
catch{failed=true;console.error('Local RTC smoke failed; no provider call was made.');}
finally{
 clearTimeout(timer);void reader?.cancel().catch(()=>{});
 for(const room of rooms)await Promise.race([room.disconnect(),new Promise(resolve=>setTimeout(resolve,2000))]);
 await source?.close();
 if(container){
  const owner=execFileSync(docker,['inspect','--format','{{index .Config.Labels "'+label+'"}}',container],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  if(owner!==run)throw new Error('Container ownership mismatch');
  execFileSync(docker,['stop','--time','3',container],{stdio:'ignore',timeout:7000});
 }
}
if(result)console.log(JSON.stringify({...result,ownedContainerRemoved:true}));
await dispose();
process.exitCode=failed?1:0;
