import { afterEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { azureVoicePreview } from '../src/managed-voice-preview';
import { generateManagedVoicePreview } from '../src/voice-preview';
import { SqliteD1, applyMigrations } from './sqlite-d1';
import type { Env } from '../src/types';
const env = {
  OPENFON_MANAGED_WEB: 'true',
  AZURE_OPENAI_ENDPOINT: 'https://fixture.cognitiveservices.azure.com/',
  AZURE_OPENAI_API_KEY: 'synthetic',
} as Env;
class Socket {
  listeners = new Map<string, Array<(event: any) => void>>();
  accept() {}
  send() {}
  close() {
    for (const fn of this.listeners.get('close') ?? []) fn({});
  }
  addEventListener(name: string, fn: (event: any) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  receive(value: unknown) {
    for (const fn of this.listeners.get('message') ?? [])
      fn({ data: JSON.stringify(value) });
  }
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const start = (socket: Socket, id = 'preview_1') =>
  socket.receive({
    type: 'session.started',
    session: {
      id,
      model: 'gpt-live-1',
      audio: {
        format: { type: 'audio/pcm', rate: 24000 },
        output: { voice: 'cedar' },
      },
    },
  });
const audio = (socket: Socket) => {
  const speech = Buffer.alloc(4800);
  for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(6000, i);
  socket.receive({
    type: 'session.output_audio.delta',
    delta: speech.toString('base64'),
  });
  for (let i = 0; i < 8; i++)
    socket.receive({
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(4800).toString('base64'),
    });
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const cases = [
  {
    name: 'missing terminal',
    updates: [1.5],
    terminal: undefined,
    seconds: 1.5,
    final: false,
  },
  {
    name: 'invalid terminal',
    updates: [1.5],
    terminal: 'unknown',
    seconds: 1.5,
    final: false,
  },
  {
    name: 'overprecision terminal',
    updates: [1.5],
    terminal: 1.2345678912,
    seconds: 1.5,
    final: false,
  },
  {
    name: 'regressing terminal',
    updates: [5, 4],
    terminal: 2,
    seconds: 5,
    final: false,
  },
  {
    name: 'duplicate cumulative updates',
    updates: [1, 2, 2, 1],
    terminal: 3,
    seconds: 3,
    final: true,
  },
  {
    name: 'equal terminal',
    updates: [5],
    terminal: 5,
    seconds: 5,
    final: true,
  },
  { name: 'actual zero', updates: [], terminal: 0, seconds: 0, final: true },
  {
    name: 'no numeric evidence',
    updates: [-1, 'unknown'],
    terminal: undefined,
    seconds: undefined,
    final: true,
  },
];
for (const fixture of cases)
  it(`preview preserves honest cumulative evidence: ${fixture.name}`, async () => {
    const socket = new Socket(),
      observations: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 101, webSocket: socket }))
    );
    const sample = azureVoicePreview(
      env,
      { voice: 'cedar', language: 'en' },
      new AbortController().signal,
      async (value) => {
        observations.push(value);
      }
    );
    await tick();
    start(socket);
    for (const seconds of fixture.updates)
      socket.receive({ type: 'session.usage.updated', usage: { seconds } });
    audio(socket);
    socket.receive({
      type: 'session.closed',
      usage: { seconds: fixture.terminal },
    });
    expect(new TextDecoder().decode((await sample).slice(0, 4))).toBe('RIFF');
    expect(observations).toEqual([
      {
        sessionId: 'preview_1',
        ...(fixture.seconds === undefined ? {} : { seconds: fixture.seconds }),
        final: fixture.final,
      },
    ]);
  });
for (const mismatch of [
  'before drain',
  'during drain',
  'explicit usage identity',
])
  it(`preview rejects session identity change ${mismatch} without mixing usage`, async () => {
    const socket = new Socket(),
      observations: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 101, webSocket: socket }))
    );
    const sample = azureVoicePreview(
      env,
      { voice: 'cedar', language: 'en' },
      new AbortController().signal,
      async (value) => {
        observations.push(value);
      }
    );
    const result = sample.then(
      () => ({ ok: true }),
      () => ({ ok: false })
    );
    await tick();
    start(socket);
    socket.receive({ type: 'session.usage.updated', usage: { seconds: 2 } });
    if (mismatch === 'during drain') audio(socket);
    if (mismatch === 'explicit usage identity')
      socket.receive({
        type: 'session.usage.updated',
        session_id: 'other_session',
        usage: { seconds: 50 },
      });
    else start(socket, 'other_session');
    if (mismatch !== 'during drain') audio(socket);
    socket.receive({ type: 'session.closed', usage: { seconds: 50 } });
    expect(await result).toEqual({ ok: false });
    expect(observations).toEqual([
      { sessionId: 'preview_1', seconds: 2, final: false },
    ]);
  });
it('actual preview recorder retains one measured cumulative quantity without marking incomplete seconds final', async () => {
  const db = new SqliteD1(),
    socket = new Socket();
  try {
    applyMigrations(db);
    db.exec(readFileSync('migrations/0027_commercial.sql', 'utf8'));
    db.exec(
      "INSERT INTO users(id,email,password_hash) VALUES('u','u@example.invalid','unused');INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','Business')"
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 101, webSocket: socket }))
    );
    const sample = generateManagedVoicePreview(
      { ...env, DB: db as unknown as D1Database },
      { voice: 'cedar', language: 'en' },
      new AbortController().signal,
      { businessId: 'b', operationId: 'op' }
    );
    await tick();
    start(socket);
    for (const seconds of [1.25, 3.125, 3.125])
      socket.receive({ type: 'session.usage.updated', usage: { seconds } });
    audio(socket);
    socket.receive({ type: 'session.closed' });
    await sample;
    expect(
      db.database
        .prepare(
          'SELECT metric,value,is_final FROM commercial_provider_metrics'
        )
        .all()
    ).toEqual([
      { metric: 'voiceSessionNanoseconds', value: 3125000000, is_final: 0 },
    ]);
    expect(
      db.database
        .prepare('SELECT count(*) n FROM commercial_provider_observations')
        .get()
    ).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});
