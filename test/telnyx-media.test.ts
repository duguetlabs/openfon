import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelnyxMediaAdapter, createTelnyxMediaBridge } from '../src/telnyx-media';
import { encodePcmuFrame, Pcmu8ToPcm24 } from '../src/telephony-audio';
const identity = { callControlId: 'control', callSessionId: 'session', callLegId: 'leg', authToken: 'opaque-secret' };
const connected = { event: 'connected', version: '1.0.0', connected: { 'x-telnyx-streaming-auth-token': identity.authToken } };
const start = { event: 'start', stream_id: 'stream', sequence_number: '1', start: { call_control_id: 'control', call_session_id: 'session', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } };
const payload = encodePcmuFrame(new Uint8Array(160).fill(255));
const media = (chunk = 1, overrides = {}) => ({ event: 'media', stream_id: 'stream', sequence_number: String(chunk + 1), media: { chunk: String(chunk), timestamp: String((chunk - 1) * 20), track: 'inbound', payload, ...overrides } });
const ready = { type: 'ready', mode: 'realtime', ttsMode: 'browser', greeting: '' };
const pcm = (frames = 1) => new ArrayBuffer(frames * 960);
const mark = (name: string) => ({ event: 'mark', stream_id: 'stream', mark: { name } });
function fixture(onStart?: () => Promise<void> | void) {
  const carrier: Array<Record<string, any>> = [];
  const session: Array<string | ArrayBuffer> = [];
  const onEnd = vi.fn();
  const adapter = new TelnyxMediaAdapter({ expected: identity, carrierSend: raw => carrier.push(JSON.parse(raw)), sessionSend: raw => session.push(raw), onStart, onEnd });
  const receive = (msg: unknown) => adapter.carrierMessage(JSON.stringify(msg));
  const server = (msg: unknown) => adapter.sessionMessage(msg instanceof ArrayBuffer ? msg : JSON.stringify(msg));
  const boot = async () => { await receive(connected); await receive(start); server(ready); };
  return { adapter, carrier, session, onEnd, receive, server, boot };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Telnyx media bridge', () => {
  it('authenticates connected/start before session start and buffers only validated pre-ready input', async () => {
    let release!: () => void;
    const f = fixture(() => new Promise<void>(resolve => { release = resolve; }));
    await f.receive(connected);
    const starting = f.receive(start);
    await f.receive(media());
    expect(f.session).toEqual([]);
    release(); await starting;
    expect(f.session).toEqual(['{"type":"start"}']);
    f.server(ready);
    expect(f.session[1]).toEqual(new ArrayBuffer(960));
    expect(f.carrier).toEqual([]);
  });

  it('retains only the latest second while a provider handshake receives continuous carrier audio', async () => {
    const f = fixture();
    await f.receive(connected);
    await f.receive(start);
    for (let chunk = 1; chunk <= 150; chunk++) {
      await f.receive(media(chunk));
      vi.advanceTimersByTime(20);
    }
    expect(f.onEnd).not.toHaveBeenCalled();
    expect(f.session).toEqual(['{"type":"start"}']);
    f.server(ready);
    const buffered = f.session.filter((value): value is ArrayBuffer => value instanceof ArrayBuffer);
    expect(buffered.reduce((bytes, frame) => bytes + frame.byteLength, 0)).toBe(48000);
    await f.receive(media(151));
    expect(f.session.at(-1)).toEqual(new ArrayBuffer(960));
    expect(f.onEnd).not.toHaveBeenCalled();
    f.adapter.close();
  });

  it.each([
    { ...connected, version: '9.0' },
    { ...connected, connected: { 'x-telnyx-streaming-auth-token': 'wrong' } },
    { ...connected, connected: undefined },
  ])('rejects invalid connected envelope without starting a session', async bad => {
    const f = fixture(); await f.receive(bad);
    expect(f.onEnd).toHaveBeenCalledTimes(1);
    expect(f.session).not.toContain('{"type":"start"}');
  });

  it('rejects pre-start audio, mismatched identity, unsupported format, and duplicate starts', async () => {
    const cases = [media(), { ...start, start: { ...start.start, call_control_id: 'other' } },
      { ...start, start: { ...start.start, call_session_id: 'other' } },
      { ...start, start: { ...start.start, media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 } } },
      { ...start, start: { ...start.start, media_format: { encoding: 'PCMU', sample_rate: 24000, channels: 2 } } }];
    for (const bad of cases) { const f = fixture(); await f.receive(connected); await f.receive(bad); expect(f.onEnd).toHaveBeenCalledTimes(1); }
    const f = fixture(); await f.boot(); await f.receive(start); expect(f.onEnd).toHaveBeenCalledTimes(1);
  });

  it('reorders chunks, ignores duplicates and skips missing packets after bounded delay', async () => {
    const f = fixture(); await f.boot();
    await f.receive(media(2)); expect(f.session).toHaveLength(1);
    await f.receive(media(1)); expect(f.session).toHaveLength(3);
    await f.receive(media(1)); expect(f.session).toHaveLength(3);
    await f.receive(media(4)); vi.advanceTimersByTime(99); expect(f.session).toHaveLength(3);
    vi.advanceTimersByTime(1); expect(f.session).toHaveLength(4);
    await f.receive(media(3)); expect(f.session).toHaveLength(4);
    expect(f.onEnd).not.toHaveBeenCalled();
  });

  it('keeps actual PCM order across reordered non-silent carrier chunks', async () => {
    const f = fixture(); await f.boot();
    const a = encodePcmuFrame(new Uint8Array(160).fill(191));
    const b = encodePcmuFrame(new Uint8Array(160).fill(63));
    await f.receive(media(2, { payload: b })); await f.receive(media(1, { payload: a }));
    const reference = new Pcmu8ToPcm24();
    expect(f.session.slice(1)).toEqual([reference.push(a).buffer, reference.push(b).buffer]);
  });

  it('rejects malformed/bounded frame, sequence and queue violations', async () => {
    for (const bad of [media(12), media(1, { payload: 'AB==' }), media(1, { chunk: '-1' }),
      media(1, { timestamp: 'NaN' }), media(1, { track: 'outbound' }), { ...media(), stream_id: 'other' }]) {
      const f = fixture(); await f.boot(); await f.receive(bad); expect(f.onEnd).toHaveBeenCalledTimes(1);
    }
    for (const raw of ['{', ' '.repeat(8193), new ArrayBuffer(10), '[]']) {
      const f = fixture(); await f.adapter.carrierMessage(raw); expect(f.onEnd).toHaveBeenCalledTimes(1);
    }
    const f = fixture(); await f.boot();
    f.server(pcm(500)); f.server(pcm(2));
    expect(f.onEnd).toHaveBeenCalledTimes(1);
  });

  it('paces playback at 20ms without leaking session transcripts or other controls', async () => {
    const f = fixture(); await f.boot();
    for (const type of ['transcript', 'agent_text', 'tool', 'speaking']) f.server({ type, text: 'private content' });
    f.server(pcm(3)); expect(f.carrier).toEqual([]);
    vi.advanceTimersByTime(19); expect(f.carrier).toEqual([]);
    vi.advanceTimersByTime(1); expect(f.carrier.map(x => x.event)).toEqual(['media', 'mark']);
    vi.advanceTimersByTime(40); expect(f.carrier.filter(x => x.event === 'media')).toHaveLength(3);
    expect(JSON.stringify(f.carrier)).not.toContain('private content');
  });

  it('clear discards queued/partial audio and stale marks cannot complete a new generation', async () => {
    const f = fixture(); await f.boot(); f.server(pcm(3)); vi.advanceTimersByTime(20);
    const oldMark = f.carrier[1].mark.name;
    f.server({ type: 'flush' }); expect(f.carrier.at(-1)).toEqual({ event: 'clear' });
    f.server(pcm()); f.server({ type: 'ending' }); vi.advanceTimersByTime(240);
    await f.receive(mark(oldMark)); expect(f.onEnd).not.toHaveBeenCalled();
    const currentMarks = f.carrier.filter(x => x.event === 'mark' && x.mark.name !== oldMark);
    for (const item of currentMarks) await f.receive(mark(item.mark.name));
    expect(f.onEnd).toHaveBeenCalledWith('playback_complete');
    expect(f.session.at(-1)).toBe('{"type":"hangup"}');
  });

  it('times out missing playback acknowledgements and bounds queued output', async () => {
    const f = fixture(); await f.boot(); f.server(pcm()); f.server({ type: 'ending' }); vi.advanceTimersByTime(12000);
    expect(f.onEnd).toHaveBeenCalledWith('drain_timeout');
    const g = fixture(); await g.boot(); g.server(pcm(500)); g.server(pcm());
    expect(g.onEnd).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20000); expect(g.onEnd).toHaveBeenCalledTimes(1); expect(g.carrier).toEqual([]);
  });

  it('handles session/transport/start failures once and cancels pending work', async () => {
    const f = fixture(() => Promise.reject(new Error('secret upstream response')));
    await f.receive(connected); await f.receive(start); expect(f.onEnd).toHaveBeenCalledWith('invalid_carrier_frame');
    const g = fixture(); vi.advanceTimersByTime(10000); expect(g.onEnd).toHaveBeenCalledWith('start_timeout');
    const h = fixture(); await h.boot(); h.server({ ...ready, mode: 'pipeline' });
    expect(h.onEnd).toHaveBeenCalledTimes(1);
    h.adapter.close(); h.server(pcm()); await h.receive(media()); vi.advanceTimersByTime(20000);
    expect(h.onEnd).toHaveBeenCalledTimes(1);
  });

  it('distinguishes session failure from normal completion', async () => {
    const f = fixture(); await f.boot(); f.server({type:'error',message:'private failure'});
    expect(f.onEnd).toHaveBeenCalledWith('session_error');
  });

  it('socket wrapper forwards close once and removes all owned listeners', async () => {
    class Socket extends EventTarget {
      binaryType = 'blob';
      readyState = 1; bufferedAmount = 0; sent: unknown[] = [];
      send(data: unknown) { this.sent.push(data); }
      close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    }
    const carrier = new Socket(); const session = new Socket(); const onEnded = vi.fn();
    const bridge = createTelnyxMediaBridge({ carrier: carrier as unknown as WebSocket, session: session as unknown as WebSocket, callId: 'call', callControlId: 'control', callSessionId: 'session', callLegId: 'leg', streamToken: identity.authToken, onEnded });
    expect(session.binaryType).toBe('arraybuffer');
    carrier.close(); bridge.close();
    carrier.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(connected) }));
    vi.advanceTimersByTime(20000);
    expect(onEnded).toHaveBeenCalledTimes(1); expect(session.readyState).toBe(3);
  });
});
