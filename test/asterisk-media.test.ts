import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsteriskMediaAdapter } from '../src/asterisk-media';
const start = {event:'MEDIA_START',connection_id:'test',channel:'WebSocket/test',format:'ulaw',optimal_frame_size:160,ptime:20};
const ready = {type:'ready',mode:'realtime',ttsMode:'realtime',greeting:''};
describe('Asterisk JSON ulaw transport', () => {
  let adapter: AsteriskMediaAdapter;
  let carrier: (string|ArrayBuffer)[];
  let session: (string|ArrayBuffer)[];
  let end: ReturnType<typeof vi.fn>;
  const commands = () => carrier.filter(x=>typeof x==='string').map(x=>JSON.parse(x as string));
  beforeEach(()=>{ vi.useFakeTimers(); carrier=[];session=[];end=vi.fn();adapter=new AsteriskMediaAdapter({carrierSend:x=>carrier.push(x),sessionSend:x=>session.push(x),onEnd:end}); });
  afterEach(()=>{adapter.close();vi.useRealTimers();});
  const begin=()=>{adapter.carrierMessage(JSON.stringify(start));adapter.sessionMessage(JSON.stringify(ready));};
  it('validates codec before answering and starting inference',()=>{
    adapter.carrierMessage(JSON.stringify({...start,format:'slin16'}));
    expect(end).toHaveBeenCalledWith('invalid_carrier_frame');
    expect(commands().some(x=>x.command==='ANSWER')).toBe(false);
    expect(session.some(x=>typeof x==='string' && JSON.parse(x).type==='start')).toBe(false);
  });
  it('drops pre-ready input then converts 20ms ulaw into PCM24',()=>{
    adapter.carrierMessage(JSON.stringify(start));adapter.carrierMessage(new Uint8Array(160).fill(255).buffer);
    expect(session.filter(x=>x instanceof ArrayBuffer)).toHaveLength(0);
    adapter.sessionMessage(JSON.stringify(ready));adapter.carrierMessage(new Uint8Array(160).fill(255).buffer);
    expect((session.at(-1) as ArrayBuffer).byteLength).toBe(960);
    expect(commands()[0].command).toBe('ANSWER');
  });
  it('accepts synthesized greeting audio before ready and emits marks',()=>{
    adapter.carrierMessage(JSON.stringify(start));adapter.sessionMessage(new ArrayBuffer(960));
    expect(carrier.some(x=>x instanceof ArrayBuffer && x.byteLength===160)).toBe(true);
    expect(commands().some(x=>x.command==='MARK_MEDIA')).toBe(true);expect(end).not.toHaveBeenCalled();
  });
  it('flush discards pending audio and ignores old playback acknowledgments',()=>{
    begin();adapter.sessionMessage(new ArrayBuffer(960));const old=commands().find(x=>x.command==='MARK_MEDIA');
    adapter.sessionMessage(JSON.stringify({type:'flush'}));
    adapter.carrierMessage(JSON.stringify({event:'MEDIA_MARK_PROCESSED',correlation_id:old.correlation_id}));
    expect(commands().at(-1).command).toBe('FLUSH_MEDIA');expect(end).not.toHaveBeenCalled();
  });
  it('honors XOFF/XON and caps buffered playback',()=>{
    begin();adapter.carrierMessage(JSON.stringify({event:'MEDIA_XOFF'}));adapter.sessionMessage(new ArrayBuffer(960));
    expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(0);
    adapter.carrierMessage(JSON.stringify({event:'MEDIA_XON'}));expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(1);
    adapter.carrierMessage(JSON.stringify({event:'MEDIA_XOFF'}));adapter.sessionMessage(new ArrayBuffer(480000));
    expect(end).toHaveBeenCalledWith('invalid_session_frame');
  });
  it('waits for final playback mark and hangs up exactly once',()=>{
    begin();adapter.sessionMessage(new ArrayBuffer(960));adapter.sessionMessage(JSON.stringify({type:'ending'}));vi.advanceTimersByTime(200);
    expect(end).not.toHaveBeenCalled();
    for(const mark of commands().filter(x=>x.command==='MARK_MEDIA')) adapter.carrierMessage(JSON.stringify({event:'MEDIA_MARK_PROCESSED',correlation_id:mark.correlation_id}));
    expect(end).toHaveBeenCalledExactlyOnceWith('playback_complete');adapter.close();expect(end).toHaveBeenCalledTimes(1);
  });
  it('bounds missing start and missing playback acknowledgments',()=>{
    vi.advanceTimersByTime(20000);expect(end).toHaveBeenCalledWith('start_timeout');
  });
  it('keeps transcripts and tools off the PBX socket',()=>{
    begin();const count=carrier.length;adapter.sessionMessage(JSON.stringify({type:'transcript',text:'private'}));
    expect(carrier).toHaveLength(count);
  });
});
