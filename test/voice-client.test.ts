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

describe('browser speech routing and language', () => {
  async function connected(mode: string, greeting = '') {
    const { socket } = prepareConnection();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw Error('no microphone'); } } });
    const german = { name: 'German voice', lang: 'de-DE' };
    const french = { name: 'French voice', lang: 'fr-FR' };
    const speak = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn(), getVoices: () => [{ name: 'English default', lang: 'en-US' }, german, french] });
    vi.stubGlobal('SpeechSynthesisUtterance', class { lang = ''; voice = null; constructor(public text: string) {} });
    const voice = new VoiceCall(); await voice.connect('test');
    socket.onmessage!({ data: JSON.stringify({ type: 'ready', mode, ttsMode: 'browser', language: 'de', greeting }) });
    return { voice, socket, speak, german, french };
  }

  it('does not synthesize realtime transcripts over provider audio', async () => {
    const { voice, socket, speak } = await connected('realtime');
    const listener = vi.fn(); voice.on(listener);
    socket.onmessage!({ data: JSON.stringify({ type: 'agent_text', text: 'Guten Tag!' }) });
    expect(listener).toHaveBeenCalledWith({ type: 'agent_text', text: 'Guten Tag!' });
    expect(speak).not.toHaveBeenCalled();
    voice.hangup();
  });

  it('uses the pipeline greeting language and follows reply language changes', async () => {
    const { voice, socket, speak, german, french } = await connected('pipeline', 'Guten Tag!');
    expect(speak.mock.calls[0][0]).toMatchObject({ text: 'Guten Tag!', lang: 'de', voice: german });
    socket.onmessage!({ data: JSON.stringify({ type: 'agent_text', text: 'Bonjour!', language: 'fr' }) });
    expect(speak.mock.calls[1][0]).toMatchObject({ text: 'Bonjour!', lang: 'fr', voice: french });
    voice.hangup();
  });

  it.each([false, true])('waits for every queued local utterance and reports speech failure: %s', async failed => {
    vi.useFakeTimers();
    const { voice, socket, speak } = await connected('pipeline', 'Guten Tag!');
    socket.onmessage!({ data: JSON.stringify({ type: 'agent_text', text: 'Auf Wiederhören.' }) });
    const id = '00000000-0000-4000-8000-000000000001';
    socket.onmessage!({ data: JSON.stringify({ type: 'ending', id }) });
    const sent = () => socket.send.mock.calls.map(([s]) => JSON.parse(s)).filter(m => m.type.startsWith('playback_'));
    speak.mock.calls[0][0].onend();
    expect(sent()).toEqual([]);
    speak.mock.calls[1][0][failed ? 'onerror' : 'onend']();
    expect(sent()).toEqual([{ type: failed ? 'playback_failed' : 'playback_complete', id }]);
    speak.mock.calls[1][0].onend();
    expect(sent()).toHaveLength(1);
    voice.hangup();
  });

  it('retains a local cascade greeting but does not repeat its streamed responses', async () => {
    const { voice, socket, speak, german } = await connected('realtime', 'Guten Tag!');
    expect(speak.mock.calls[0][0]).toMatchObject({ lang: 'de', voice: german });
    socket.onmessage!({ data: JSON.stringify({ type: 'agent_text', text: 'Wie kann ich helfen?' }) });
    expect(speak).toHaveBeenCalledTimes(1);
    voice.hangup();
  });
});

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

  it('reports an HTMLAudio play rejection as failure and ignores callbacks after teardown', async () => {
    vi.useFakeTimers();
    const { socket } = prepareConnection();
    let reject!: (reason: Error) => void;
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:closing', revokeObjectURL: vi.fn() });
    vi.stubGlobal('Audio', vi.fn(function () { return { play: () => new Promise((_, r) => { reject = r; }), pause: vi.fn(), onended: null, onerror: null }; }));
    const voice = new VoiceCall(); await voice.connect('test');
    socket.onmessage!({ data: new ArrayBuffer(10) });
    const id = '00000000-0000-4000-8000-000000000001';
    socket.onmessage!({ data: JSON.stringify({ type: 'ending', id }) });
    expect(socket.send).not.toHaveBeenCalled();
    reject(Error('autoplay blocked')); await Promise.resolve(); await Promise.resolve();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'playback_failed', id }));
    voice.hangup(); socket.send.mockClear();
    await vi.advanceTimersByTimeAsync(2500);
    expect(socket.send).not.toHaveBeenCalled();
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

