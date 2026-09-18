import { MAX_REALTIME_AUDIO_BASE64 } from './realtime-input';

// PCM16 mono at 24 kHz. Permit a response to arrive ahead of playback without
// allowing successive response IDs, flushes or upstream rotations to mint more
// output credit. These are per-call constants, not provider-supplied limits.
export const REALTIME_PCM_BYTES_PER_SECOND = 48000;
// Generation may be much faster than playback. Admission permits one bounded
// minute ahead; a separate pacer below controls what reaches the receiver.
export const REALTIME_AUDIO_BURST_BYTES = 60 * REALTIME_PCM_BYTES_PER_SECOND;
export const MAX_REALTIME_RESPONSE_BYTES = 60 * REALTIME_PCM_BYTES_PER_SECOND;
export const REALTIME_AUDIO_EVENT_BURST = 400;
export const REALTIME_AUDIO_EVENTS_PER_SECOND = 100;

export class RealtimeOutputError extends Error {
  constructor() { super('Realtime audio output limit exceeded or caller not receiving audio'); }
}

/** Constant-space admission. Charge BEFORE decoding, including empty deltas. */
export class RealtimeOutputBudget {
  private bytes = REALTIME_AUDIO_BURST_BYTES;
  private events = REALTIME_AUDIO_EVENT_BURST;
  private responses = new WeakMap<object, Map<string, { bytes: number; done: boolean }>>();
  private responseCount = 0;
  private updatedAt: number;

  constructor(now: number) { this.updatedAt = now; }

  reserve(encoded: string, now: number, source: object = this, responseId?: unknown): number {
    if (responseId !== undefined && (typeof responseId !== 'string' || !responseId || responseId.length > 128)) throw new RealtimeOutputError();
    const key = responseId === undefined ? '' : responseId as string;
    let responses = this.responses.get(source);
    let response = responses?.get(key);
    if (!response) {
      // Retain bounded tombstones, so done+same ID cannot restart a response.
      // Unlabelled gateway streams use one segment per socket instead.
      if (this.responseCount >= 256) throw new RealtimeOutputError();
      this.responseCount++;
      if (!responses) { responses = new Map(); this.responses.set(source, responses); }
      response = { bytes: 0, done: false }; responses.set(key, response);
    }
    if (response.done) throw new RealtimeOutputError();
    if (typeof encoded !== 'string' || encoded.length > MAX_REALTIME_AUDIO_BASE64) throw new RealtimeOutputError();
    // Upper bound without allocating/decoding. Padding is the only discounted
    // input; embedded whitespace is charged, so it cannot bypass admission.
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const bytes = Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
    const elapsed = Math.max(0, now - this.updatedAt);
    this.updatedAt = Math.max(this.updatedAt, now); // rollback never mints credit
    this.bytes = Math.min(REALTIME_AUDIO_BURST_BYTES, this.bytes + elapsed * REALTIME_PCM_BYTES_PER_SECOND / 1000);
    this.events = Math.min(REALTIME_AUDIO_EVENT_BURST, this.events + elapsed * REALTIME_AUDIO_EVENTS_PER_SECOND / 1000);
    if (this.events < 1 || bytes > this.bytes || response.bytes + bytes > MAX_REALTIME_RESPONSE_BYTES) {
      throw new RealtimeOutputError();
    }
    this.events--;
    this.bytes -= bytes;
    response.bytes += bytes;
    return bytes;
  }

  control(now: number): void {
    const elapsed = Math.max(0, now - this.updatedAt);
    this.updatedAt = Math.max(this.updatedAt, now);
    this.bytes = Math.min(REALTIME_AUDIO_BURST_BYTES, this.bytes + elapsed * REALTIME_PCM_BYTES_PER_SECOND / 1000);
    this.events = Math.min(REALTIME_AUDIO_EVENT_BURST, this.events + elapsed * REALTIME_AUDIO_EVENTS_PER_SECOND / 1000);
    if (this.events < 1) throw new RealtimeOutputError();
    this.events--;
  }

