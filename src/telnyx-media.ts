/** Telnyx raw-PCMU streaming bridge. No routes or provider commands here.
 * Wire contract checked 2026-09-12:
 * https://developers.telnyx.com/api-reference/websockets/stream-call-media-over-websocket
 * Caller authenticates the HTTP upgrade and accepts both sockets first.
 */
import { decodePcmuFrame, Pcmu8ToPcm24, Pcm24ToPcmu8, MAX_PCM24_BYTES } from './telephony-audio';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_frame');
  return value as ObjectValue;
};
const integer = (value: unknown): number => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,14})$/.test(value)) throw new Error('invalid_sequence');
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('invalid_sequence');
  return result;
};
const parse = (raw: unknown, maximum: number): ObjectValue => {
  if (typeof raw !== 'string' || raw.length > maximum) throw new Error('invalid_frame');
  return object(JSON.parse(raw));
};
export interface TelnyxMediaOptions {
  expected: { callControlId: string; callSessionId: string; callLegId?: string; authToken: string };
  carrierSend: (data: string) => void;
  sessionSend: (data: string | ArrayBuffer) => void;
  onStart?: () => void | Promise<void>;
  onEnd: (reason: string) => void;
}
interface Packet { payload: string; timestamp: number; sequence: number; bytes: number }
/** All allocations/queues have fixed caps. Methods consume already accepted socket
 * messages; errors fail closed through onEnd exactly once, with no raw data logged.
 */
export class TelnyxMediaAdapter {
  private up = new Pcmu8ToPcm24();
  private down = new Pcm24ToPcmu8();
  private connected = false;
  private streamId = '';
  private ready = false;
  private closed = false;
  private starting = false;
  private startup = setTimeout(() => this.close('start_timeout'), 10000);
  private gap?: ReturnType<typeof setTimeout>;
  private tick?: ReturnType<typeof setTimeout>;
  private endingDeadline?: ReturnType<typeof setTimeout>;
  private endQuiet?: ReturnType<typeof setTimeout>;
  private ending = false;
  private drained = false;
  private nextChunk = 1;
  private lastTimestamp = -1;
  private lastSequence = -1;
  private reorder = new Map<number, Packet>();
  private reorderBytes = 0;
  private preReady: Uint8Array[] = [];
  private preReadyBytes = 0;
  private queue: string[] = [];
  private generation = 0;
  private markCounter = 0;
  private pendingMarks = new Set<string>();
  constructor(private readonly options: TelnyxMediaOptions) {
    if (!options.expected.authToken || options.expected.authToken.length > 4000 || !options.expected.callControlId) {
      clearTimeout(this.startup);
      throw new Error('invalid_configuration');
    }
  }

  async carrierMessage(raw: unknown): Promise<void> {
    if (this.closed) return;
    try {
      const msg = parse(raw, 8192);
      if (msg.event === 'connected') {
        if (this.connected || this.streamId || msg.version !== '1.0.0' ||
            object(msg.connected)['x-telnyx-streaming-auth-token'] !== this.options.expected.authToken) throw new Error('invalid_connection');
        this.connected = true;
        return;
      }
      if (!this.connected) throw new Error('not_connected');
      if (msg.event === 'start') {
        if (this.streamId || this.starting) throw new Error('duplicate_start');
        const start = object(msg.start);
        const format = object(start.media_format);
        if (typeof msg.stream_id !== 'string' || !msg.stream_id.length || msg.stream_id.length > 128 ||
            start.call_control_id !== this.options.expected.callControlId ||
            (start.call_session_id !== undefined && start.call_session_id !== this.options.expected.callSessionId) ||
            (start.call_leg_id !== undefined && start.call_leg_id !== this.options.expected.callLegId) ||
            format.encoding !== 'PCMU' || format.sample_rate !== 8000 || format.channels !== 1) throw new Error('invalid_start');
        this.lastSequence = integer(msg.sequence_number);
        this.streamId = msg.stream_id;
        this.starting = true;
        await this.options.onStart?.();
        if (this.closed) return;
        this.starting = false;
        this.options.sessionSend(JSON.stringify({ type: 'start' }));
        return;
      }
      if (!this.streamId || msg.stream_id !== this.streamId) throw new Error('invalid_stream');
      if (msg.event === 'media') {
        if (this.drained) return;
        const media = object(msg.media);
        if (media.track !== 'inbound') throw new Error('invalid_track');
        const chunk = integer(media.chunk);
        const sequence = integer(msg.sequence_number);
        const timestamp = integer(media.timestamp);
        if (chunk < 1) throw new Error('invalid_chunk');
        if (chunk < this.nextChunk || this.reorder.has(chunk)) return; // late/duplicate packet
        if (chunk - this.nextChunk > 10 || this.reorder.size >= 10) throw new Error('reorder_overflow');
        const bytes = decodePcmuFrame(media.payload).length;
        if (this.reorderBytes + bytes > 8000) throw new Error('reorder_overflow');
        this.reorder.set(chunk, { payload: media.payload as string, timestamp, sequence, bytes });
        this.reorderBytes += bytes;
        this.drainInput();
      } else if (msg.event === 'mark') {
        const name = object(msg.mark).name;
        if (typeof name !== 'string' || name.length > 100) throw new Error('invalid_mark');
        this.pendingMarks.delete(name); // marks returned by clear belong to an old generation
        this.maybeEnd();
      } else if (msg.event === 'stop') {
        const stop = object(msg.stop);
        if (stop.call_control_id !== this.options.expected.callControlId) throw new Error('invalid_stop');
        this.close('carrier_stop');
      } else if (msg.event === 'error') this.close('carrier_error');
      else if (msg.event !== 'dtmf') throw new Error('unknown_event');
    } catch { this.close('invalid_carrier_frame'); }
  }