describe('bounded realtime browser playback receipts', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  async function connected() {
    const { socket } = prepareConnection();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw Error('no microphone'); } } });
    const nodes: { onended: (() => void) | null; stop: ReturnType<typeof vi.fn> }[] = [];
    const createBuffer = vi.fn((_channels: number, samples: number) => {
      const channel = new Float32Array(samples);
      return { duration: samples / 24000, getChannelData: () => channel };
    });
    const context = { currentTime: 0, destination: {}, resume: async () => {}, close: async () => {}, createBuffer,
      createBufferSource: () => {
        const node = { buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null };
        nodes.push(node); return node;
      } };
    vi.stubGlobal('AudioContext', vi.fn(function () { return context; }));
    const voice = new VoiceCall(); await voice.connect('test');
    socket.onmessage!({ data: JSON.stringify({ type: 'ready', mode: 'realtime', audioReceipts: true }) });
    const receive = socket.onmessage!;
    const pcm = (bytes: number) => receive({ data: new ArrayBuffer(bytes) });
    const marker = (bytes: number, markerId: unknown = id) => receive({ data: JSON.stringify({ type: 'audio_receipt', id: markerId, bytes }) });
    const acknowledgements = () => socket.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter(msg => msg.type === 'audio_received');
    return { socket, voice, nodes, createBuffer, pcm, marker, acknowledgements, receive };
  }

  it('closing guard: acknowledges actual playback end, separately from audio receipt', async () => {
    const f = await connected();
    f.pcm(4800); f.marker(4800);
    f.receive({ data: JSON.stringify({ type: 'ending', id }) });
    const completions = () => f.socket.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter(m => m.type === 'playback_complete');
    expect(completions()).toHaveLength(0);
    f.nodes[0].onended!();
    expect(completions()).toEqual([{ type: 'playback_complete', id }]);
    f.voice.hangup();
  });

  it('negative control: acknowledges accepted audio only after bounded playback admission', async () => {
    const f = await connected();
    f.pcm(480000); f.marker(480000);
    expect(f.acknowledgements()).toEqual([{ type: 'audio_received', id }]);
    expect(f.createBuffer).toHaveBeenCalledTimes(1);
    f.voice.hangup();
  });

  it('negative control: a suspended player refuses a third maximum frame before allocation or receipt', async () => {
    const f = await connected();
    f.pcm(480000); f.marker(480000); f.pcm(480000); f.marker(480000);
    f.pcm(2); f.marker(2);
    expect(f.createBuffer).toHaveBeenCalledTimes(2);
    expect(f.acknowledgements()).toHaveLength(2);
    expect(f.voice.ended).toBe(true);
    expect(f.nodes.every(node => node.stop.mock.calls.length === 1)).toBe(true);
  });

  it('negative control: caps tiny-frame AudioBuffer source objects separately from bytes', async () => {
    const f = await connected();
    for (let i = 0; i < 401; i++) { f.pcm(4); f.marker(4); }
    expect(f.createBuffer).toHaveBeenCalledTimes(400);
    expect(f.acknowledgements()).toHaveLength(400);
    expect(f.voice.ended).toBe(true);
  });

  it.each(['ended', 'flush'])('returns playback capacity on %s without imposing a lifetime speech limit', async how => {
    const f = await connected();
    for (let i = 0; i < 20; i++) {
      f.pcm(480000); f.marker(480000);
      if (how === 'ended') f.nodes.at(-1)!.onended!();
      else {
        f.receive({ data: JSON.stringify({ type: 'flush' }) });
        f.receive({ data: JSON.stringify({ type: 'control_receipt', id }) });
      }
    }
    expect(f.acknowledgements()).toHaveLength(how === 'flush' ? 40 : 20); expect(f.voice.ended).toBe(false);
    f.voice.hangup();
  });

  it.each(['no-frame', 'wrong-size', 'duplicate', 'invalid-id'])('rejects a %s receipt marker', async how => {
    const f = await connected();
    if (how !== 'no-frame') f.pcm(4);
    if (how === 'duplicate') f.marker(4);
    f.marker(how === 'wrong-size' ? 6 : 4, how === 'invalid-id' ? 'reflected-provider-value' : id);
    expect(f.voice.ended).toBe(true);
    expect(f.acknowledgements()).toHaveLength(how === 'duplicate' ? 1 : 0);
  });

  it.each(['binary', 'flush'])('negative control: refuses intervening %s before the pending audio marker', async kind => {
    const f = await connected(); f.pcm(4);
    if (kind === 'binary') f.pcm(4);
    else f.receive({ data: JSON.stringify({ type: 'flush' }) });
    f.marker(4);
    expect(f.voice.ended).toBe(true); expect(f.acknowledgements()).toHaveLength(0);
  });

  it('ignores a queued receipt after teardown', async () => {
    const f = await connected(); f.pcm(4); f.voice.hangup(); f.marker(4);
    expect(f.acknowledgements()).toHaveLength(0);
  });
});


