/** Mono raw PCMU/8000 ↔ signed PCM16 little-endian/24000. No RTP headers.
 * Per-call instances retain FIR/decimation state across packets. Call reset()
 * on interruption/discontinuity; never share instances between calls.
 */
export const MAX_PCMU_BYTES = 1600; // 200 ms; application bound, not a carrier guarantee
export const MAX_PCM24_BYTES = 9600; // 200 ms
export const PCMU_FRAME_BYTES = 160; // 20 ms outbound frames

export function decodePcmuSample(byte: number): number {
  if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new RangeError('Invalid PCMU byte');
  const value = byte ^ 255;
  const magnitude = (((value & 15) << 3) + 132) << ((value >>> 4) & 7);
  return (value & 128) ? 132 - magnitude : magnitude - 132;
}

/** G.711 quantization, including negative one's-complement adjustment.
 * Reference: https://chromium.googlesource.com/external/webrtc/stable/src/+/master/modules/audio_coding/codecs/g711/g711.h
 */
export function encodePcmuSample(sample: number): number {
  if (!Number.isFinite(sample)) throw new RangeError('Invalid PCM sample');
  const pcm = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const magnitude = pcm < 0 ? 131 - pcm : 132 + pcm;
  const segment = Math.floor(Math.log2(magnitude)) - 7;
  const code = segment >= 8 ? 127 : (segment << 4) | ((magnitude >>> (segment + 3)) & 15);
  return code ^ (pcm < 0 ? 127 : 255);
}

/** Strict canonical, padded standard base64. Reject before allocating large data. */
export function decodePcmuFrame(payload: unknown): Uint8Array {
  if (typeof payload !== 'string' || !payload.length || payload.length > 4 * Math.ceil(MAX_PCMU_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
    throw new RangeError('Invalid PCMU base64 frame');
  }
  const binary = atob(payload);
  if (!binary.length || binary.length > MAX_PCMU_BYTES || btoa(binary) !== payload) throw new RangeError('Invalid PCMU frame length or padding');
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export function encodePcmuFrame(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_PCMU_BYTES) throw new RangeError('Invalid PCMU frame length');
  return btoa(String.fromCharCode(...bytes));
}

// 63-tap Hamming-windowed sinc at 3.4 kHz: suppress images/aliases around
// the 8 kHz Nyquist boundary. Causal delay is 31/24000 s in each direction.
// History starts at silence. Inbound end/reset discards the filter tail.
// Outbound finish drains it; reset discards it for immediate interruption.
const TAPS = 63;
const coefficients = (() => {
  const values = Array.from({ length: TAPS }, (_, i) => {
    const x = i - (TAPS - 1) / 2;
    const sinc = x === 0 ? 2 * 3400 / 24000 : Math.sin(2 * Math.PI * 3400 / 24000 * x) / (Math.PI * x);
    return sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (TAPS - 1)));
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map(value => value / total);
})();
class Filter {
  private history = new Float64Array(TAPS);
  private cursor = 0;
  push(value: number): number {
    this.history[this.cursor] = value;
    let result = 0;
    for (let i = 0; i < TAPS; i++) result += coefficients[i] * this.history[(this.cursor - i + TAPS) % TAPS];
    this.cursor = (this.cursor + 1) % TAPS;
    return result;
  }
  reset(): void { this.history.fill(0); this.cursor = 0; }
}

export class Pcmu8ToPcm24 {
  private filter = new Filter();
  /** Returns exactly 6 bytes per PCMU sample. Validation precedes state changes. */
  push(payload: unknown): Uint8Array {
    const bytes = decodePcmuFrame(payload);
    const result = new Uint8Array(bytes.length * 6);
    const view = new DataView(result.buffer);
    let offset = 0;
    for (const byte of bytes) {
      const sample = decodePcmuSample(byte);
      for (let phase = 0; phase < 3; phase++) {
        const value = this.filter.push(phase === 0 ? sample * 3 : 0);
        view.setInt16(offset, Math.max(-32768, Math.min(32767, Math.round(value))), true);
        offset += 2;
      }
    }
    return result;
  }
  reset(): void { this.filter.reset(); }
}

export class Pcm24ToPcmu8 {
  private filter = new Filter();
  private phase = 0;
  private pending = new Uint8Array(PCMU_FRAME_BYTES);
  private count = 0;
  private hasInput = false;
  /** Accepts 1..4800 complete PCM16LE samples; emits only 160-byte base64
   * frames. Up to 2 samples and 159 PCMU bytes carry over to the next push.
   * Returned frames still require transport pacing; do not burst them blindly.
   */
  push(pcm: Uint8Array): string[] {
    if (!(pcm instanceof Uint8Array) || !pcm.length || pcm.length > MAX_PCM24_BYTES || pcm.length % 2) throw new RangeError('Invalid PCM24 frame length');
    this.hasInput = true;
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const frames: string[] = [];
    for (let offset = 0; offset < pcm.length; offset += 2) {
      const value = this.filter.push(view.getInt16(offset, true));
      this.phase++;
      if (this.phase !== 3) continue;
      this.phase = 0;
      this.pending[this.count++] = encodePcmuSample(value);
      if (this.count === PCMU_FRAME_BYTES) {
        frames.push(encodePcmuFrame(this.pending));
        this.count = 0;
      }
    }
    return frames;
  }
  /** Natural end: drains the FIR tail and pads the last 20 ms frame with
   * PCMU silence, returning at most two frames. Resets for the next utterance.
   * For barge-in/cancellation use reset(), which emits nothing.
   */
  finish(): string[] {
    if (!this.hasInput) return [];
    const frames = this.push(new Uint8Array(TAPS * 2));
    if (this.count) {
      this.pending.fill(255, this.count);
      frames.push(encodePcmuFrame(this.pending));
    }
    this.reset();
    return frames;
  }
  reset(): void { this.filter.reset(); this.phase = 0; this.count = 0; this.hasInput = false; this.pending.fill(255); }
}