  private drainInput(): void {
    while (this.reorder.has(this.nextChunk)) {
      const packet = this.reorder.get(this.nextChunk)!;
      this.reorder.delete(this.nextChunk++);
      this.reorderBytes -= packet.bytes;
      if (packet.timestamp < this.lastTimestamp || packet.sequence <= this.lastSequence) throw new Error('invalid_order');
      this.lastTimestamp = packet.timestamp;
      this.lastSequence = packet.sequence;
      const pcm = this.up.push(packet.payload);
      if (this.ready) this.options.sessionSend(pcm.buffer as ArrayBuffer);
      else {
        // The carrier emits continuous audio, including silence, while the
        // provider connects. Retain the latest second until readiness instead
        // of treating an ordinary multi-second handshake as queue overflow.
        while (this.preReadyBytes + pcm.length > 48000 && this.preReady.length) {
          this.preReadyBytes -= this.preReady.shift()!.length;
        }
        this.preReady.push(pcm);
        this.preReadyBytes += pcm.length;
      }
    }
    if (!this.reorder.size && this.gap) { clearTimeout(this.gap); this.gap = undefined; }
    if (this.reorder.size && !this.gap) this.gap = setTimeout(() => {
      this.gap = undefined;
      if (this.closed) return;
      // Bounded loss recovery: skip missing packets after 100ms. Reset FIR so
      // discontinuities do not interpolate across audio that never arrived.
      this.nextChunk = Math.min(...this.reorder.keys());
      this.up.reset();
      try { this.drainInput(); } catch { this.close('invalid_media_order'); }
    }, 100);
  }

