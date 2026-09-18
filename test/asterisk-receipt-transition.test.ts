import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsteriskMediaAdapter } from '../src/asterisk-media';

const start = { event: 'MEDIA_START', connection_id: 'test', channel: 'WebSocket/test', format: 'ulaw', optimal_frame_size: 160, ptime: 20 };
const ready = { type: 'ready', mode: 'realtime', ttsMode: 'server', greeting: '', audioReceipts: true };
const adapters: AsteriskMediaAdapter[] = [];
function fixture() {
  const carrier: (string | ArrayBuffer)[] = [], session: (string | ArrayBuffer)[] = [];
  const end = vi.fn(), onReady = vi.fn();
  const adapter = new AsteriskMediaAdapter({ carrierSend: x => carrier.push(x), sessionSend: x => session.push(x), onReady, onEnd: end });
  adapters.push(adapter);
  const send = (value: unknown) => adapter.sessionMessage(value instanceof ArrayBuffer ? value : JSON.stringify(value));
  const commands = () => carrier.filter((x): x is string => typeof x === 'string').map(x => JSON.parse(x));
  const receipts = () => session.filter((x): x is string => typeof x === 'string').map(x => JSON.parse(x)).filter(x => x.type === 'audio_received');
  const marker = (control = false) => {
    const id = crypto.randomUUID();
    send(control ? { type: 'control_receipt', id } : { type: 'audio_receipt', id, bytes: 960 });
    return id;
  };
  adapter.carrierMessage(JSON.stringify(start));
  return { adapter, carrier, end, onReady, send, commands, receipts, marker };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.close(); vi.useRealTimers(); });

describe('Asterisk first receipt negotiation after legacy greeting PCM', () => {
  it.each(['audio', 'flush', 'speaking'])('[original-negative] admits %s after unmarked pre-ready PCM and receipt negotiation', kind => {
    const f = fixture();
    f.send(new ArrayBuffer(960));
    f.send(ready);
    f.send(kind === 'audio' ? new ArrayBuffer(960) : { type: kind });
    const id = f.marker(kind !== 'audio');
    expect(f.end).not.toHaveBeenCalled();
    expect(f.onReady).toHaveBeenCalledTimes(1);
    expect(f.receipts()).toEqual([{ type: 'audio_received', id }]);
  });

  it('[original-negative] preserves pre-ready playback marks through negotiation and ending', () => {
    const f = fixture();
    f.send(new ArrayBuffer(960));
    vi.advanceTimersByTime(20);
    const originalMarks = f.commands().filter(x => x.command === 'MARK_MEDIA');
    expect(originalMarks.length).toBeGreaterThan(0);
    f.send(ready);
    f.send({ type: 'ending' });
    vi.advanceTimersByTime(240);
    expect(f.end).not.toHaveBeenCalled();
    const allMarks = f.commands().filter(x => x.command === 'MARK_MEDIA');
    for (const mark of allMarks.filter(x => !originalMarks.some(old => old.correlation_id === x.correlation_id))) {
      f.adapter.carrierMessage(JSON.stringify({ event: 'MEDIA_MARK_PROCESSED', correlation_id: mark.correlation_id }));
    }
    expect(f.end).not.toHaveBeenCalled(); // original playback debt still matters
    for (const mark of originalMarks) f.adapter.carrierMessage(JSON.stringify({ event: 'MEDIA_MARK_PROCESSED', correlation_id: mark.correlation_id }));
    expect(f.end).toHaveBeenCalledExactlyOnceWith('playback_complete');
  });

  it('retains compatibility with an audio marker received before ready', () => {
    const f = fixture();
    f.send(new ArrayBuffer(960)); const first = f.marker();
    f.send(ready);
    f.send(new ArrayBuffer(960)); const second = f.marker();
    expect(f.receipts()).toEqual([{ type: 'audio_received', id: first }, { type: 'audio_received', id: second }]);
    expect(f.end).not.toHaveBeenCalled();
  });

  it('does not retroactively acknowledge legacy PCM after receipt negotiation', () => {
    const f = fixture();
    f.send(new ArrayBuffer(960)); f.send(ready); f.marker();
    expect(f.receipts()).toEqual([]);
    expect(f.end).toHaveBeenCalledExactlyOnceWith('invalid_session_frame');
  });

  it('preserves optional marker behavior when ready does not enable receipts', () => {
    const f = fixture();
    f.send(new ArrayBuffer(960)); f.send({ ...ready, audioReceipts: false });
    const id = f.marker();
    expect(f.receipts()).toEqual([{ type: 'audio_received', id }]);
    expect(f.end).not.toHaveBeenCalled();
  });

  it.each(['audio', 'control'])('repeated ready cannot erase negotiated %s debt or downgrade the protocol', kind => {
    const f = fixture();
    f.send(new ArrayBuffer(960)); f.send(ready);
    f.send(kind === 'audio' ? new ArrayBuffer(960) : { type: 'speaking' });
    expect(f.end).not.toHaveBeenCalled();
    f.send({ ...ready, audioReceipts: false });
    expect(f.end).toHaveBeenCalledExactlyOnceWith('invalid_session_frame');
    expect(f.onReady).toHaveBeenCalledTimes(1);
    expect(f.receipts()).toEqual([]);
  });

  it.each(['audio', 'control'])('requires the first negotiated %s marker before any following payload', kind => {
    const f = fixture();
    f.send(new ArrayBuffer(960)); f.send(ready);
    f.send(kind === 'audio' ? new ArrayBuffer(960) : { type: 'flush' });
    expect(f.end).not.toHaveBeenCalled();
    f.send(new ArrayBuffer(960));
    expect(f.end).toHaveBeenCalledExactlyOnceWith('invalid_session_frame');
    expect(f.receipts()).toEqual([]);
  });

  it('negotiation leaves queued pre-ready PCM within the same playback capacity', () => {
    const f = fixture();
    f.adapter.carrierMessage(JSON.stringify({ event: 'MEDIA_XOFF' }));
    f.send(new ArrayBuffer(480000)); f.send(ready);
    f.send(new ArrayBuffer(480000));
    expect(f.end).toHaveBeenCalledExactlyOnceWith('invalid_session_frame');
    expect(f.carrier.filter(x => x instanceof ArrayBuffer)).toHaveLength(0);
  });

  it('negotiation never frees the pre-ready carrier transport debt', () => {
    const f = fixture();
    f.send(new ArrayBuffer(960)); vi.advanceTimersByTime(20);
    const before = f.commands().filter(x => x.command === 'MARK_MEDIA').length;
    expect(before).toBeGreaterThan(0);
    f.send(ready);
    for (let i = before; i < 500; i++) { f.send({ type: 'flush' }); f.marker(true); }
    expect(f.end).not.toHaveBeenCalled();
    expect(f.commands().filter(x => x.command === 'MARK_MEDIA')).toHaveLength(500);
    f.send({ type: 'flush' });
    expect(f.end).toHaveBeenCalledExactlyOnceWith('invalid_session_frame');
    expect(f.commands().filter(x => x.command === 'MARK_MEDIA')).toHaveLength(500);
  });
});