describe('audible playback recovery', () => {
  it.each(['pending', 'rejected'])('reports a %s audio resume and permits gesture recovery without another context', async kind => {
    vi.useFakeTimers();
    const ctx = { state: 'suspended', onstatechange: null as null | (() => void), close: vi.fn(async () => {}),
      resume: vi.fn(() => kind === 'pending' ? new Promise<void>(() => {}) : Promise.reject(Error('blocked'))) };
    const AudioContext = vi.fn(function () { return ctx; }); vi.stubGlobal('AudioContext', AudioContext);
    vi.stubGlobal('speechSynthesis', { cancel: vi.fn() });
    const voice = new VoiceCall(); const events: any[] = []; voice.on(e => events.push(e));
    voice.prepareAudio();
    await vi.advanceTimersByTimeAsync(800);
    expect(events).toContainEqual({ type: 'audio', blocked: true });
    ctx.resume.mockImplementation(async () => { ctx.state = 'running'; ctx.onstatechange?.(); });
    voice.prepareAudio(); await Promise.resolve();
    expect(events.at(-1)).toEqual({ type: 'audio', blocked: false });
    expect(AudioContext).toHaveBeenCalledTimes(1);
    voice.hangup(); expect(ctx.close).toHaveBeenCalledTimes(1);
    const count = events.length; await vi.advanceTimersByTimeAsync(1000); expect(events).toHaveLength(count);
  });
});


it('retries a blocked Pipeline player in place without reporting false playback completion', async () => {
  vi.useFakeTimers();
  const { socket } = prepareConnection();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw Error('no microphone'); } } });
  const ctx = { state: 'running', resume: async () => {}, close: async () => {} };
  vi.stubGlobal('AudioContext', vi.fn(function () { return ctx; }));
  const play = vi.fn().mockRejectedValueOnce(Object.assign(Error('blocked'), { name: 'NotAllowedError' })).mockResolvedValue(undefined);
  const player = { play, pause: vi.fn(), onended: null as null | (() => void), onerror: null };
  vi.stubGlobal('Audio', vi.fn(function () { return player; }));
  const revoke = vi.fn(); vi.stubGlobal('URL', { createObjectURL: () => 'blob:synthetic', revokeObjectURL: revoke });
  const voice = new VoiceCall(); const events: any[] = []; voice.on(e => events.push(e));
  voice.prepareAudio(); await voice.connect('test');
  socket.onmessage!({ data: new ArrayBuffer(4) });
  await vi.advanceTimersByTimeAsync(800);
  expect(events.at(-1)).toEqual({ type: 'audio', blocked: true });
  expect(revoke).not.toHaveBeenCalled();
  socket.onmessage!({ data: JSON.stringify({ type: 'ending', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }) });
  expect(socket.send).not.toHaveBeenCalled();
  voice.prepareAudio(); await vi.advanceTimersByTimeAsync(1);
  expect(play).toHaveBeenCalledTimes(2); expect(events.at(-1)).toEqual({ type: 'audio', blocked: false });
  player.onended!();
  expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'playback_complete', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
  expect(revoke).toHaveBeenCalledOnce(); voice.hangup();
});
