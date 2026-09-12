import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceCall } from '../web/src/voice';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('browser voice connection', () => {
  it('releases a microphone granted after hangup without opening a socket', async () => {
    let grant!: (value: unknown) => void;
    const permission = new Promise(resolve => { grant = resolve; });
    const stop = vi.fn();
    const Socket = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => permission } });
    vi.stubGlobal('speechSynthesis', { cancel: vi.fn() });
    vi.stubGlobal('WebSocket', Socket);
    const voice = new VoiceCall();
    const connecting = voice.connect('private-test-reservation');
    voice.hangup();
    grant({ getTracks: () => [{ stop }] });
    await connecting;
    expect(stop).toHaveBeenCalledOnce();
    expect(Socket).not.toHaveBeenCalled();
  });

  it('connects an authenticated reservation without creating a public call', async () => {
    const fetch = vi.fn();
    const Socket = vi.fn(function () { return {}; });
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.reject(new Error('denied')) } });
    vi.stubGlobal('location', { protocol: 'https:', host: 'example.com' });
    vi.stubGlobal('WebSocket', Socket);
    await new VoiceCall().connect('private-test-reservation');
    expect(fetch).not.toHaveBeenCalled();
    expect(Socket).toHaveBeenCalledWith('wss://example.com/ws/call/private-test-reservation');
  });
});

class TestSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
}

function prepareConnection() {
  const stop = vi.fn();
  const socket = new TestSocket();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
  vi.stubGlobal('location', { protocol: 'https:', host: 'example.com' });
  vi.stubGlobal('speechSynthesis', { cancel: vi.fn() });
  vi.stubGlobal('WebSocket', Object.assign(vi.fn(function () { return socket; }), { OPEN: 1 }));
  return { stop, socket };
}

describe('browser voice resource lifetime', () => {
  it('releases the microphone when socket construction throws', async () => {
    const { stop } = prepareConnection();
    vi.stubGlobal('WebSocket', vi.fn(function () { throw new Error('blocked'); }));
    const voice = new VoiceCall();
    await expect(voice.connect('test')).rejects.toThrow('blocked');
    expect(stop).toHaveBeenCalledOnce();
    expect(voice.hasMic).toBe(false);
    expect(voice.ended).toBe(true);
  });

  it.each(['transport', 'server'])('closes mic and socket on a terminal %s error', async (kind) => {
    const { stop, socket } = prepareConnection();
    const voice = new VoiceCall();
    const events: string[] = [];
    voice.on(event => { if (event.type === 'status') events.push(event.status); });
    await voice.connect('test');
    if (kind === 'transport') socket.onerror!();
    else socket.onmessage!({ data: JSON.stringify({ type: 'error', message: 'Provider unavailable' }) });
    expect(events).toContain('error');
    expect(stop).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(voice.hasMic).toBe(false);
  });

  it('releases microphone resources when browser audio initialization fails', async () => {
    const { socket, stop } = prepareConnection();
    vi.stubGlobal('AudioContext', vi.fn(function () { throw new Error('audio unavailable'); }));
    const voice = new VoiceCall();
    await voice.connect('test');
    socket.onmessage!({ data: JSON.stringify({ type: 'ready', mode: 'realtime' }) });
    expect(stop).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(voice.ended).toBe(true);
  });

  it('ignores already queued socket callbacks after hangup', async () => {
    const { socket } = prepareConnection();
    const audioContext = vi.fn();
    vi.stubGlobal('AudioContext', audioContext);
    const voice = new VoiceCall();
    const listener = vi.fn();
    voice.on(listener);
    await voice.connect('test');
    const lateMessage = socket.onmessage!;
    const lateOpen = socket.onopen!;
    voice.hangup();
    listener.mockClear();
    socket.send.mockClear();
    lateOpen();
    lateMessage({ data: JSON.stringify({ type: 'ready', mode: 'realtime' }) });
    lateMessage({ data: new ArrayBuffer(10) });
    expect(audioContext).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(socket.onmessage).toBeNull();
  });

  it('releases the active audio URL when hanging up before playback ends', async () => {
    const { socket } = prepareConnection();
    const pause = vi.fn();
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: revoke });
    vi.stubGlobal('Audio', vi.fn(function () { return { play: async () => {}, pause, onended: null, onerror: null }; }));
    const voice = new VoiceCall();
    await voice.connect('test');
    socket.onmessage!({ data: new ArrayBuffer(10) });
    voice.hangup();
    voice.hangup();
    expect(pause).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:test');
  });

  it('does not prompt for a microphone on a call already cancelled', async () => {
    prepareConnection();
    const getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const voice = new VoiceCall();
    voice.hangup();
    await voice.connect('cancelled-reservation');
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});


describe('browser goodbye playback failure', () => {
  it.each(['reject', 'ended', 'error'])('releases mic and socket after ending followed by playback %s', async failure => {
    vi.useFakeTimers();
    const { socket, stop } = prepareConnection();
    let reject!: (error: Error) => void;
    const playback = new Promise<void>((_, rejectPromise) => { reject = rejectPromise; });
    const audio = { play: () => playback, pause: vi.fn(), onended: null as (() => void)|null, onerror: null as (() => void)|null };
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:goodbye', revokeObjectURL: revoke });
    vi.stubGlobal('Audio', vi.fn(function () { return audio; }));
    const voice = new VoiceCall(); await voice.connect('test');
    socket.onmessage!({ data: new ArrayBuffer(4) });
    socket.onmessage!({ data: JSON.stringify({type:'ending'}) });
    if (failure === 'reject') reject(new Error('Autoplay blocked'));
    else if (failure === 'ended') audio.onended!();
    else audio.onerror!();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(599); expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stop).toHaveBeenCalledOnce(); expect(socket.close).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:goodbye'); expect(voice.ended).toBe(true);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({type:'hangup'}));
  });
  it('ignores a stale rejected player while a replacement is playing', async () => {
    vi.useFakeTimers();
    const { socket, stop } = prepareConnection(); let reject!: (error: Error) => void;
    let index = 0;
    vi.stubGlobal('URL', { createObjectURL: () => `blob:${++index}`, revokeObjectURL: vi.fn() });
    const first = new Promise<void>((_, rejectPromise) => { reject = rejectPromise; });
    let players = 0;
    vi.stubGlobal('Audio', vi.fn(function () { return { play: () => ++players === 1 ? first : Promise.resolve(), pause: vi.fn(), onended:null,onerror:null }; }));
    const voice = new VoiceCall(); await voice.connect('test');
    socket.onmessage!({data:new ArrayBuffer(4)}); socket.onmessage!({data:new ArrayBuffer(4)});
    socket.onmessage!({data:JSON.stringify({type:'ending'})}); reject(new Error('Old player rejected'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(stop).not.toHaveBeenCalled(); expect(voice.ended).toBe(false); voice.hangup();
  });
});
