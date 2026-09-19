import { describe, expect, it } from 'vitest';
import { RealtimeClosingGuard } from '../src/call-closing';

describe('closing generation barrier', () => {
  it('a tool-only response requests one farewell after completion', () => {
    const g = new RealtimeClosingGuard(), s = {};
    g.created(s, 'tool'); g.request(s, 'tool');
    expect(g.advance()).toBe('wait');
    g.done(s, 'tool', 'completed'); expect(g.advance()).toBe('generate');
    expect(g.advance()).toBe('wait');
    g.created(s, 'bye'); g.audio(s, 'bye', 48); g.transcript(s, 'bye', 'Que tenga un buen día.');
    expect(g.advance()).toBe('wait');
    g.done(s, 'bye', 'completed'); expect(g.advance()).toBe('ready');
    expect(g.accepts(s, 'bye')).toBe(false);
  });
  it('reuses a completed farewell, including completion before the tool event', () => {
    const g = new RealtimeClosingGuard(), s = {};
    g.audio(s, 'bye', 48); g.transcript(s, 'bye', 'Hasta luego.'); g.done(s, 'bye', 'completed');
    g.request(s, 'bye'); expect(g.advance()).toBe('ready');
  });
  it('reuses the farewell when a separate tool response follows in the same caller turn', () => {
    const g = new RealtimeClosingGuard(), s = {};
    g.audio(s, 'bye', 48); g.transcript(s, 'bye', 'Goodbye.'); g.done(s, 'bye', 'completed');
    g.created(s, 'tool'); g.request(s, 'tool'); expect(g.advance()).toBe('wait');
    g.done(s, 'tool', 'completed'); expect(g.advance()).toBe('ready');
  });
  it('does not confuse an old greeting or another socket with the closing response', () => {
    const g = new RealtimeClosingGuard(), s = {}, other = {};
    g.audio(s, 'old', 48); g.transcript(s, 'old', 'Goodbye'); g.done(s, 'old', 'completed');
    g.startTurn(s); g.request(s, 'old'); expect(g.advance()).toBe('generate');
    expect(g.accepts(other, 'bye')).toBe(false); expect(g.accepts(s, 'old')).toBe(false);
    g.done(other, 'bye', 'completed'); expect(g.advance()).toBe('wait');
  });
  it.each(['empty', 'cancelled'])('does not loop on a %s replacement', kind => {
    const g = new RealtimeClosingGuard(), s = {};
    g.request(s); g.done(s, undefined, 'completed'); expect(g.advance()).toBe('generate');
    g.created(s, 'bye');
    if (kind === 'cancelled') { g.audio(s, 'bye', 48); g.transcript(s, 'bye', 'Goodbye'); }
    g.done(s, 'bye', kind === 'cancelled' ? 'cancelled' : 'completed');
    expect(g.advance()).toBe('failed'); expect(g.advance()).toBe('wait');
  });
  it('supports a serial gateway without response IDs', () => {
    const g = new RealtimeClosingGuard(), s = {};
    g.created(s, undefined); g.request(s); g.done(s, undefined, undefined);
    expect(g.advance()).toBe('generate');
    g.audio(s, undefined, 48); g.transcript(s, undefined, 'Adiós.'); g.done(s, undefined, undefined);
    expect(g.advance()).toBe('ready');
  });
});
