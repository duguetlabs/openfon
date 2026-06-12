// Browser voice-call client. Captures mic audio, detects utterances with a
// simple RMS voice-activity detector, ships each utterance to the CallSession
// Durable Object over WebSocket, and plays the agent's reply (server MP3 or
// browser speechSynthesis fallback).

export type VoiceEvent =
  | { type: 'status'; status: 'connecting' | 'live' | 'ended' | 'error'; detail?: string }
  | { type: 'transcript'; text: string }
  | { type: 'agent_text'; text: string }
  | { type: 'thinking' }
  | { type: 'speaking'; who: 'caller' | 'agent' | 'none' }
  | { type: 'level'; value: number };

type Listener = (ev: VoiceEvent) => void;

const SPEECH_THRESHOLD = 0.018; // RMS above this counts as speech
const SILENCE_MS = 900; // stop the utterance after this much silence
const MIN_UTTERANCE_MS = 350; // ignore blips shorter than this
const MAX_UTTERANCE_MS = 12_000; // force-stop runaway recordings (constant background noise)

function downsampleToPcm16(input: Float32Array, fromRate: number, toRate: number): Int16Array {
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const v = input[Math.floor(i * ratio)];
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

export class VoiceCall {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private vadTimer: number | null = null;
  private speechStartedAt = 0;
  private lastVoiceAt = 0;
  private recording = false;
  private agentSpeaking = false;
  private ttsMode: 'server' | 'browser' = 'browser';
  private mimeType = 'audio/webm';
  private player: HTMLAudioElement | null = null;
  private listeners: Listener[] = [];
  ended = false;
  // realtime engine mode: continuous streaming, server-side VAD, barge-in
  private mode: 'pipeline' | 'realtime' = 'pipeline';
  private captureCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private playCtx: AudioContext | null = null;
  private nextPlayTime = 0;
  private liveSources = new Set<AudioBufferSourceNode>();
  private pcmCarry: Uint8Array | null = null; // odd trailing byte awaiting its other half
  private pingTimer: number | null = null;

  on(fn: Listener): void {
    this.listeners.push(fn);
  }
  private emit(ev: VoiceEvent): void {
    for (const fn of this.listeners) fn(ev);
  }

  async start(slug: string): Promise<void> {
    this.emit({ type: 'status', status: 'connecting' });
    const res = await fetch('/api/public/call/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(err?.error ?? 'Could not start call');
    }
    const { callId } = (await res.json()) as { callId: string };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      this.stream = null; // mic denied -> text-only mode still works
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/call/${callId}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'start' }));
      // Cloudflare drops WebSockets idle for ~100 s; pipeline-mode calls go
      // silent between utterances, so keep the line warm.
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 20_000);
    };
    ws.onerror = () => this.emit({ type: 'status', status: 'error', detail: 'Connection failed' });
    ws.onclose = () => {
      if (!this.ended) this.teardown('ended');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        if (this.mode === 'realtime') this.playPcm(ev.data as ArrayBuffer);
        else this.playAudio(ev.data as ArrayBuffer);
        return;
      }
      const msg = JSON.parse(ev.data) as {
        type: string;
        text?: string;
        greeting?: string;
        ttsMode?: string;
        message?: string;
        mode?: string;
        who?: 'caller' | 'agent' | 'none';
      };
      switch (msg.type) {
        case 'ready':
          this.mode = msg.mode === 'realtime' ? 'realtime' : 'pipeline';
          this.ttsMode = msg.ttsMode === 'server' ? 'server' : 'browser';
          this.emit({ type: 'status', status: 'live' });
          if (msg.greeting) {
            this.emit({ type: 'agent_text', text: msg.greeting });
            if (this.ttsMode === 'browser') this.speakLocally(msg.greeting);
          }
          if (this.stream) {
            if (this.mode === 'realtime') this.startRealtimeCapture();
            else this.startVad();
          }
          break;
        case 'flush': // barge-in: stop agent playback immediately
          this.flushPlayback();
          break;
        case 'speaking':
          if (msg.who) this.emit({ type: 'speaking', who: msg.who });
          break;
        case 'transcript':
          this.emit({ type: 'transcript', text: msg.text ?? '' });
          break;
        case 'thinking':
          this.emit({ type: 'thinking' });
          break;
        case 'agent_text':
          this.emit({ type: 'agent_text', text: msg.text ?? '' });
          if (this.ttsMode === 'browser' && msg.text) this.speakLocally(msg.text);
          break;
        case 'error':
          this.emit({ type: 'status', status: 'error', detail: msg.message });
          break;
        case 'ended':
          this.teardown('ended');
          break;
      }
    };
  }

  sendText(text: string): void {
    this.ws?.send(JSON.stringify({ type: 'text', text }));
  }

  hangup(): void {
    try {
      this.ws?.send(JSON.stringify({ type: 'hangup' }));
    } catch {
      /* already closed */
    }
    this.teardown('ended');
  }

  get hasMic(): boolean {
    return this.stream !== null;
  }

  // ---- voice activity detection ----
  private startVad(): void {
    if (!this.stream) return;
    this.audioCtx = new AudioContext();
    const src = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    const buf = new Float32Array(this.analyser.fftSize);
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) this.mimeType = 'audio/webm;codecs=opus';
    else if (MediaRecorder.isTypeSupported('audio/mp4')) this.mimeType = 'audio/mp4';

    this.vadTimer = window.setInterval(() => {
      if (!this.analyser || this.ended) return;
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      this.emit({ type: 'level', value: Math.min(1, rms * 18) });

      if (this.agentSpeaking) return; // half-duplex: don't record over the agent
      const now = performance.now();
      if (rms > SPEECH_THRESHOLD) {
        this.lastVoiceAt = now;
        if (!this.recording) this.beginUtterance(now);
      } else if (this.recording && now - this.lastVoiceAt > SILENCE_MS) {
        this.endUtterance(now);
      }
      if (this.recording && now - this.speechStartedAt > MAX_UTTERANCE_MS) {
        this.endUtterance(now);
      }
    }, 60);
  }

  private beginUtterance(now: number): void {
    if (!this.stream) return;
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => this.shipUtterance();
    this.recorder.start();
    this.recording = true;
    this.speechStartedAt = now;
    this.emit({ type: 'speaking', who: 'caller' });
  }

  private endUtterance(now: number): void {
    this.recording = false;
    this.emit({ type: 'speaking', who: 'none' });
    const dur = now - this.speechStartedAt;
    if (this.recorder && this.recorder.state !== 'inactive') {
      if (dur < MIN_UTTERANCE_MS) {
        this.recorder.ondataavailable = null;
        this.recorder.onstop = null;
        this.recorder.stop();
      } else {
        this.recorder.stop(); // triggers shipUtterance
      }
    }
  }

  private async shipUtterance(): Promise<void> {
    const blob = new Blob(this.chunks, { type: this.mimeType });
    this.chunks = [];
    if (blob.size < 1200 || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'meta', contentType: this.mimeType }));
    this.ws.send(await blob.arrayBuffer());
  }

  // ---- realtime engine: continuous capture + streamed PCM playback ----

  private startRealtimeCapture(): void {
    if (!this.stream) return;
    this.captureCtx = new AudioContext();
    const src = this.captureCtx.createMediaStreamSource(this.stream);
    this.processor = this.captureCtx.createScriptProcessor(2048, 1, 1);
    const mute = this.captureCtx.createGain();
    mute.gain.value = 0; // processor must reach destination to run, but stay silent
    src.connect(this.processor);
    this.processor.connect(mute);
    mute.connect(this.captureCtx.destination);
    const fromRate = this.captureCtx.sampleRate;
    this.processor.onaudioprocess = (e) => {
      if (this.ended || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i += 8) sum += input[i] * input[i];
      this.emit({ type: 'level', value: Math.min(1, Math.sqrt(sum / (input.length / 8)) * 18) });
      this.ws.send(downsampleToPcm16(input, fromRate, 24000).buffer);
    };
  }

  private playPcm(buf: ArrayBuffer): void {
    // The PCM stream is split into chunks at arbitrary byte offsets; a chunk
    // boundary can land mid-sample. Carry the odd byte into the next chunk —
    // playing misaligned PCM16 sounds like a burst of white noise.
    let bytes = new Uint8Array(buf);
    if (this.pcmCarry) {
      const joined = new Uint8Array(this.pcmCarry.length + bytes.length);
      joined.set(this.pcmCarry);
      joined.set(bytes, this.pcmCarry.length);
      bytes = joined;
      this.pcmCarry = null;
    }
    if (bytes.length % 2 === 1) {
      this.pcmCarry = bytes.slice(bytes.length - 1);
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (bytes.length < 2) return;
    if (!this.playCtx) this.playCtx = new AudioContext({ sampleRate: 24000 });
    const ctx = this.playCtx;
    void ctx.resume();
    const i16 = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    const audio = ctx.createBuffer(1, i16.length, 24000);
    const ch = audio.getChannelData(0);
    for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768;
    const node = ctx.createBufferSource();
    node.buffer = audio;
    node.connect(ctx.destination);
    // 150 ms jitter cushion when starting fresh; back-to-back while streaming.
    const startAt = Math.max(ctx.currentTime + (this.liveSources.size === 0 ? 0.15 : 0.005), this.nextPlayTime);
    node.start(startAt);
    this.nextPlayTime = startAt + audio.duration;
    if (this.liveSources.size === 0) this.emit({ type: 'speaking', who: 'agent' });
    this.liveSources.add(node);
    node.onended = () => {
      this.liveSources.delete(node);
      if (this.liveSources.size === 0) this.emit({ type: 'speaking', who: 'none' });
    };
  }

  private flushPlayback(): void {
    for (const node of this.liveSources) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
    }
    this.liveSources.clear();
    this.nextPlayTime = 0;
    this.pcmCarry = null;
  }

  // ---- agent audio playback ----
  private playAudio(buf: ArrayBuffer): void {
    this.agentSpeaking = true;
    this.emit({ type: 'speaking', who: 'agent' });
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
    this.player = new Audio(url);
    this.player.onended = this.player.onerror = () => {
      URL.revokeObjectURL(url);
      this.agentSpeaking = false;
      this.emit({ type: 'speaking', who: 'none' });
    };
    void this.player.play();
  }

  private speakLocally(text: string): void {
    this.agentSpeaking = true;
    this.emit({ type: 'speaking', who: 'agent' });
    const u = new SpeechSynthesisUtterance(text);
    u.onend = u.onerror = () => {
      this.agentSpeaking = false;
      this.emit({ type: 'speaking', who: 'none' });
    };
    speechSynthesis.speak(u);
  }

  private teardown(status: 'ended'): void {
    if (this.ended) return;
    this.ended = true;
    if (this.vadTimer) clearInterval(this.vadTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.recorder?.state !== 'inactive' && this.recorder?.stop();
    } catch {
      /* noop */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.audioCtx?.close();
    this.flushPlayback();
    this.processor?.disconnect();
    void this.captureCtx?.close();
    void this.playCtx?.close();
    this.player?.pause();
    speechSynthesis.cancel();
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.emit({ type: 'status', status });
  }
}