  sessionMessage(raw: unknown): void {
    if (this.closed) return;
    try {
      if (raw instanceof ArrayBuffer) {
        if (!this.ready || this.drained || !raw.byteLength || raw.byteLength % 2 || raw.byteLength > 480000) throw new Error('invalid_session_audio');
        const pcm = new Uint8Array(raw);
        for (let offset = 0; offset < pcm.length; offset += MAX_PCM24_BYTES) this.enqueue(this.down.push(pcm.subarray(offset, offset + MAX_PCM24_BYTES)));
        if (this.ending) this.armDrain();
        return;
      }
      const msg = parse(raw, 65536);
      if (msg.type === 'ready') {
        if (!this.streamId || this.starting || this.ready || msg.mode !== 'realtime' ||
            (msg.ttsMode === 'browser' && Boolean(msg.greeting))) throw new Error('unsupported_session');
        this.ready = true;
        clearTimeout(this.startup);
        for (const pcm of this.preReady) this.options.sessionSend(pcm.buffer as ArrayBuffer);
        this.preReady = []; this.preReadyBytes = 0;
      } else if (msg.type === 'flush') {
        this.queue = []; this.down.reset(); this.drained = false; this.generation++; this.pendingMarks.clear();
        if (this.tick) clearTimeout(this.tick);
        this.tick = undefined;
        if (this.streamId) this.send({ event: 'clear' });
        if (this.ending) this.armDrain();
      } else if (msg.type === 'ending') {
        if (!this.ready) throw new Error('not_ready');
        if (!this.ending) {
          this.ending = true;
          this.endingDeadline = setTimeout(() => this.close('drain_timeout'), 12000);
        }
        this.armDrain();
      } else if (msg.type === 'ended' || msg.type === 'error') this.close('session_ended');
      // Transcripts, agent text, tool metadata and browser controls stay private.
    } catch { this.close('invalid_session_frame'); }
  }
  private enqueue(frames: string[]): void {
    if (this.queue.length + frames.length > 500) throw new Error('playback_overflow');
    this.queue.push(...frames);
    if (!this.tick && this.queue.length) this.tick = setTimeout(() => this.play(), 20);
  }
  private play(): void {
    this.tick = undefined;
    if (this.closed) return;
    try {
      const payload = this.queue.shift();
      if (payload) {
        if (this.pendingMarks.size >= 500) throw new Error('unacknowledged_playback');
        const name = `g${this.generation}:${++this.markCounter}`;
        this.pendingMarks.add(name);
        this.send({ event: 'media', media: { payload } });
        this.send({ event: 'mark', mark: { name } });
      }
      if (this.queue.length) this.tick = setTimeout(() => this.play(), 20);
      this.maybeEnd();
    } catch { this.close('playback_error'); }
  }
  private armDrain(): void {
    if (this.endQuiet) clearTimeout(this.endQuiet);
    this.endQuiet = setTimeout(() => {
      if (this.closed) return;
      try { this.enqueue(this.down.finish()); this.drained = true; this.maybeEnd(); }
      catch { this.close('playback_overflow'); }
    }, 200);
  }
  private maybeEnd(): void {
    if (this.ending && this.drained && !this.queue.length && !this.pendingMarks.size) this.close('playback_complete');
  }
  private send(value: unknown): void { this.options.carrierSend(JSON.stringify(value)); }
  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of [this.startup, this.gap, this.tick, this.endingDeadline, this.endQuiet]) if (timer !== undefined) clearTimeout(timer);
    this.queue = []; this.preReady = []; this.reorder.clear(); this.pendingMarks.clear();
    this.up.reset(); this.down.reset();
    try { this.options.sessionSend(JSON.stringify({ type: 'hangup' })); } catch { /* transport already gone */ }
    this.options.onEnd(reason);
  }
}

/** Both sockets must already be accepted; owns listeners until close(). */
export function createTelnyxMediaBridge(input: {
  carrier: WebSocket; session: WebSocket; callId: string; callControlId: string;
  callLegId: string; callSessionId: string; streamToken: string;
  onStart?: () => void | Promise<void>; onEnded: (reason: string) => void;
}): { close: (reason?: string) => void } {
  const checkedSend = (socket: WebSocket, data: string | ArrayBuffer) => {
    // Workers does not expose bufferedAmount; the adapter independently caps
    // queued frames and unacknowledged marks. Check it on runtimes that do.
    const buffered = (socket as WebSocket & { bufferedAmount?: number }).bufferedAmount;
    if (socket.readyState !== 1 || (buffered !== undefined && buffered > 65536)) throw new Error('socket_backpressure');
    socket.send(data);
  };
  const adapter = new TelnyxMediaAdapter({
    expected: { callControlId: input.callControlId, callSessionId: input.callSessionId, callLegId: input.callLegId, authToken: input.streamToken },
    carrierSend: data => checkedSend(input.carrier, data), sessionSend: data => checkedSend(input.session, data),
    onStart: input.onStart,
    onEnd: reason => {
      input.carrier.removeEventListener('message', carrierMessage);
      input.session.removeEventListener('message', sessionMessage);
      for (const socket of [input.carrier, input.session]) {
        socket.removeEventListener('close', disconnected); socket.removeEventListener('error', disconnected);
        try { socket.close(1000, 'call ended'); } catch { /* already closed */ }
      }
      input.onEnded(reason);
    },
  });
  const carrierMessage = (event: MessageEvent) => { void adapter.carrierMessage(event.data); };
  const sessionMessage = (event: MessageEvent) => adapter.sessionMessage(event.data);
  const disconnected = () => adapter.close('socket_closed');
  input.carrier.addEventListener('message', carrierMessage);
  input.session.addEventListener('message', sessionMessage);
  for (const socket of [input.carrier, input.session]) {
    socket.addEventListener('close', disconnected); socket.addEventListener('error', disconnected);
  }
  return { close: reason => adapter.close(reason) };
}
