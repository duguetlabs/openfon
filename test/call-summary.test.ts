import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallSession } from '../src/call-session';

// finalize() writes one summary column that two things want: the failure
// recorded by failInternally, and the generated conversation summary. These
// drive the real method rather than a extracted rule, because the defect this
// pins was in the *ordering* of those two writers, not in either one.

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
  return { s: s as unknown as { finalize(status?: 'completed' | 'failed'): Promise<void> }, calls };
}

function summaryWritten(calls: Bound[]): string | null {
  const update = calls.find((c) => c.sql.startsWith('UPDATE calls'));
  return (update?.args[2] ?? null) as string | null;
}

describe('finalize', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubSummary(text: string) {
    const body = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: text, intent: 'booking' }) } }] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
  }

  it('keeps the recorded failure even when a summary is generated over it', async () => {
    // The failure lands after a real exchange — TTS rejecting once the LLM has
    // already replied — so summary generation still runs and used to overwrite
    // the diagnostic, leaving the owner an ordinary-looking successful call.
    stubSummary('Caller booked a cleaning for Friday.');
    const { s, calls } = session('Call failed: Error: TTS error 503');
    await s.finalize();
    const summary = summaryWritten(calls);
    expect(summary).toContain('TTS error 503');
    expect(summary).toContain('Caller booked a cleaning for Friday.');
    // The failure leads: the call log truncates this row.
    expect(summary?.startsWith('Call failed:')).toBe(true);
  });

  it('records the failure alone when summary generation also fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const { s, calls } = session('Call failed: Error: LLM error 500');
    await s.finalize();
    expect(summaryWritten(calls)).toBe('Call failed: Error: LLM error 500');
  });

  it('leaves the summary of an ordinary call untouched', async () => {
    stubSummary('Caller booked a cleaning for Friday.');
    const { s, calls } = session(null);
    await s.finalize();
    expect(summaryWritten(calls)).toBe('Caller booked a cleaning for Friday.');
  });
});
