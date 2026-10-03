import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const fake=vi.hoisted(()=>({rooms:[] as any[],connect:()=>Promise.resolve(),publish:()=>Promise.resolve()}));
vi.mock('livekit-client',()=>({
 Track:{Kind:{Audio:'audio'},Source:{Microphone:'microphone'}},
 RoomEvent:Object.fromEntries(['TrackSubscribed','TrackUnsubscribed','AudioPlaybackStatusChanged','Reconnecting','Reconnected','ActiveSpeakersChanged','Disconnected','ParticipantConnected','ParticipantDisconnected'].map(x=>[x,x])),
 Room:class {
  remoteParticipants=new Map([['agent',{isAgent:true}]]);
  handlers=new Map<string,Function>();activeSpeakers:any[]=[];canPlaybackAudio=true;
  disconnect=vi.fn(async()=>{});startAudio=vi.fn(async()=>{});
  localParticipant={audioLevel:0.4,publishTrack:vi.fn(()=>fake.publish())};
  constructor(){fake.rooms.push(this);}on(name:string,handler:Function){this.handlers.set(name,handler);return this;}
  connect(){return fake.connect();}emit(name:string,...args:unknown[]){this.handlers.get(name)?.(...args);}
 }
}));
import {LivekitMedia} from '../web/src/livekit-media';
beforeEach(()=>{fake.rooms=[];fake.connect=()=>Promise.resolve();fake.publish=()=>Promise.resolve();vi.useFakeTimers();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
const defer=()=>{let resolve!:()=>void;return {promise:new Promise<void>(r=>resolve=r),resolve:()=>resolve()};};
function setup(){const status=vi.fn(),blocked=vi.fn(),speaking=vi.fn(),level=vi.fn();const media=new LivekitMedia(status,blocked,speaking,level);const track={stop:vi.fn()};const stream={getAudioTracks:()=>[track]} as unknown as MediaStream;return {media,status,blocked,speaking,level,track,stream,room:fake.rooms[0]};}
it('does not publish a late microphone after cancellation during connection',async()=>{
 const gate=defer();fake.connect=()=>gate.promise;const x=setup();const work=x.media.connect('ws://127.0.0.1:7880','fixture',x.stream);x.media.close();gate.resolve();await work;
 expect(x.room.localParticipant.publishTrack).not.toHaveBeenCalled();expect(x.status).not.toHaveBeenCalled();expect(x.room.disconnect).toHaveBeenCalled();
});
it('stops a microphone whose publication resolves after cancellation',async()=>{
 const gate=defer();fake.publish=()=>gate.promise;const x=setup();const work=x.media.connect('ws://127.0.0.1:7880','fixture',x.stream);await vi.advanceTimersByTimeAsync(0);x.media.close();gate.resolve();await work;
 expect(x.track.stop).toHaveBeenCalled();expect(x.status).not.toHaveBeenCalledWith('live');
});
it('speaking/level track genuine room activity and clear during reconnect and shutdown',async()=>{
 const x=setup();await x.media.connect('ws://127.0.0.1:7880','fixture',x.stream);
 x.room.emit('ActiveSpeakersChanged',[{isLocal:false}]);expect(x.speaking).toHaveBeenLastCalledWith('agent');
 x.room.emit('ActiveSpeakersChanged',[]);expect(x.speaking).toHaveBeenLastCalledWith('none');
 await vi.advanceTimersByTimeAsync(100);expect(x.level).toHaveBeenLastCalledWith(0.4);
 x.room.emit('Reconnecting');x.room.emit('ActiveSpeakersChanged',[{isLocal:true}]);await vi.advanceTimersByTimeAsync(200);expect(x.speaking).toHaveBeenLastCalledWith('none');expect(x.level).toHaveBeenLastCalledWith(0);
 x.room.emit('Reconnected');x.room.emit('ActiveSpeakersChanged',[{isLocal:true}]);expect(x.speaking).toHaveBeenLastCalledWith('caller');
 x.media.close();x.room.emit('ActiveSpeakersChanged',[{isLocal:false}]);await vi.advanceTimersByTimeAsync(200);expect(x.speaking).toHaveBeenLastCalledWith('none');expect(x.level).toHaveBeenLastCalledWith(0);expect(vi.getTimerCount()).toBe(0);
});
it('removes attached audio and rejects stale subscription events after close',async()=>{
 const append=vi.fn();vi.stubGlobal('document',{body:{append}});const x=setup();const element={style:{},remove:vi.fn()};const track={kind:'audio',attach:vi.fn(()=>element)};
 x.room.emit('TrackSubscribed',track);expect(append).toHaveBeenCalledWith(element);x.media.close();expect(element.remove).toHaveBeenCalledTimes(1);x.room.emit('TrackSubscribed',track);expect(track.attach).toHaveBeenCalledTimes(1);
});
it('retains a text-only room when microphone permission is unavailable',async()=>{
 const x=setup();await x.media.connect('ws://127.0.0.1:7880','fixture',null);
 expect(x.room.localParticipant.publishTrack).not.toHaveBeenCalled();expect(x.status).toHaveBeenLastCalledWith('live');x.media.close();
});

it('stays connecting while dispatch is pending and ends on permanent agent departure',async()=>{
 const x=setup();x.room.remoteParticipants.clear();
 await x.media.connect('ws://127.0.0.1:7880','fixture',null);
 expect(x.status).toHaveBeenLastCalledWith('connecting');
 x.room.emit('ParticipantConnected',{isAgent:false});expect(x.status).not.toHaveBeenCalledWith('live');
 x.room.emit('ParticipantConnected',{isAgent:true});expect(x.status).toHaveBeenLastCalledWith('live');
 x.room.emit('ParticipantDisconnected',{isAgent:false});expect(x.status).not.toHaveBeenCalledWith('ended');
 x.room.emit('ParticipantDisconnected',{isAgent:true});expect(x.status).toHaveBeenLastCalledWith('ended');
 expect(x.room.disconnect).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 x.room.emit('Reconnected');x.room.emit('ParticipantConnected',{isAgent:true});expect(x.status).toHaveBeenLastCalledWith('ended');
});
