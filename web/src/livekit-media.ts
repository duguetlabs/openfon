import { Room, RoomEvent, Track } from 'livekit-client';

/** Audio transport only. The released receptionist components remain unchanged. */
export class LivekitMedia {
  private room=new Room({adaptiveStream:true,dynacast:true});
  private closed=false;
  private active=false;
  private levelTimer:ReturnType<typeof setInterval>|undefined;
  private elements=new Set<HTMLMediaElement>();
  constructor(private status:(value:'connecting'|'live'|'ended')=>void,private blocked:(value:boolean)=>void,private speaking:(who:'caller'|'agent'|'none')=>void,private level:(value:number)=>void) {
    this.room.on(RoomEvent.TrackSubscribed,(track)=>{
      if(this.closed||track.kind!==Track.Kind.Audio)return;
      const audio=track.attach(); audio.style.display='none';document.body.append(audio);this.elements.add(audio);
    });
    this.room.on(RoomEvent.TrackUnsubscribed,track=>{for(const element of track.detach()){element.remove();this.elements.delete(element);}});
    this.room.on(RoomEvent.AudioPlaybackStatusChanged,()=>{if(!this.closed)this.blocked(!this.room.canPlaybackAudio);});
    this.room.on(RoomEvent.Reconnecting,()=>{if(!this.closed){this.active=false;this.speaking('none');this.level(0);this.status('connecting');}});
    this.room.on(RoomEvent.Reconnected,()=>{if(!this.closed){this.active=true;this.status('live');}});
    this.room.on(RoomEvent.ActiveSpeakersChanged,speakers=>{if(!this.closed&&this.active)this.speaking(speakers.some(p=>p.isLocal)?'caller':speakers.length?'agent':'none');});
    this.room.on(RoomEvent.Disconnected,()=>{if(!this.closed){this.close();this.status('ended');}});
  }
  async connect(url:string,token:string,stream:MediaStream|null){
    const endpoint=new URL(url);
    if(!['wss:','ws:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('Invalid call address');
    if(endpoint.protocol==='ws:'&&!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname))throw new Error('Secure call address required');
    const track=stream?.getAudioTracks()[0];
    await this.room.connect(url,token);
    if(this.closed){await this.room.disconnect();return;}
    try{await this.room.startAudio();}catch{if(!this.closed)this.blocked(true);}
    if(this.closed){await this.room.disconnect();return;}
    if(track)await this.room.localParticipant.publishTrack(track,{source:Track.Source.Microphone});
    if(this.closed){track?.stop();await this.room.disconnect();return;}
    this.active=true;
    this.levelTimer=setInterval(()=>{if(!this.closed&&this.active)this.level(Math.max(this.room.localParticipant.audioLevel,...this.room.activeSpeakers.map(p=>p.audioLevel)));},100);
    this.status('live');
  }
  resume(){if(this.closed)return;void this.room.startAudio().catch(()=>{if(!this.closed)this.blocked(true);});}
  close(){
    if(this.closed)return;this.closed=true;this.active=false;clearInterval(this.levelTimer);this.speaking('none');this.level(0);
    void this.room.disconnect().catch(()=>{});
    for(const element of this.elements)element.remove();this.elements.clear();
  }
}
