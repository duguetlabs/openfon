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
    adapter.carrierMessage(JSON.stringify(start));adapter.sessionMessage(new ArrayBuffer(960));vi.advanceTimersByTime(20);
    expect(carrier.some(x=>x instanceof ArrayBuffer && x.byteLength===160)).toBe(true);
    expect(commands().some(x=>x.command==='MARK_MEDIA')).toBe(true);expect(end).not.toHaveBeenCalled();
  });
  it('flush discards pending audio and ignores old playback acknowledgments',()=>{
    begin();adapter.sessionMessage(new ArrayBuffer(960));vi.advanceTimersByTime(20);const old=commands().find(x=>x.command==='MARK_MEDIA');
    adapter.sessionMessage(JSON.stringify({type:'flush'}));
    adapter.carrierMessage(JSON.stringify({event:'MEDIA_MARK_PROCESSED',correlation_id:old.correlation_id}));
    expect(commands().at(-1).command).toBe('FLUSH_MEDIA');expect(end).not.toHaveBeenCalled();
  });
  it('honors XOFF/XON and caps buffered playback',()=>{
    begin();adapter.carrierMessage(JSON.stringify({event:'MEDIA_XOFF'}));adapter.sessionMessage(new ArrayBuffer(960));
    expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(0);
    adapter.carrierMessage(JSON.stringify({event:'MEDIA_XON'}));vi.advanceTimersByTime(20);expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(1);
    adapter.carrierMessage(JSON.stringify({event:'MEDIA_XOFF'}));adapter.sessionMessage(new ArrayBuffer(480000));
    expect(end).toHaveBeenCalledWith('invalid_session_frame');
  });
  it('waits for final playback mark and hangs up exactly once',()=>{
    begin();adapter.sessionMessage(new ArrayBuffer(960));adapter.sessionMessage(JSON.stringify({type:'ending'}));vi.advanceTimersByTime(220);
    expect(end).not.toHaveBeenCalled();
    for(const mark of commands().filter(x=>x.command==='MARK_MEDIA')) adapter.carrierMessage(JSON.stringify({event:'MEDIA_MARK_PROCESSED',correlation_id:mark.correlation_id}));
    expect(end).toHaveBeenCalledExactlyOnceWith('playback_complete');adapter.close();expect(end).toHaveBeenCalledTimes(1);
  });
  it('bounds missing start and missing playback acknowledgments',()=>{
    vi.advanceTimersByTime(20000);expect(end).toHaveBeenCalledWith('start_timeout');
  });
  it('hangs up when playback acknowledgments never arrive',()=>{
    begin();adapter.sessionMessage(new ArrayBuffer(960));adapter.sessionMessage(JSON.stringify({type:'ending'}));
    vi.advanceTimersByTime(12000);expect(end).toHaveBeenCalledExactlyOnceWith('drain_timeout');
  });
  it('keeps transcripts and tools off the PBX socket',()=>{
    begin();const count=carrier.length;adapter.sessionMessage(JSON.stringify({type:'transcript',text:'private'}));
    expect(carrier).toHaveLength(count);
  });
  it('queues a maximum frame without synchronous writes and yields to XOFF between batches',()=>{
    begin();adapter.sessionMessage(new ArrayBuffer(480000));
    const audioCount=()=>carrier.filter(x=>x instanceof ArrayBuffer).length;
    expect(audioCount()).toBe(0);vi.advanceTimersByTime(20);expect(audioCount()).toBe(5);
    adapter.carrierMessage(JSON.stringify({event:'MEDIA_XOFF'}));vi.advanceTimersByTime(1000);expect(audioCount()).toBe(5);
    adapter.carrierMessage(JSON.stringify({event:'MEDIA_XON'}));expect(audioCount()).toBe(5);
    vi.advanceTimersByTime(20);expect(audioCount()).toBe(10);expect(end).not.toHaveBeenCalled();
  });
  it('flush cancels a scheduled large-frame pump and starts only the new generation',()=>{
    begin();adapter.sessionMessage(new ArrayBuffer(480000));vi.advanceTimersByTime(20);
    const old=commands().filter(x=>x.command==='MARK_MEDIA');
    adapter.sessionMessage(JSON.stringify({type:'flush'}));vi.advanceTimersByTime(100);
    expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(5);
    for(const mark of old)adapter.carrierMessage(JSON.stringify({event:'MEDIA_MARK_PROCESSED',correlation_id:mark.correlation_id}));
    adapter.sessionMessage(new ArrayBuffer(960));vi.advanceTimersByTime(20);
    expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(6);
    expect(commands().at(-1).correlation_id).toMatch(/^1:/);expect(end).not.toHaveBeenCalled();
  });
  it('drains an entire maximum frame incrementally and waits for every final mark',()=>{
    begin();adapter.sessionMessage(new ArrayBuffer(480000));adapter.sessionMessage(JSON.stringify({type:'ending'}));
    const acked=new Set<string>();
    for(let batch=0;batch<110;batch++){
      vi.advanceTimersByTime(20);
      for(const mark of commands().filter(x=>x.command==='MARK_MEDIA' && !acked.has(x.correlation_id))){
        acked.add(mark.correlation_id);adapter.carrierMessage(JSON.stringify({event:'MEDIA_MARK_PROCESSED',correlation_id:mark.correlation_id}));
      }
    }
    expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(501);
    expect(acked.size).toBe(501);expect(end).toHaveBeenCalledExactlyOnceWith('playback_complete');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('close cancels queued playback and ignores later XON',()=>{
    begin();adapter.sessionMessage(new ArrayBuffer(480000));vi.advanceTimersByTime(20);adapter.close();
    const count=carrier.length;adapter.carrierMessage(JSON.stringify({event:'MEDIA_XON'}));vi.advanceTimersByTime(30000);
    expect(carrier).toHaveLength(count);expect(end).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });
  it('asynchronous transport failure closes once and clears all scheduled work',()=>{
    adapter.close();end.mockClear();adapter=new AsteriskMediaAdapter({carrierSend:data=>{if(data instanceof ArrayBuffer)throw Error('disconnected');},sessionSend:()=>{},onEnd:end});
    begin();adapter.sessionMessage(new ArrayBuffer(480000));vi.advanceTimersByTime(20);
    expect(end).toHaveBeenCalledExactlyOnceWith('playback_error');expect(vi.getTimerCount()).toBe(0);
  });

  it('flush preserves XOFF until XON even with new audio and final drain queued',()=>{
    begin();adapter.sessionMessage(new ArrayBuffer(960));vi.advanceTimersByTime(20);
    const old=commands().find(x=>x.command==='MARK_MEDIA');
    adapter.carrierMessage(JSON.stringify({event:'MEDIA_XOFF'}));
    adapter.sessionMessage(JSON.stringify({type:'flush'}));
    adapter.sessionMessage(new ArrayBuffer(960));adapter.sessionMessage(JSON.stringify({type:'ending'}));
    adapter.carrierMessage(JSON.stringify({event:'MEDIA_MARK_PROCESSED',correlation_id:old.correlation_id}));
    vi.advanceTimersByTime(500);
    expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(1);
    expect(end).not.toHaveBeenCalled();
    adapter.carrierMessage(JSON.stringify({event:'MEDIA_XON'}));vi.advanceTimersByTime(20);
    const current=commands().filter(x=>x.command==='MARK_MEDIA' && x.correlation_id.startsWith('1:'));
    expect(current).toHaveLength(2);expect(end).not.toHaveBeenCalled();
    for(const mark of current)adapter.carrierMessage(JSON.stringify({event:'MEDIA_MARK_PROCESSED',correlation_id:mark.correlation_id}));
    expect(end).toHaveBeenCalledExactlyOnceWith('playback_complete');expect(vi.getTimerCount()).toBe(0);
  });

});