  responseDone(source: object = this, responseId?: unknown): void {
    if (responseId !== undefined && (typeof responseId !== 'string' || !responseId || responseId.length > 128)) return;
    const response = this.responses.get(source)?.get(responseId === undefined ? '' : responseId as string);
    if (!response) return; // unmatched completion cannot allocate or reset state
    if (responseId === undefined) response.bytes = 0;
    else response.done = true;
    // Missing-ID legacy gateway events define only a same-socket segment, not
    // a provable provider response. Neither form resets global byte/event or
    // receipt credit. Identified completed responses cannot be reopened.
  }
}

// Receipt means the downstream consumer accepted the bytes into its bounded
// playback buffer, not that a human heard them. Never refill this window by time.
export const MAX_UNRECEIVED_AUDIO_BYTES = 960000;
export const MAX_UNRECEIVED_AUDIO_FRAMES = 128;
export const AUDIO_RECEIPT_TIMEOUT_MS = 10000;

export class RealtimeAudioReceipts {
  private pending: { id: string; bytes: number; deadline: number }[] = [];
  private bytes = 0;

  check(bytes: number, additionalFrames = 0): void {
    if (this.bytes + bytes > MAX_UNRECEIVED_AUDIO_BYTES ||
        this.pending.length + additionalFrames >= MAX_UNRECEIVED_AUDIO_FRAMES) throw new RealtimeOutputError();
  }

  sent(bytes: number, now: number): string {
    this.check(bytes);
    const id = crypto.randomUUID();
    this.pending.push({ id, bytes, deadline: now + AUDIO_RECEIPT_TIMEOUT_MS });
    this.bytes += bytes;
    return id;
  }

  acknowledge(id: unknown, now: number): void {
    const first = this.pending[0];
    if (typeof id !== 'string' || id.length > 64 || !first || first.id !== id || now >= first.deadline) {
      throw new RealtimeOutputError();
    }
    this.bytes -= first.bytes;
    this.pending.shift();
  }

  get deadline(): number | undefined { return this.pending[0]?.deadline; }
  clear(): void { this.pending = []; this.bytes = 0; }
}

// Existing receivers acknowledge admission, not playback. Pace every provider's
// PCM on the server, independent of chunk size/model, keeping only 500ms ahead
// of wall time. Receiver-side byte/source bounds still cover suspended playback.
export const REALTIME_PLAYOUT_WINDOW_BYTES = REALTIME_PCM_BYTES_PER_SECOND / 2;
export class RealtimeAudioQueue {
  private frames: { audio: ArrayBuffer; offset: number }[] = [];
  private bytes = 0;
  private credit = REALTIME_PLAYOUT_WINDOW_BYTES;
  private updatedAt: number;
  constructor(now: number) { this.updatedAt = now; }

  check(bytes: number): void {
    if (this.bytes + bytes > MAX_REALTIME_RESPONSE_BYTES || this.frames.length >= 4096) throw new RealtimeOutputError();
  }
  push(audio: ArrayBuffer): void {
    if (!audio.byteLength) return;
    this.check(audio.byteLength);
    this.frames.push({ audio, offset: 0 }); this.bytes += audio.byteLength;
  }
  take(now: number): ArrayBuffer | undefined {
    const elapsed = Math.max(0, now - this.updatedAt);
    this.updatedAt = Math.max(now, this.updatedAt);
    this.credit = Math.min(REALTIME_PLAYOUT_WINDOW_BYTES, this.credit + elapsed * REALTIME_PCM_BYTES_PER_SECOND / 1000);
    const frame = this.frames[0];
    if (!frame || this.credit < 2) return;
    const length = Math.min(frame.audio.byteLength - frame.offset, Math.floor(this.credit / 2) * 2);
    const audio = frame.audio.slice(frame.offset, frame.offset + length);
    frame.offset += length; this.bytes -= length; this.credit -= length;
    if (frame.offset === frame.audio.byteLength) this.frames.shift();
    return audio;
  }
  get pending(): boolean { return this.frames.length > 0; }
  clear(): void { this.frames = []; this.bytes = 0; } // flush never creates rate credit
}
