/** External SFU-only proof. No agent dispatch, provider inference or microphone. */
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {AccessToken,RoomServiceClient} from 'livekit-server-sdk';
import {Room,RoomEvent,AudioSource,AudioFrame,AudioStream,LocalAudioTrack,TrackPublishOptions,TrackSource,IceTransportType,ContinualGatheringPolicy,dispose} from '@livekit/rtc-node';
const environment=process.env.OPENFON_SMOKE_ENV;
if(!['staging','production'].includes(environment))throw new Error('Select staging or production');
const credentialPath=process.env.OPENFON_SMOKE_CREDENTIALS;
if(!credentialPath)throw new Error('Restricted credentials path required');
const credentials=JSON.parse(await readFile(credentialPath,'utf8'));
const origin=environment==='staging'?'https://voice-staging.openfon.ai':'https://voice.openfon.ai';
const service=new RoomServiceClient(origin,credentials.LIVEKIT_API_KEY,credentials.LIVEKIT_API_SECRET);
const relay=process.env.OPENFON_SMOKE_RELAY_ONLY==='1';
const roomName='infra-smoke-'+randomUUID(),rooms=[];
let source,reader,timer;
const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('External RTC deadline')),45000);});
async function token(identity,publish){const token=new AccessToken(credentials.LIVEKIT_API_KEY,credentials.LIVEKIT_API_SECRET,{identity,ttl:120});token.addGrant({roomJoin:true,room:roomName,canPublish:publish,canSubscribe:!publish,canPublishData:false,...(publish?{canPublishSources:[TrackSource.SOURCE_MICROPHONE]}:{})});return token.toJwt();}
async function smoke(){
 await service.createRoom({name:roomName,emptyTimeout:60,maxParticipants:2});
 const observer=new Room(),caller=new Room();rooms.push(observer,caller);
 const received=new Promise(resolve=>observer.on(RoomEvent.TrackSubscribed,track=>resolve(track)));
 const config=relay?{rtcConfig:{iceTransportType:IceTransportType.TRANSPORT_RELAY,continualGatheringPolicy:ContinualGatheringPolicy.GATHER_CONTINUALLY,iceServers:[]}}:{};
 await observer.connect(origin.replace('https:','wss:'),await token('observer',false),config);
 await caller.connect(origin.replace('https:','wss:'),await token('synthetic-microphone',true),config);
 source=new AudioSource(24000,1);const options=new TrackPublishOptions();options.source=TrackSource.SOURCE_MICROPHONE;
 await caller.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack('synthetic tone',source),options);
 reader=new AudioStream(await received,24000,1).getReader();let frames=0,samples=0,peak=0;
 const consume=(async()=>{while(frames<50){const result=await reader.read();if(result.done)break;frames++;for(const v of result.value.data){samples++;peak=Math.max(peak,Math.abs(v));}}})();
 for(let n=0;n<20;n++){const pcm=new Int16Array(2400);for(let i=0;i<pcm.length;i++)pcm[i]=Math.round(4000*Math.sin(2*Math.PI*440*(n*2400+i)/24000));await source.captureFrame(new AudioFrame(pcm,24000,1,2400));}
 await source.waitForPlayout();await consume;
 if(!frames||!peak)throw new Error('No nonzero external audio received');
 return {environment,relayOnly:relay,frames,samples,nonzeroAudio:true,providerCalls:0,physicalMicrophone:false};
}
let result,failed=false;
try{result=await Promise.race([smoke(),deadline]);}catch(error){failed=true;console.error(JSON.stringify({environment,relayOnly:relay,error:error instanceof Error?error.name:'Error',message:'External RTC validation failed; inspect sanitized host diagnostics'}));}
finally{clearTimeout(timer);void reader?.cancel().catch(()=>{});for(const room of rooms)await Promise.race([room.disconnect(),new Promise(r=>setTimeout(r,2000))]);await source?.close();try{await service.deleteRoom(roomName);}catch{failed=true;console.error('Owned test-room cleanup failed');}await dispose();}
if(result)console.log(JSON.stringify({...result,ownedRoomRemoved:!failed}));
process.exitCode=failed?1:0;
