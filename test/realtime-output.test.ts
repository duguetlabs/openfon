import { describe, expect, it } from 'vitest';
import { MAX_REALTIME_AUDIO_BYTES } from '../src/realtime-input';
import { RealtimeOutputBudget, RealtimeOutputError, MAX_REALTIME_RESPONSE_BYTES } from '../src/realtime-output';

const frame = Buffer.alloc(MAX_REALTIME_AUDIO_BYTES).toString('base64');

describe('realtime output admission before decode', () => {
  it('admits two exact-limit frames then refuses cumulative excess in the same turn', () => {
    const budget = new RealtimeOutputBudget(0);
    expect(budget.reserve(frame, 0)).toBe(480000);
    expect(budget.reserve(frame, 0)).toBe(480000);
    expect(() => budget.reserve('AAA=', 0)).toThrow(RealtimeOutputError);
  });
  it('retains the time allowance across response completions and clock rollback', () => {
    const budget = new RealtimeOutputBudget(1000);
    budget.reserve(frame, 1000); budget.reserve(frame, 1000);
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
