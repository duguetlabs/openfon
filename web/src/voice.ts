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

    ws.onopen = () => ws.send(JSON.stringify({ type: 'start' }));
    ws.onerror = () => this.emit({ type: 'status', status: 'error', detail: 'Connection failed' });
    ws.onclose = () => {
      if (!this.ended) this.teardown('ended');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        this.playAudio(ev.data as ArrayBuffer);
        return;
      }
      const msg = JSON.parse(ev.data) as { type: string; text?: string; greeting?: string; ttsMode?: string; message?: string };
      switch (msg.type) {
        case 'ready':
          this.ttsMode = msg.ttsMode === 'server' ? 'server' : 'browser';
          this.emit({ type: 'status', status: 'live' });
          this.emit({ type: 'agent_text', text: msg.greeting ?? '' });
          if (this.ttsMode === 'browser' && msg.greeting) this.speakLocally(msg.greeting);
          if (this.stream) this.startVad();
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
    try {
      this.recorder?.state !== 'inactive' && this.recorder?.stop();
    } catch {
      /* noop */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.audioCtx?.close();
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
