import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function request(env: Env, path: string, init: RequestInit = {}, token = 'session-1'): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Cookie', `ofs=${token}`);
  return worker.fetch(new Request(`https://openfon.test${path}`, { ...init, headers }), env, {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as ExecutionContext);
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function data<T>(response: Response): Promise<T> {
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
  return value as T;
}

describe('Calm Studio migration 0008', () => {
  it('preserves existing settings, credentials, profiles, calls, and public links', () => {
    const db = new SqliteD1();
    applyMigrations(db, 1, 7);
    db.exec(`
      INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'owner@example.com', 'hash');
      INSERT INTO businesses (
        id, user_id, slug, name, description, services_json, faqs_json
      ) VALUES (
        'biz-1', 'user-1', 'riverside-a1b2', 'Riverside Dental', 'A dentist',
        '[{"name":"Cleaning","price":"€90"}]',
        '[{"q":"Do you take emergencies?","a":"Yes, call before noon."}]'
      );
      INSERT INTO agent_settings (
        business_id, agent_name, greeting, persona, language, voice,
        llm_base_url, llm_api_key, llm_model, engine, realtime_model, realtime_voice
      ) VALUES (
        'biz-1', 'Maya', 'Hello from Riverside', 'calm', 'de', 'voice-1',
        'https://provider.example/v1', 'workspace-secret', 'model-1', 'realtime', 'rt-1', 'rt-voice'
      );
      INSERT INTO engine_profiles (
        id, business_id, name, engine, realtime_model, realtime_voice, language,
        voice, llm_base_url, llm_api_key, llm_model
      ) VALUES (
        'profile-1', 'biz-1', 'Fast', 'realtime', 'rt-fast', 'rt-v', 'de',
        'voice-fast', 'https://provider.example/v1', 'profile-secret', 'model-fast'
      );
      INSERT INTO calls (id, business_id, status, connected_at) VALUES ('call-1', 'biz-1', 'completed', datetime('now'));
      INSERT INTO call_turns (call_id, role, text) VALUES ('call-1', 'caller', 'I need help');
    `);

    applyMigrations(db, 8, 8);

    const assistant = db.database.prepare("SELECT * FROM assistants WHERE business_id='biz-1'").get() as Record<string, unknown>;
    expect(assistant).toMatchObject({
      id: 'asst_biz-1',
      public_slug: 'riverside-a1b2',
      state: 'active',
      name: 'Maya',
      language: 'de',
      llm_model: 'model-1',
      realtime_model: 'rt-1',
    });
    expect(db.database.prepare("SELECT llm_api_key FROM provider_settings WHERE business_id='biz-1'").get()).toEqual({
      llm_api_key: 'workspace-secret',
    });
    expect(db.database.prepare("SELECT llm_model FROM engine_presets WHERE id='profile-1'").get()).toEqual({ llm_model: 'model-fast' });
    expect(db.database.prepare("SELECT assistant_id, environment, direction, connected_at FROM calls WHERE id='call-1'").get()).toMatchObject({
      assistant_id: 'asst_biz-1',
      environment: 'live',
      direction: 'inbound',
    });
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM knowledge_items WHERE business_id='biz-1' AND status='active'").get()).toEqual({ n: 2 });
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM assistant_knowledge_collections WHERE assistant_id='asst_biz-1'").get()).toEqual({ n: 1 });
    db.close();
  });
});

describe('Calm Studio API foundation', () => {
  let db: SqliteD1;
  let env: Env;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
    db = new SqliteD1();
    applyMigrations(db);
    db.exec(`
      INSERT INTO users (id, email, password_hash) VALUES
        ('user-1', 'one@example.com', 'hash'),
        ('user-2', 'two@example.com', 'hash');
      INSERT INTO sessions (token, user_id, expires_at) VALUES
        ('session-1', 'user-1', '2026-09-10T12:00:00.000Z'),
        ('session-2', 'user-2', '2026-09-10T12:00:00.000Z');
    `);
    env = makeEnv(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  async function createWorkspace(token = 'session-1', name = 'Riverside Dental') {
    return data<Record<string, unknown>>(
      await request(env, '/api/me/business', json('POST', { name, description: 'A friendly neighborhood practice.', timezone: 'Europe/Vienna' }), token)
    );
  }

  it('supports independent assistants, lifecycle gates, default knowledge, and cross-user isolation', async () => {
    const workspace = await createWorkspace();
    const bootstrap = await data<{ assistants: Array<{ id: string; public_slug: string; state: string }> }>(
      await request(env, '/api/me/bootstrap')
    );
    expect(bootstrap.assistants).toHaveLength(1);
    expect(bootstrap.assistants[0].state).toBe('active');

    const draft = await data<{ id: string; public_slug: string; state: string }>(
      await request(env, '/api/me/assistants', json('POST', { name: 'Maya', language: 'de', persona: 'calm' }))
    );
    const second = await data<{ id: string; public_slug: string }>(
      await request(env, '/api/me/assistants', json('POST', { name: 'Maya' }))
    );
    expect(draft.public_slug).not.toBe(second.public_slug);
    expect(draft.state).toBe('draft');
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM assistant_knowledge_collections WHERE assistant_id=?').get(draft.id)).toEqual({ n: 1 });

    expect((await request(env, `/api/me/assistants/${draft.id}`, {}, 'session-2')).status).toBe(404);
    expect((await request(env, `/api/public/agent/${draft.public_slug}`, {}, '')).status).toBe(404);
    expect((await request(env, `/api/me/assistants/${draft.id}/test-calls`, json('POST', {}))).status).toBe(201);

    expect((await request(env, `/api/me/assistants/${draft.id}/activate`, json('POST', {}))).status).toBe(200);
    expect((await request(env, `/api/public/agent/${draft.public_slug}`, {}, '')).status).toBe(200);
    expect((await request(env, `/api/me/assistants/${draft.id}/pause`, json('POST', {}))).status).toBe(200);
    expect((await request(env, `/api/public/agent/${draft.public_slug}`, {}, '')).status).toBe(404);
    expect((await request(env, `/api/me/assistants/${draft.id}/test-calls`, json('POST', {}))).status).toBe(201);

    const defaultAssistant = bootstrap.assistants[0];
    const publicStart = await request(env, '/api/public/call/start', json('POST', { slug: defaultAssistant.public_slug }), '');
    expect(publicStart.status).toBe(200);
    const calls = await data<{ items: Array<{ environment: string; assistant_id: string }> }>(await request(env, '/api/me/calls'));
    expect(calls.items).toHaveLength(1);
    expect(calls.items[0]).toMatchObject({ environment: 'live', assistant_id: defaultAssistant.id });
    expect(workspace.id).toBeDefined();
  });

  it('creates a caller turn as a draft FAQ and never activates it implicitly', async () => {
    await createWorkspace();
    const { assistants } = await data<{ assistants: Array<{ id: string }> }>(await request(env, '/api/me/bootstrap'));
    const testCall = await data<{ callId: string }>(
      await request(env, `/api/me/assistants/${assistants[0].id}/test-calls`, json('POST', {}))
    );
    db.database.prepare("INSERT INTO call_turns (call_id, role, text) VALUES (?, 'caller', ?)").run(testCall.callId, 'Do you validate parking?');
    const turn = db.database.prepare('SELECT id FROM call_turns WHERE call_id=?').get(testCall.callId) as { id: number };

    const item = await data<{ id: string; status: string; kind: string; question: string; answer: string }>(
      await request(env, '/api/me/knowledge/drafts/from-turn', json('POST', { callId: testCall.callId, turnId: turn.id }))
    );
    expect(item).toMatchObject({ status: 'draft', kind: 'faq', question: 'Do you validate parking?', answer: '' });
    expect((await request(env, `/api/me/knowledge/items/${item.id}`, json('PUT', { status: 'active' }))).status).toBe(400);
    expect((await request(env, `/api/me/knowledge/items/${item.id}`, json('PUT', { answer: 'Yes, for two hours.', status: 'active' }))).status).toBe(200);
  });

  it('never returns provider secrets or masked credential placeholders', async () => {
    await createWorkspace();
    const secret = 'sk-workspace-never-return';
    expect(
      (await request(env, '/api/me/provider', json('PUT', { baseUrl: 'https://provider.example/v1', apiKey: secret }))).status
    ).toBe(200);
    for (const path of ['/api/me/provider', '/api/me/business', '/api/me/bootstrap']) {
      const text = await (await request(env, path)).text();
      expect(text).not.toContain(secret);
      expect(text).not.toContain('••');
    }
    const provider = await data<{ apiKeyConfigured: boolean; baseUrl: string }>(await request(env, '/api/me/provider'));
    expect(provider).toMatchObject({ apiKeyConfigured: true, baseUrl: 'https://provider.example/v1' });
    const rejected = await request(env, '/api/me/provider', json('PUT', { baseUrl: 'http://169.254.169.254/v1' }));
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain(secret);
  });

  it('keeps overview totals accurate beyond 100 and cursors stable while excluding tests', async () => {
    const workspace = await createWorkspace();
    const { assistants } = await data<{ assistants: Array<{ id: string }> }>(await request(env, '/api/me/bootstrap'));
    const insert = db.database.prepare(
      `INSERT INTO calls (
        id, business_id, assistant_id, status, environment, direction, started_at, duration_s
       ) VALUES (?, ?, ?, 'completed', ?, 'inbound', ?, 30)`
    );
    for (let i = 0; i < 135; i++) {
      const seconds = String(i).padStart(3, '0');
      insert.run(`live-${String(i).padStart(3, '0')}`, workspace.id as string, assistants[0].id, 'live', `2026-08-10 11:${seconds.slice(0, 2)}:${seconds.slice(1)}`);
    }
    for (let i = 0; i < 5; i++) {
      insert.run(`test-${i}`, workspace.id as string, assistants[0].id, 'test', `2026-08-10 10:00:0${i}`);
    }
    const overview = await data<{ metrics: { total: number } }>(await request(env, '/api/me/overview?days=30'));
    expect(overview.metrics.total).toBe(135);

    const first = await data<{ items: Array<{ id: string }>; nextCursor: string }>(await request(env, '/api/me/calls?limit=100'));
    const second = await data<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      await request(env, `/api/me/calls?limit=100&cursor=${encodeURIComponent(first.nextCursor)}`)
    );
    expect(first.items).toHaveLength(100);
    expect(second.items).toHaveLength(35);
    expect(new Set([...first.items, ...second.items].map((call) => call.id)).size).toBe(135);
    expect([...first.items, ...second.items].some((call) => call.id.startsWith('test-'))).toBe(false);
  });
});
