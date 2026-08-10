import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { applyMigrations, SqliteD1 } from './sqlite-d1';

function makeEnv(db: SqliteD1): Env {
  return {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: () => Promise.resolve(new Response('not found', { status: 404 })) } as Fetcher,
    CALL_SESSION: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: () => Promise.resolve(new Response(null, { status: 200 })) }),
    } as unknown as DurableObjectNamespace,
    DEFAULT_LLM_BASE_URL: 'https://api.example.com/v1',
    DEFAULT_LLM_MODEL: 'model-default',
    DEFAULT_LLM_API_KEY: 'instance-secret',
    DEFAULT_STT_BASE_URL: 'https://api.example.com/v1',
    DEFAULT_STT_MODEL: 'whisper-1',
    DEFAULT_TTS_PROVIDER: 'browser',
    AZURE_SPEECH_REGION: 'westeurope',
    DEFAULT_TTS_VOICE: 'voice',
    REALTIME_BASE_URL: 'wss://api.example.com/v1/realtime',
    REALTIME_MODEL: 'realtime-default',
  };
}

function request(env: Env, path: string): Promise<Response> {
  return worker.fetch(
    new Request(`https://openfon.test${path}`, { headers: { Cookie: 'ofs=call-filter-session' } }),
    env,
    { waitUntil() {}, passThroughOnException() {}, props: {} } as ExecutionContext
  );
}

function callsPath(params: Record<string, string>): string {
  return `/api/me/calls?${new URLSearchParams(params).toString()}`;
}

describe('call list date filters', () => {
  let db: SqliteD1;
  let env: Env;
  let workspaceId: string;
  let assistantId: string;

  beforeEach(async () => {
    db = new SqliteD1();
    applyMigrations(db);
    db.exec(`
      INSERT INTO users (id, email, password_hash) VALUES ('filter-user', 'filter@example.com', 'hash');
      INSERT INTO sessions (token, user_id, expires_at)
      VALUES ('call-filter-session', 'filter-user', '2099-01-01T00:00:00.000Z');
    `);
    env = makeEnv(db);
    const created = await worker.fetch(
      new Request('https://openfon.test/api/me/business', {
        method: 'POST',
        headers: { Cookie: 'ofs=call-filter-session', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Filter workspace', description: 'Date filter tests' }),
      }),
      env,
      { waitUntil() {}, passThroughOnException() {}, props: {} } as ExecutionContext
    );
    expect(created.status).toBe(201);
    workspaceId = ((await created.json()) as { id: string }).id;
    assistantId = (
      db.database.prepare('SELECT id FROM assistants WHERE business_id=?').get(workspaceId) as { id: string }
    ).id;
  });

  afterEach(() => db.close());

  it('normalizes Z, milliseconds, and timezone offsets across half-open boundaries', async () => {
    const insert = db.database.prepare(
      `INSERT INTO calls (
        id, business_id, assistant_id, status, environment, direction, started_at
       ) VALUES (?, ?, ?, 'completed', 'live', 'inbound', ?)`
    );
    for (const [id, startedAt] of [
      ['before', '2026-08-10 09:59:59.999'],
      ['lower-boundary', '2026-08-10 10:00:00'],
      ['middle', '2026-08-10 10:00:00.125'],
      ['upper-boundary', '2026-08-10 10:00:00.250'],
      ['after', '2026-08-10 10:00:00.251'],
    ] as const) {
      insert.run(id, workspaceId, assistantId, startedAt);
    }

    const range = await request(
      env,
      callsPath({
        from: '2026-08-10T12:00:00+02:00',
        to: '2026-08-10T10:00:00.250Z',
      })
    );
    expect(range.status).toBe(200);
    expect(((await range.json()) as { items: Array<{ id: string }> }).items.map((call) => call.id)).toEqual([
      'middle',
      'lower-boundary',
    ]);

    const exact = await request(
      env,
      callsPath({
        from: '2026-08-10T10:00:00.250Z',
        to: '2026-08-10T12:00:00.250+02:00',
      })
    );
    expect(exact.status).toBe(200);
    expect(((await exact.json()) as { items: Array<{ id: string }> }).items).toEqual([]);

    // The next adjacent window owns the shared boundary exactly once.
    const adjacent = await request(
      env,
      callsPath({
        from: '2026-08-10T10:00:00.250Z',
        to: '2026-08-10T10:00:00.251Z',
      })
    );
    expect(adjacent.status).toBe(200);
    expect(((await adjacent.json()) as { items: Array<{ id: string }> }).items.map((call) => call.id)).toEqual([
      'upper-boundary',
    ]);

    const subsecond = await request(env, callsPath({ from: '2026-08-10T10:00:00.001Z' }));
    expect(subsecond.status).toBe(200);
    expect(((await subsecond.json()) as { items: Array<{ id: string }> }).items.map((call) => call.id)).toEqual([
      'after',
      'upper-boundary',
      'middle',
    ]);
  });

  it('rejects malformed, timezone-free, impossible, empty, and reversed ranges', async () => {
    for (const timestamp of [
      '',
      'not-a-date',
      '2026-08-10 10:00:00',
      '2026-08-10T10:00:00',
      '2026-02-30T10:00:00Z',
      '2026-08-10T24:00:00Z',
      '2026-08-10T10:00:00+24:00',
      '2026-08-10T10:00:00.1234Z',
      '0001-01-01T00:00:00+23:59',
      '9999-12-31T23:59:59-23:59',
    ]) {
      const response = await request(env, callsPath({ from: timestamp }));
      expect(response.status, timestamp).toBe(400);
      expect(await response.json()).toEqual({ error: expect.stringContaining('Invalid from timestamp') });
    }

    const invalidTo = await request(env, callsPath({ to: 'tomorrow' }));
    expect(invalidTo.status).toBe(400);
    expect(await invalidTo.json()).toEqual({ error: expect.stringContaining('Invalid to timestamp') });

    const reversed = await request(
      env,
      callsPath({
        from: '2026-08-10T10:00:01Z',
        to: '2026-08-10T10:00:00.999Z',
      })
    );
    expect(reversed.status).toBe(400);
    expect(await reversed.json()).toEqual({ error: expect.stringContaining('before or equal') });
  });
});
