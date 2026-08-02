import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallSession } from '../src/call-session';

// finalize() decides two fields that have to agree — the row's status and its
// summary — from one recorded failure. These drive the real method rather than
// an extracted rule, because both defects here were in how the pieces were
// wired together (a summary assigned after the diagnostic, a status passed by a
// caller that didn't know one had been recorded) rather than in any one of them.

interface Bound {
  sql: string;
  args: unknown[];
}

function fakeEnv(calls: Bound[]) {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            calls.push({ sql, args });
            return {
              first: async () => (sql.startsWith('SELECT started_at') ? { started_at: '2026-06-12 10:00:00' } : null),
              run: async () => ({}),
            };
          },
        };
      },
    },
    DEFAULT_LLM_BASE_URL: 'https://api.example.com/v1',
    DEFAULT_LLM_MODEL: 'm',
    DEFAULT_LLM_API_KEY: 'k',
  };
}

// A conversation long enough that finalize runs summary generation.
const HISTORY = [
  { role: 'system', content: 'you are an agent' },
  { role: 'assistant', content: 'Good morning, Riverside Dental.' },
  { role: 'user', content: 'I would like to book a cleaning.' },
  { role: 'assistant', content: 'Of course — how about Friday?' },
];

function session(failure: string | null) {
  const calls: Bound[] = [];
  const s = new CallSession({} as never, fakeEnv(calls) as never);
  Object.assign(s, { callId: 'call-1', history: HISTORY, settings: { language: 'en' }, failure });
  return { s: s as unknown as { finalize(): Promise<void> }, calls };
}

function written(calls: Bound[]): { status: string | null; summary: string | null } {
  const update = calls.find((c) => c.sql.startsWith('UPDATE calls'));
  return { status: (update?.args[0] ?? null) as string | null, summary: (update?.args[2] ?? null) as string | null };
}

describe('finalize', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubSummary(text: string) {
    const body = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: text, intent: 'booking' }) } }] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
  }

  it('marks the row failed and keeps the diagnostic, even mid-conversation', async () => {
    // The failure lands after a real exchange — TTS rejecting once the LLM has
    // already replied — so the socket closes on the ordinary path and summary
    // generation still runs. Both used to go wrong here: the generated text
    // overwrote the diagnostic, and the row was recorded as a successful call.
    stubSummary('Caller booked a cleaning for Friday.');
    const { s, calls } = session('Call failed: Error: TTS error 503');
    await s.finalize();
    const { status, summary } = written(calls);
    // Status and summary have to agree — stats read 'completed'.
    expect(status).toBe('failed');
    expect(summary).toContain('TTS error 503');
    expect(summary).toContain('Caller booked a cleaning for Friday.');
    // The failure leads: the call log truncates this row.
    expect(summary?.startsWith('Call failed:')).toBe(true);
  });

  it('records the failure alone when summary generation also fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const { s, calls } = session('Call failed: Error: LLM error 500');
    await s.finalize();
    expect(written(calls)).toEqual({ status: 'failed', summary: 'Call failed: Error: LLM error 500' });
  });

  it('leaves an ordinary call completed, with its summary untouched', async () => {
    stubSummary('Caller booked a cleaning for Friday.');
    const { s, calls } = session(null);
    await s.finalize();
    expect(written(calls)).toEqual({ status: 'completed', summary: 'Caller booked a cleaning for Friday.' });
  });
});
