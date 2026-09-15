import { MediaOutputDebt } from './media-output-debt';
/** chan_websocket JSON control, ulaw/8000/mono. Asterisk owns 20ms pacing.
 * https://docs.asterisk.org/Configuration/Channel-Drivers/WebSocket/
 */
import { Pcmu8ToPcm24, Pcm24ToPcmu8, MAX_PCM24_BYTES } from './telephony-audio';

export class AsteriskMediaAdapter {
  private audioReceipts = false;
  private controlReceiptPending = false;
  private transportDebt = new MediaOutputDebt();
  private lastPcmBytes: number | null = null;
  private up = new Pcmu8ToPcm24();
  private down = new Pcm24ToPcmu8();
  private started = false;
  private ready = false;
  private closed = false;
  private paused = false;
  private ending = false;
  private drained = false;
  private drainPending = false;
  private generation = 0;
  private marks = new Set<string>();
  private queue: string[] = [];
  private startup = setTimeout(() => this.close('start_timeout'), 20000);
  private playback?: ReturnType<typeof setTimeout>;
  private quiet?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  constructor(private options: {
    carrierSend: (data: string | ArrayBuffer) => void;
    sessionSend: (data: string | ArrayBuffer) => void;
    onReady?: () => void;
    onEnd: (reason: string) => void;
  }) {}
  private command(command: string, correlation_id?: string): void {
    this.options.carrierSend(JSON.stringify({ command, ...(correlation_id ? { correlation_id } : {}) }));
  }
  carrierMessage(raw: unknown): void {
    if (this.closed) return;
    try {
      if (raw instanceof ArrayBuffer) {
        if (!this.started || !raw.byteLength || raw.byteLength > 1600) throw Error();
        // Discard startup audio: never replay speech over the greeting.
        if (!this.ready || this.ending) return;
        const bytes = new Uint8Array(raw);
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        this.options.sessionSend(this.up.push(btoa(binary)).buffer as ArrayBuffer);
        return;
      }
      if (typeof raw !== 'string' || raw.length > 8192) throw Error();
      const msg = JSON.parse(raw);
      if (!msg || typeof msg !== 'object') throw Error();
      if (msg.event === 'MEDIA_START') {
        if (this.started || msg.format !== 'ulaw' || msg.optimal_frame_size !== 160 || msg.ptime !== 20 ||
            typeof msg.channel !== 'string' || typeof msg.connection_id !== 'string') throw Error();
        this.started = true;
        this.command('ANSWER');
        this.options.sessionSend(JSON.stringify({ type: 'start' }));
      } else {
        if (!this.started) throw Error();
        if (msg.event === 'MEDIA_XOFF') { this.paused = true; this.stopPump(); }
        else if (msg.event === 'MEDIA_XON') { this.paused = false; this.schedulePump(); }
        else if (msg.event === 'MEDIA_MARK_PROCESSED') {
          if (typeof msg.correlation_id !== 'string') throw Error();
          this.transportDebt.confirm(msg.correlation_id);
          this.marks.delete(msg.correlation_id); this.finishDrain(); this.maybeEnd();
        } else if (!['DTMF_END', 'STATUS', 'QUEUE_DRAINED', 'MEDIA_BUFFERING_COMPLETED'].includes(msg.event)) throw Error();
      }
    } catch { this.close('invalid_carrier_frame'); }
  }
  sessionMessage(raw: unknown): void {
    if (this.closed) return;
    try {
      if (raw instanceof ArrayBuffer) {
        if (this.audioReceipts && (this.lastPcmBytes !== null || this.controlReceiptPending)) throw Error('missing_audio_receipt');
        // Greeting audio may precede ready, but only after MEDIA_START.
        if (!this.started || this.drained || this.drainPending || !raw.byteLength || raw.byteLength % 2 || raw.byteLength > 480000) throw Error();
        const bytes = new Uint8Array(raw);
        for (let offset = 0; offset < bytes.length; offset += MAX_PCM24_BYTES) this.enqueue(this.down.push(bytes.subarray(offset, offset + MAX_PCM24_BYTES)));
        this.lastPcmBytes = raw.byteLength;
        if (this.ending) this.armDrain();
        return;
      }
      if (typeof raw !== 'string' || raw.length > 65536) throw Error();
      const msg = JSON.parse(raw);
      if (this.audioReceipts && ((this.lastPcmBytes !== null && msg.type !== 'audio_receipt') ||
          (this.controlReceiptPending && msg.type !== 'control_receipt'))) throw Error('missing_output_receipt');
      if (msg.type === 'control_receipt') {
        if (!this.controlReceiptPending || typeof msg.id !== 'string' || !/^[0-9a-f-]{36}$/.test(msg.id)) throw Error('invalid_control_receipt');
        this.controlReceiptPending = false;
        this.options.sessionSend(JSON.stringify({ type: 'audio_received', id: msg.id }));
      } else if (msg.type === 'audio_receipt') {
        if (this.lastPcmBytes === null || msg.bytes !== this.lastPcmBytes ||
            typeof msg.id !== 'string' || !/^[0-9a-f-]{36}$/.test(msg.id)) throw Error('invalid_audio_receipt');
        // The PCM was accepted into the existing bounded queue/mark system.
        // This receipt is internal; no token or transcript reaches the carrier.
        this.lastPcmBytes = null;
        this.options.sessionSend(JSON.stringify({ type: 'audio_received', id: msg.id }));
      } else if (msg.type === 'ready') {
        this.audioReceipts = msg.audioReceipts === true;
        if (!this.started || this.ready || msg.mode !== 'realtime' || (msg.ttsMode === 'browser' && msg.greeting)) throw Error();
        // Legacy greeting PCM accepted before negotiation has no required
        // marker. Do not turn it into receipt debt retroactively. Playback and
        // carrier transport debt remain intact; subsequent pairs stay strict.
        if (this.audioReceipts) this.lastPcmBytes = null;
        this.ready = true; clearTimeout(this.startup);
        this.options.onReady?.();
      } else if (msg.type === 'flush') {
        this.controlReceiptPending = this.audioReceipts;
        this.stopPump();
        this.queue = []; this.marks.clear(); this.down.reset(); this.generation++;
        // FLUSH_MEDIA clears Asterisk's queue, not its queue_full/XOFF state.
        // Its dequeue loop subsequently emits XON; only that event may resume us.
        this.drained = false; this.drainPending = false;
        const barrier = this.transportDebt.sent(true, `${this.generation}:`);
        this.command('FLUSH_MEDIA'); this.command('MARK_MEDIA', barrier);
        if (this.ending) this.armDrain();
      } else if (msg.type === 'speaking') {
        this.controlReceiptPending = this.audioReceipts;
      } else if (msg.type === 'ending') {
        if (!this.ready) throw Error();
        if (!this.ending) { this.ending = true; this.deadline = setTimeout(() => this.close('drain_timeout'), 12000); }
        this.armDrain();
      } else if (msg.type === 'ended') this.close('session_ended');
      else if (msg.type === 'error') this.close('session_error');
    } catch { this.close('invalid_session_frame'); }
  }
  private enqueue(frames: string[]): void {
    if (this.queue.length + this.marks.size + frames.length > 500) throw Error('playback_overflow');
    this.queue.push(...frames); this.schedulePump();
  }
  private stopPump(): void {
    if (this.playback !== undefined) clearTimeout(this.playback);
    this.playback = undefined;
  }
  private schedulePump(): void {
    if (this.closed || this.paused || !this.queue.length || this.playback !== undefined) return;
    // Never write during the provider message/conversion loop. A bounded batch
    // every 20ms gives incoming XOFF/flush/socket events a turn before more media.
    // Asterisk still owns per-frame playout timing; each batch is at most 100ms.
    this.playback = setTimeout(() => this.pump(), 20);
  }
  private pump(): void {
    this.playback = undefined;
    if (this.closed || this.paused) return;
    try {
      for (let sent = 0; sent < 5 && !this.closed && !this.paused && this.queue.length; sent++) {
        const payload = atob(this.queue.shift()!);
        const bytes = Uint8Array.from(payload, char => char.charCodeAt(0));
        const mark = this.transportDebt.sent(false, `${this.generation}:`);
        this.marks.add(mark);
        this.options.carrierSend(bytes.buffer);
        this.command('MARK_MEDIA', mark);
      }
      this.maybeEnd();
      this.schedulePump();
    } catch { this.close('playback_error'); }
  }
  private armDrain(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => {
      try { this.drainPending = true; this.finishDrain(); this.maybeEnd(); }
      catch { this.close('playback_overflow'); }
    }, 200);
  }
  private finishDrain(): void {
    // finish() emits at most two FIR/padding frames. Keep that tail in the
    // resampler until real acknowledgements free capacity; sending merely
    // transfers a frame from queue to marks and does not free a slot.
    if (!this.drainPending || this.queue.length + this.marks.size > 498) return;
    this.enqueue(this.down.finish());
    this.drainPending = false; this.drained = true;
  }
  private maybeEnd(): void {
    if (this.ending && this.drained && !this.queue.length && !this.marks.size) this.close('playback_complete');
  }
  close(reason = 'socket_closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.stopPump();
    for (const timer of [this.startup, this.quiet, this.deadline]) if (timer) clearTimeout(timer);
    this.drainPending = false; this.queue = []; this.marks.clear(); this.up.reset(); this.down.reset();
    try { this.command('HANGUP'); } catch { /* disconnected */ }
    try { this.options.sessionSend(JSON.stringify({ type: 'hangup' })); } catch { /* disconnected */ }
    this.options.onEnd(reason);
  }
}
