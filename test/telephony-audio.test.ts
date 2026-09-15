import { describe, expect, it } from 'vitest';
import { decodePcmuSample, encodePcmuSample, decodePcmuFrame, encodePcmuFrame, Pcmu8ToPcm24, Pcm24ToPcmu8, MAX_PCMU_BYTES, MAX_PCM24_BYTES } from '../src/telephony-audio';

const pcm = (samples: number[]) => {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((value, i) => view.setInt16(i * 2, value, true));
  return bytes;
};
const join = (parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(part => [...part]));

describe('telephony audio', () => {
  it('matches G.711 reference vectors, both zero codes, extrema and clipping', () => {
    for (const [code, sample] of [[255, 0], [127, 0], [254, 8], [126, -8], [128, 32124], [0, -32124], [191, 1980], [63, -1980]]) {
      expect(decodePcmuSample(code)).toBe(sample);
      if (code !== 127) expect(encodePcmuSample(sample)).toBe(code);
    }
    expect(encodePcmuSample(-1)).toBe(127);
    expect(encodePcmuSample(1e10)).toBe(128);
    expect(encodePcmuSample(-1e10)).toBe(0);
    for (let code = 0; code < 256; code++) expect(encodePcmuSample(decodePcmuSample(code))).toBe(code === 127 ? 255 : code);
  });

  it('rejects malformed, noncanonical and oversized frames', () => {
    for (const bad of [null, 123, '', 'A', 'AAA', '====', 'AA=A', 'AA==\n', '-A==', '_A==', 'AB==', 'AAB=', '☃===', 'A'.repeat(2136)]) {
      expect(() => decodePcmuFrame(bad)).toThrow(RangeError);
    }
    for (const count of [1, 2, 160, MAX_PCMU_BYTES]) {
      const bytes = new Uint8Array(count).fill(255);
      expect(decodePcmuFrame(encodePcmuFrame(bytes))).toEqual(bytes);
    }
    expect(() => encodePcmuFrame(new Uint8Array(1601))).toThrow();
    for (const bad of [NaN, Infinity, -Infinity]) expect(() => encodePcmuSample(bad)).toThrow();
    for (const bad of [-1, 256, 1.2, NaN]) expect(() => decodePcmuSample(bad)).toThrow();
  });

  it('keeps exact upsample count and bit-identical continuity across arbitrary chunks', () => {
    const input = Uint8Array.from({ length: 1000 }, (_, i) => (i * 71) % 256);
    const whole = new Pcmu8ToPcm24().push(encodePcmuFrame(input));
    const stream = new Pcmu8ToPcm24();
    const parts: Uint8Array[] = [];
    for (let i = 0; i < input.length; i += 7) parts.push(stream.push(encodePcmuFrame(input.slice(i, i + 7))));
    expect(join(parts)).toEqual(whole);
    expect(whole.length).toBe(6000);
  });

  it('preserves decimation phase, subarray offsets and partial packets across chunks', () => {
    const input = pcm(Array.from({ length: 4799 }, (_, i) => Math.round(17000 * Math.sin(i * 0.13))));
    const whole = new Pcm24ToPcmu8();
    const expected = [...whole.push(input), ...whole.push(pcm([0]))];
    const stream = new Pcm24ToPcmu8();
    const actual: string[] = [];
    for (let i = 0; i < input.length; i += 14) actual.push(...stream.push(input.subarray(i, i + 14)));
    actual.push(...stream.push(pcm([0])));
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(10);
    expect(actual.every(frame => decodePcmuFrame(frame).length === 160)).toBe(true);
  });

  it('keeps silence silent and clears retained audio on interruption', () => {
    const up = new Pcmu8ToPcm24();
    expect(up.push(encodePcmuFrame(new Uint8Array(160).fill(255)))).toEqual(new Uint8Array(960));
    up.push(encodePcmuFrame(new Uint8Array(160)));
    up.reset();
    expect(up.push('fw==')).toEqual(new Uint8Array(6));
    const down = new Pcm24ToPcmu8();
    down.push(pcm(new Array(479).fill(20000)));
    down.reset();
    expect(down.push(new Uint8Array(960))).toEqual([encodePcmuFrame(new Uint8Array(160).fill(255))]);
  });

  it('drains a natural end into bounded complete frames once and resets the filter', () => {
    const down = new Pcm24ToPcmu8();
    expect(down.finish()).toEqual([]);
    down.push(pcm(new Array(479).fill(16000)));
    const tail = down.finish();
    expect(tail).toHaveLength(2);
    expect(tail.every(frame => decodePcmuFrame(frame).length === 160)).toBe(true);
    expect([...decodePcmuFrame(tail[1]).slice(22)].every(byte => byte === 255)).toBe(true);
    expect(down.finish()).toEqual([]);
    expect(down.push(new Uint8Array(960))).toEqual([encodePcmuFrame(new Uint8Array(160).fill(255))]);
  });

  it('rejects PCM lengths before changing stream state and bounds maximum output', () => {
    const down = new Pcm24ToPcmu8();
    down.push(pcm([1000, 2000]));
    for (const bad of [new Uint8Array(), new Uint8Array(3), new Uint8Array(MAX_PCM24_BYTES + 2)]) expect(() => down.push(bad)).toThrow();
    const control = new Pcm24ToPcmu8();
    control.push(pcm([1000, 2000]));
    expect(down.push(new Uint8Array(MAX_PCM24_BYTES))).toEqual(control.push(new Uint8Array(MAX_PCM24_BYTES)));
    expect(new Pcmu8ToPcm24().push(encodePcmuFrame(new Uint8Array(MAX_PCMU_BYTES))).length).toBe(MAX_PCM24_BYTES);
  });

  it('attenuates above-Nyquist content before decimation while retaining speech frequencies', () => {
    const rms = (frequency: number) => {
      const frames = new Pcm24ToPcmu8().push(pcm(Array.from({ length: 4800 }, (_, i) => Math.round(16000 * Math.sin(2 * Math.PI * frequency * i / 24000)))));
      const values = frames.flatMap(frame => [...decodePcmuFrame(frame)].map(decodePcmuSample)).slice(100);
      return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    };
    expect(rms(1000)).toBeGreaterThan(10000);
    expect(rms(6000)).toBeLessThan(rms(1000) / 100);
  });

  it('handles deterministic fuzz packets without non-finite output or size drift', () => {
    let seed = 12345;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const up = new Pcmu8ToPcm24();
    const down = new Pcm24ToPcmu8();
    let samples = 0;
    let frames = 0;
    for (let iteration = 0; iteration < 100; iteration++) {
      const input = Uint8Array.from({ length: next() % 1600 + 1 }, () => next() & 255);
      const output = up.push(encodePcmuFrame(input));
      expect(output.length).toBe(input.length * 6);
      frames += down.push(output).length;
      samples += input.length;
    }
    expect(frames).toBe(Math.floor(samples / 160));
  });
});
