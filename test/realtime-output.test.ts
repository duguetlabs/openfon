import { describe, expect, it } from 'vitest';
import { MAX_REALTIME_AUDIO_BYTES } from '../src/realtime-input';
import { RealtimeOutputBudget, RealtimeAudioQueue, RealtimeOutputError, MAX_REALTIME_RESPONSE_BYTES } from '../src/realtime-output';

const frame = Buffer.alloc(MAX_REALTIME_AUDIO_BYTES).toString('base64');

describe('realtime output admission before decode', () => {
  it('admits six exact-limit frames then refuses cumulative excess in the same turn', () => {
    const budget = new RealtimeOutputBudget(0);
    for (let i = 0; i < 6; i++) expect(budget.reserve(frame, 0)).toBe(480000);
    expect(() => budget.reserve('AAA=', 0)).toThrow(RealtimeOutputError);
  });
  it('retains the time allowance across response completions and clock rollback', () => {
    const budget = new RealtimeOutputBudget(1000);
    for (let i = 0; i < 6; i++) budget.reserve(frame, 1000);
    budget.responseDone();
    expect(() => budget.reserve(frame, 500)).toThrow(RealtimeOutputError);
    expect(budget.reserve(frame, 11000)).toBe(480000);
  });
  it('bounds a long response even when it arrives at ordinary playback speed', () => {
    const budget = new RealtimeOutputBudget(0);
    for (let i = 0; i < MAX_REALTIME_RESPONSE_BYTES / 480000; i++) budget.reserve(frame, i * 10000);
    expect(() => budget.reserve(frame, 60000)).toThrow(RealtimeOutputError);
    budget.responseDone();
    expect(budget.reserve(frame, 60000)).toBe(480000);
  });
  it('bounds tiny and empty delta work independently of bytes', () => {
    for (const encoded of ['', 'AAA=']) {
      const budget = new RealtimeOutputBudget(0);
      for (let i = 0; i < 400; i++) budget.reserve(encoded, 0);
      expect(() => budget.reserve(encoded, 0)).toThrow(RealtimeOutputError);
    }
  });
  it('allows bounded normal responses separated by time without a whole-call speech cutoff', () => {
    const budget = new RealtimeOutputBudget(0);
    for (let response = 0; response < 100; response++) {
      expect(budget.reserve(frame, response * 20000)).toBe(480000);
      budget.responseDone();
    }
  });
});

describe('response correlation and bounded metadata', () => {
  it('cannot reset identified output with wrong socket, wrong ID or unlabelled done', () => {
    const b = new RealtimeOutputBudget(0), old = {}, current = {};
    for (let i = 0; i < 6; i++) b.reserve(frame, i * 10000, current, 'r1');
    b.responseDone(old, 'r1'); b.responseDone(current, 'other'); b.responseDone(current);
    expect(() => b.reserve('AAA=', 60000, current, 'r1')).toThrow(RealtimeOutputError);
  });
  it('completed identified responses cannot reopen while new responses still work', () => {
    const b = new RealtimeOutputBudget(0), source = {};
    b.reserve('AAA=', 0, source, 'r1'); b.responseDone(source, 'r1');
    expect(() => b.reserve('AAA=', 0, source, 'r1')).toThrow(RealtimeOutputError);
    expect(b.reserve('AAA=', 0, source, 'r2')).toBe(2);
  });
  it('caps retained response IDs even if every response is completed immediately', () => {
    const b = new RealtimeOutputBudget(0), source = {};
    for (let i = 0; i < 256; i++) { b.reserve('', 0, source, String(i)); b.responseDone(source, String(i)); }
    expect(() => b.reserve('', 0, source, '257')).toThrow(RealtimeOutputError);
  });
});

describe('provider-independent PCM queue', () => {
  it('preserves bytes through arbitrary odd boundaries at bounded playout speed', () => {
    const queue = new RealtimeAudioQueue(0);
    const input = Uint8Array.from({ length: 48001 }, (_, i) => i % 251);
    queue.push(input.slice(0, 17).buffer); queue.push(input.slice(17).buffer);
    const output: number[] = [];
    for (let now = 0; now <= 1100; now += 100) {
      let audio: ArrayBuffer | undefined;
      while ((audio = queue.take(now))) output.push(...new Uint8Array(audio));
      expect(output.length).toBeLessThanOrEqual(24000 + now * 48);
    }
    expect(output).toEqual(Array.from(input)); expect(queue.pending).toBe(false);
  });
  it('bounds queued memory independently of elapsed time and response resets', () => {
    const queue = new RealtimeAudioQueue(0);
    queue.push(new ArrayBuffer(MAX_REALTIME_RESPONSE_BYTES));
    expect(() => queue.push(new ArrayBuffer(1))).toThrow(RealtimeOutputError);
    expect(queue.take(1_000_000)?.byteLength).toBe(24000); // no catch-up burst
    expect(queue.take(999_000)).toBeUndefined(); // rollback mints nothing
    queue.clear();
    queue.push(new ArrayBuffer(2));
    expect(queue.take(1_000_000)).toBeUndefined(); // flush mints nothing
    expect(queue.take(1_000_100)?.byteLength).toBe(2);
  });
  it('bounds tiny queued frame metadata', () => {
    const queue = new RealtimeAudioQueue(0);
    for (let i = 0; i < 4096; i++) queue.push(new ArrayBuffer(1));
    expect(() => queue.push(new ArrayBuffer(1))).toThrow(RealtimeOutputError);
  });
});
