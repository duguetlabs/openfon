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
    expect(commands().slice(-2).map(x=>x.command)).toEqual(['FLUSH_MEDIA','MARK_MEDIA']);expect(end).not.toHaveBeenCalled();
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
  for(const paused of [true,false])it(`defers maximum-frame FIR tail until marks free capacity (XOFF=${paused})`,()=>{
    begin();if(paused)adapter.carrierMessage(JSON.stringify({event:'MEDIA_XOFF'}));
    adapter.sessionMessage(new ArrayBuffer(480000));adapter.sessionMessage(JSON.stringify({type:'ending'}));
    vi.advanceTimersByTime(300);
    expect(end).not.toHaveBeenCalled();
    if(paused){expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(0);adapter.carrierMessage(JSON.stringify({event:'MEDIA_XON'}));}
    vi.advanceTimersByTime(2200);
    expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(500);
    expect(end).not.toHaveBeenCalled();
    const marks=commands().filter(x=>x.command==='MARK_MEDIA');
    const acknowledge=(mark:typeof marks[number])=>adapter.carrierMessage(JSON.stringify({event:'MEDIA_MARK_PROCESSED',correlation_id:mark.correlation_id}));
    acknowledge(marks[0]);vi.advanceTimersByTime(20);
    expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(500);
    acknowledge(marks[1]);vi.advanceTimersByTime(20);
    expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(501);
    for(const mark of marks.slice(2))acknowledge(mark);
    expect(end).not.toHaveBeenCalled();
    acknowledge(commands().filter(x=>x.command==='MARK_MEDIA').at(-1));
    expect(end).toHaveBeenCalledExactlyOnceWith('playback_complete');expect(vi.getTimerCount()).toBe(0);
  });
  it('flush discards a deferred full-queue tail and keeps XOFF for the new generation',()=>{
    begin();adapter.carrierMessage(JSON.stringify({event:'MEDIA_XOFF'}));adapter.sessionMessage(new ArrayBuffer(480000));
    adapter.sessionMessage(JSON.stringify({type:'ending'}));vi.advanceTimersByTime(300);
    adapter.sessionMessage(JSON.stringify({type:'flush'}));adapter.sessionMessage(new ArrayBuffer(960));vi.advanceTimersByTime(300);
    expect(end).not.toHaveBeenCalled();expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(0);
    adapter.carrierMessage(JSON.stringify({event:'MEDIA_XON'}));vi.advanceTimersByTime(20);
    const marks=commands().filter(x=>x.command==='MARK_MEDIA');expect(marks).toHaveLength(3); // flush barrier + two PCM marks
    for(const mark of marks){expect(mark.correlation_id).toMatch(/^1:/);adapter.carrierMessage(JSON.stringify({event:'MEDIA_MARK_PROCESSED',correlation_id:mark.correlation_id}));}
    expect(end).toHaveBeenCalledExactlyOnceWith('playback_complete');expect(vi.getTimerCount()).toBe(0);
  });
  it('deferred tail still times out when XOFF never resumes',()=>{
    begin();adapter.carrierMessage(JSON.stringify({event:'MEDIA_XOFF'}));adapter.sessionMessage(new ArrayBuffer(480000));
    adapter.sessionMessage(JSON.stringify({type:'ending'}));vi.advanceTimersByTime(12000);
    expect(end).toHaveBeenCalledExactlyOnceWith('drain_timeout');expect(vi.getTimerCount()).toBe(0);
    adapter.carrierMessage(JSON.stringify({event:'MEDIA_XON'}));expect(carrier.filter(x=>x instanceof ArrayBuffer)).toHaveLength(0);
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
    expect(current).toHaveLength(3);expect(end).not.toHaveBeenCalled(); // flush barrier + two PCM marks
    for(const mark of current)adapter.carrierMessage(JSON.stringify({event:'MEDIA_MARK_PROCESSED',correlation_id:mark.correlation_id}));
    expect(end).toHaveBeenCalledExactlyOnceWith('playback_complete');expect(vi.getTimerCount()).toBe(0);
  });

  it('notifies connection only after valid MEDIA_START and realtime ready',()=>{
    adapter.close();end.mockClear();const onReady=vi.fn();
    adapter=new AsteriskMediaAdapter({carrierSend:()=>{},sessionSend:()=>{},onReady,onEnd:end});
    adapter.carrierMessage(JSON.stringify(start));expect(onReady).not.toHaveBeenCalled();
    adapter.sessionMessage(JSON.stringify(ready));expect(onReady).toHaveBeenCalledTimes(1);
    adapter.sessionMessage(JSON.stringify(ready));expect(onReady).toHaveBeenCalledTimes(1);expect(end).toHaveBeenCalled();
  });
  it('invalid MEDIA_START and startup timeout never notify connection',()=>{
    for(const invalid of [true,false]){
      adapter.close();const onReady=vi.fn();adapter=new AsteriskMediaAdapter({carrierSend:()=>{},sessionSend:()=>{},onReady,onEnd:end});
      if(invalid)adapter.carrierMessage(JSON.stringify({...start,format:'slin16'}));else vi.advanceTimersByTime(20000);
      adapter.sessionMessage(JSON.stringify(ready));expect(onReady).not.toHaveBeenCalled();
    }
  });

});

describe('Asterisk internal audio receipts', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  function fixture() {
    const carrier: (string | ArrayBuffer)[] = [], session: (string | ArrayBuffer)[] = [];
    const end = vi.fn();
    const adapter = new AsteriskMediaAdapter({ carrierSend: value => carrier.push(value), sessionSend: value => session.push(value), onEnd: end });
    adapter.carrierMessage(JSON.stringify(start)); adapter.sessionMessage(JSON.stringify(ready));
    const marker = (bytes: number) => adapter.sessionMessage(JSON.stringify({ type: 'audio_receipt', id, bytes }));
    const receipts = () => session.filter(x => typeof x === 'string').map(x => JSON.parse(x as string)).filter(x => x.type === 'audio_received');
    return { adapter, carrier, end, marker, receipts };
  }
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('negative control: acknowledges admitted PCM privately while retaining carrier marks', () => {
    const f = fixture(); f.adapter.sessionMessage(new ArrayBuffer(960)); f.marker(960);
    expect(f.receipts()).toEqual([{ type: 'audio_received', id }]);
    vi.advanceTimersByTime(20);
    expect(f.carrier.some(x => typeof x === 'string' && JSON.parse(x).command === 'MARK_MEDIA')).toBe(true);
    expect(JSON.stringify(f.carrier)).not.toContain(id);
    expect(f.end).not.toHaveBeenCalled(); f.adapter.close();
  });
  it('XOFF cannot turn receipts into unbounded downstream playback', () => {
    const f = fixture(); f.adapter.carrierMessage(JSON.stringify({ event: 'MEDIA_XOFF' }));
    f.adapter.sessionMessage(new ArrayBuffer(480000)); f.marker(480000);
    f.adapter.sessionMessage(new ArrayBuffer(480000)); f.marker(480000);
    expect(f.receipts()).toHaveLength(1); expect(f.end).toHaveBeenCalledOnce();
  });
  it.each(['no-frame', 'wrong-size', 'duplicate'])('rejects a %s receipt', how => {
    const f = fixture();
    if (how !== 'no-frame') f.adapter.sessionMessage(new ArrayBuffer(960));
    if (how === 'duplicate') f.marker(960);
    f.marker(how === 'wrong-size' ? 2 : 960);
    expect(f.end).toHaveBeenCalledOnce();
  });
});

describe('Asterisk flush transport debt', () => {
  function fixture() {
    const carrier: (string | ArrayBuffer)[] = [], end = vi.fn();
    const adapter = new AsteriskMediaAdapter({ carrierSend: x => carrier.push(x), sessionSend: () => {}, onEnd: end });
    adapter.carrierMessage(JSON.stringify(start)); adapter.sessionMessage(JSON.stringify(ready));
    const flush = () => adapter.sessionMessage(JSON.stringify({ type: 'flush' }));
    const marks = () => carrier.filter(x => typeof x === 'string').map(x => JSON.parse(x as string)).filter(x => x.command === 'MARK_MEDIA');
    return { adapter, end, flush, marks };
  }
  beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
  it('negative control: repeated audio, pump and flush without returned marks stays bounded', () => {
    const f = fixture();
    for (let i = 0; i < 510; i++) { f.adapter.sessionMessage(new ArrayBuffer(960)); vi.advanceTimersByTime(20); f.flush(); }
    expect(f.end).toHaveBeenCalledOnce(); expect(f.marks().length).toBeLessThanOrEqual(500);
  });
  it('returned post-flush barriers allow repeated normal interruptions', () => {
    const f = fixture();
    for (let i = 0; i < 510; i++) {
      f.adapter.sessionMessage(new ArrayBuffer(960)); vi.advanceTimersByTime(20); f.flush();
      f.adapter.carrierMessage(JSON.stringify({ event: 'MEDIA_MARK_PROCESSED', correlation_id: f.marks().at(-1).correlation_id }));
    }
    expect(f.end).not.toHaveBeenCalled(); f.adapter.close();
  });
  it.each(['binary', 'flush'])('rejects %s between negotiated audio and marker', kind => {
    const end = vi.fn();
    const adapter = new AsteriskMediaAdapter({ carrierSend: () => {}, sessionSend: () => {}, onEnd: end });
    adapter.carrierMessage(JSON.stringify(start)); adapter.sessionMessage(JSON.stringify({ ...ready, audioReceipts: true }));
    adapter.sessionMessage(new ArrayBuffer(960));
    adapter.sessionMessage(kind === 'binary' ? new ArrayBuffer(960) : JSON.stringify({ type: 'flush' }));
    expect(end).toHaveBeenCalledOnce();
  });
});
