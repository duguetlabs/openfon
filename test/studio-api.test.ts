import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { FakeD1, fakeCtx, fakeEnv } from './fake-d1';
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
  it.each([1, 2, 3, 4, 5, 6, 7])(
    'upgrades a populated database currently at migration 000%i',
    (version) => {
      const db = new SqliteD1();
      applyMigrations(db, 1, version);
      db.exec(`
        INSERT INTO users (id, email, password_hash) VALUES ('upgrade-user', 'upgrade@example.com', 'hash');
        INSERT INTO businesses (
          id, user_id, slug, name, description, services_json, faqs_json
        ) VALUES (
          'upgrade-biz', 'upgrade-user', 'upgrade-stable-slug', 'Upgrade Studio', 'A populated workspace',
          '[{"name":"Consultation","price":"€40"}]',
          '[{"q":"Are appointments required?","a":"Yes."}]'
        );
        INSERT INTO agent_settings (
          business_id, agent_name, greeting, persona, language, voice,
          llm_base_url, llm_api_key, llm_model
        ) VALUES (
          'upgrade-biz', 'Maya', 'Welcome', 'calm', 'de', 'voice-stable',
          'https://provider.example/v1', 'upgrade-secret', 'upgrade-model'
        );
        INSERT INTO calls (id, business_id, status) VALUES ('upgrade-call', 'upgrade-biz', 'completed');
        INSERT INTO call_turns (call_id, role, text) VALUES ('upgrade-call', 'caller', 'A preserved turn');
      `);
      if (version >= 2) db.exec("UPDATE agent_settings SET engine='realtime' WHERE business_id='upgrade-biz'");
      if (version >= 3) db.exec("UPDATE agent_settings SET realtime_model='rt-stable' WHERE business_id='upgrade-biz'");
      if (version >= 4) db.exec("UPDATE agent_settings SET realtime_voice='rt-voice' WHERE business_id='upgrade-biz'");
      if (version >= 5) db.exec("UPDATE businesses SET closures_json='[{\"date\":\"2026-12-25\"}]' WHERE id='upgrade-biz'");
      if (version >= 6) {
        db.exec(`
          INSERT INTO engine_profiles (
            id, business_id, name, engine, realtime_model, realtime_voice,
            language, voice, llm_base_url, llm_api_key, llm_model
          ) VALUES (
            'upgrade-profile', 'upgrade-biz', 'Stable profile', 'realtime', 'profile-rt',
            'profile-voice', 'de', 'voice-stable', 'https://provider.example/v1',
            'profile-secret', 'profile-model'
          )
        `);
      }
      if (version >= 7) {
        db.exec("UPDATE calls SET connected_at=datetime('now') WHERE id='upgrade-call'");
      }

      applyMigrations(db, version + 1, 8);

      expect(db.database.prepare("SELECT public_slug, state, name, language FROM assistants WHERE id='asst_upgrade-biz'").get()).toEqual({
        public_slug: 'upgrade-stable-slug',
        state: 'active',
        name: 'Maya',
        language: 'de',
      });
      expect(db.database.prepare("SELECT llm_base_url, llm_api_key FROM provider_settings WHERE business_id='upgrade-biz'").get()).toEqual({
        llm_base_url: 'https://provider.example/v1',
        llm_api_key: 'upgrade-secret',
      });
      expect(db.database.prepare("SELECT assistant_id, environment, connected_at IS NOT NULL AS connected FROM calls WHERE id='upgrade-call'").get()).toEqual({
        assistant_id: 'asst_upgrade-biz',
        environment: 'live',
        connected: 1,
      });
      expect(db.database.prepare("SELECT COUNT(*) AS n FROM knowledge_items WHERE business_id='upgrade-biz'").get()).toEqual({ n: 2 });
      if (version >= 6) {
        expect(db.database.prepare("SELECT name, llm_model FROM engine_presets WHERE id='upgrade-profile'").get()).toEqual({
          name: 'Stable profile',
          llm_model: 'profile-model',
        });
      }
      db.close();
    }
  );

  it('preserves existing settings, credentials, profiles, calls, public links, and approved knowledge edits', async () => {
    const db = new SqliteD1();
    applyMigrations(db, 1, 7);
    db.exec(`
      INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'owner@example.com', 'hash');
      INSERT INTO businesses (
        id, user_id, slug, name, description, services_json, faqs_json
      ) VALUES (
        'biz-1', 'user-1', 'riverside-a1b2', 'Riverside Dental', 'A dentist',
        '[ { "name": "Cleaning", "price": "€90" } ]',
        '[ { "q": "Do you take emergencies?", "a": "Yes, call before noon." } ]'
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
    db.exec("INSERT INTO sessions (token, user_id, expires_at) VALUES ('session-1', 'user-1', '2099-01-01T00:00:00.000Z')");
    const env = makeEnv(db);
    expect(
      (await request(env, '/api/me/knowledge/items/ki_faq_biz-1_0', json('PUT', { answer: 'Only with an appointment.', status: 'draft' }))).status
    ).toBe(200);
    expect((await request(env, '/api/me/knowledge/items/ki_service_biz-1_0', { method: 'DELETE' })).status).toBe(200);
    expect(
      (
        await request(
          env,
          '/api/me/business/biz-1',
          json('PUT', {
            phone: '+43 1 555 0100',
            services_json: '[{"name":"Cleaning","price":"€90"}]',
            faqs_json: '[{"q":"Do you take emergencies?","a":"Yes, call before noon."}]',
          })
        )
      ).status
    ).toBe(200);
    await request(env, '/api/me/bootstrap');
    expect(db.database.prepare("SELECT answer, status FROM knowledge_items WHERE id='ki_faq_biz-1_0'").get()).toEqual({
      answer: 'Only with an appointment.',
      status: 'draft',
    });
    expect(db.database.prepare("SELECT id FROM knowledge_items WHERE id='ki_service_biz-1_0'").get()).toBeUndefined();

    // An old worker can rewrite equivalent JSON without this route's semantic
    // guard. Reconciliation advances only the raw marker and preserves edits.
    db.database
      .prepare('UPDATE businesses SET services_json=?, faqs_json=? WHERE id=?')
      .run(
        '[ { "price": "€90", "name": "Cleaning" } ]',
        '[ { "a": "Yes, call before noon.", "q": "Do you take emergencies?" } ]',
        'biz-1'
      );
    await request(env, '/api/me/bootstrap');
    expect(db.database.prepare("SELECT answer, status FROM knowledge_items WHERE id='ki_faq_biz-1_0'").get()).toEqual({
      answer: 'Only with an appointment.',
      status: 'draft',
    });
    expect(db.database.prepare("SELECT id FROM knowledge_items WHERE id='ki_service_biz-1_0'").get()).toBeUndefined();

    // A real FAQ source change replaces only FAQ projections; it must not
    // resurrect the independently edited/deleted service projection.
    db.database
      .prepare('UPDATE businesses SET faqs_json=? WHERE id=?')
      .run('[{"q":"Where can I park?","a":"Behind the clinic."}]', 'biz-1');
    await request(env, '/api/me/bootstrap');
    expect(db.database.prepare("SELECT id FROM knowledge_items WHERE id='ki_service_biz-1_0'").get()).toBeUndefined();
    expect(
      db.database
        .prepare("SELECT question, answer, status FROM knowledge_items WHERE business_id='biz-1' AND kind='faq'")
        .get()
    ).toEqual({ question: 'Where can I park?', answer: 'Behind the clinic.', status: 'active' });
    db.close();
  });

  it('ignores valid legacy JSON values that are not arrays of records', () => {
    const db = new SqliteD1();
    applyMigrations(db, 1, 7);
    db.exec(`
      INSERT INTO users (id, email, password_hash) VALUES ('user-wrong-shape', 'shape@example.com', 'hash');
      INSERT INTO businesses (
        id, user_id, slug, name, services_json, faqs_json
      ) VALUES (
        'biz-wrong-shape', 'user-wrong-shape', 'wrong-shape-a1b2', 'Wrong Shape',
        '{"name":"This object is valid JSON, but not a services array"}',
        'true'
      );
    `);

    expect(() => applyMigrations(db, 8, 8)).not.toThrow();
    expect(
      db.database.prepare("SELECT COUNT(*) AS n FROM knowledge_items WHERE business_id='biz-wrong-shape'").get()
    ).toEqual({ n: 0 });
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
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function createWorkspace(token = 'session-1', name = 'Riverside Dental') {
    return data<Record<string, unknown>>(
      await request(env, '/api/me/business', json('POST', { name, description: 'A friendly neighborhood practice.', timezone: 'Europe/Vienna' }), token)
    );
  }

  it('creates one compatibility workspace atomically and idempotently and enforces the account boundary in D1', async () => {
    const first = await request(
      env,
      '/api/me/business',
      json('POST', { name: 'Riverside Dental', description: 'A friendly neighborhood practice.', timezone: 'Europe/Vienna' })
    );
    expect(first.status).toBe(201);
    const workspace = (await first.json()) as { id: string; name: string; slug: string };

    const retry = await request(
      env,
      '/api/me/business',
      json('POST', { name: 'A retry must not create another workspace', description: 'Retry' })
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ id: workspace.id, name: 'Riverside Dental' });
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM businesses WHERE user_id='user-1'").get()).toEqual({ n: 1 });

    const assistant = db.database.prepare('SELECT id, state, name FROM assistants WHERE business_id=?').get(workspace.id);
    expect(assistant).toMatchObject({ id: `asst_${workspace.id}`, state: 'draft', name: '' });
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM provider_settings WHERE business_id=?').get(workspace.id)).toEqual({ n: 1 });
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM knowledge_collections WHERE business_id=? AND is_default=1').get(workspace.id)).toEqual({ n: 1 });
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM assistant_knowledge_collections WHERE assistant_id=?').get(`asst_${workspace.id}`)).toEqual({ n: 1 });

    const bootstrap = await data<{
      setup: { workspace: boolean; firstAssistant: boolean; firstTest: boolean };
      readiness: { liveAssistantCount: number };
    }>(await request(env, '/api/me/bootstrap'));
    expect(bootstrap.setup).toMatchObject({ workspace: true, firstAssistant: false, firstTest: false });
    expect(bootstrap.readiness.liveAssistantCount).toBe(0);

    db.database.prepare('DELETE FROM assistant_knowledge_collections WHERE assistant_id=?').run(`asst_${workspace.id}`);
    await request(env, '/api/me/bootstrap');
    expect(
      db.database.prepare('SELECT collection_id FROM assistant_knowledge_collections WHERE assistant_id=?').all(`asst_${workspace.id}`)
    ).toEqual([]);

    expect(() =>
      db.exec(`INSERT INTO businesses (id, user_id, slug, name) VALUES ('second', 'user-1', 'second-a1b2', 'Second')`)
    ).toThrow(/one workspace per account/);
    const otherWorkspace = (await createWorkspace('session-2', 'Riverside Dental')) as { slug: string };
    expect(otherWorkspace.slug).not.toBe(workspace.slug);
    expect(() => db.database.prepare("UPDATE businesses SET user_id='user-2' WHERE id=?").run(workspace.id)).toThrow(
      /one workspace per account/
    );
  });

  it('promotes a fresh draft when an old worker completes the legacy assistant', async () => {
    const workspace = (await createWorkspace()) as { id: string; slug: string };
    const { assistants } = await data<{
      assistants: Array<{ id: string; state: string; name: string }>;
    }>(await request(env, '/api/me/bootstrap'));
    expect(assistants[0]).toMatchObject({ state: 'draft', name: '' });

    db.database
      .prepare(
        `UPDATE agent_settings SET agent_name=?, greeting=?, persona=?, language=?, voice=?,
          llm_base_url=?, llm_api_key=?, llm_model=?, engine=?, realtime_model=?, realtime_voice=?
         WHERE business_id=?`
      )
      .run(
        'Legacy Maya',
        'Hello from the old worker',
        'calm and concise',
        'de',
        'legacy-voice',
        'https://provider.example/v1',
        'legacy-secret',
        'legacy-model',
        'realtime',
        'legacy-realtime',
        'legacy-realtime-voice',
        workspace.id
      );

    const publicAssistant = await data<{ assistantId: string; agentName: string; language: string }>(
      await request(env, `/api/public/agent/${workspace.slug}`, {}, '')
    );
    expect(publicAssistant).toMatchObject({
      assistantId: assistants[0].id,
      agentName: 'Legacy Maya',
      language: 'de',
    });
    expect(
      db.database
        .prepare('SELECT state, name, persona, language, engine, llm_model FROM assistants WHERE id=?')
        .get(assistants[0].id)
    ).toEqual({
      state: 'active',
      name: 'Legacy Maya',
      persona: 'calm and concise',
      language: 'de',
      engine: 'realtime',
      llm_model: 'legacy-model',
    });
    expect(db.database.prepare('SELECT llm_base_url, llm_api_key FROM provider_settings WHERE business_id=?').get(workspace.id)).toEqual({
      llm_base_url: 'https://provider.example/v1',
      llm_api_key: 'legacy-secret',
    });
    const bootstrap = await data<{
      setup: { firstAssistant: boolean };
      readiness: { liveAssistantCount: number };
    }>(await request(env, '/api/me/bootstrap'));
    expect(bootstrap.setup.firstAssistant).toBe(true);
    expect(bootstrap.readiness.liveAssistantCount).toBe(1);
  });

  it('keeps partial old-worker writes in draft until all essentials are complete', async () => {
    const workspace = (await createWorkspace()) as { id: string; slug: string };
    db.database
      .prepare("UPDATE agent_settings SET greeting='Partial greeting', voice='partial-voice' WHERE business_id=?")
      .run(workspace.id);

    expect((await request(env, `/api/public/agent/${workspace.slug}`, {}, '')).status).toBe(404);
    expect(db.database.prepare('SELECT state, name FROM assistants WHERE business_id=?').get(workspace.id)).toEqual({
      state: 'draft',
      name: '',
    });

    // Exact legacy UI defaults still constitute a detectable later completion
    // because fresh compatibility settings begin blank.
    db.database
      .prepare("UPDATE agent_settings SET agent_name='Alex', persona='friendly and professional', language='en' WHERE business_id=?")
      .run(workspace.id);
    expect((await request(env, `/api/public/agent/${workspace.slug}`, {}, '')).status).toBe(200);
    expect(db.database.prepare('SELECT state, name, greeting, voice FROM assistants WHERE business_id=?').get(workspace.id)).toEqual({
      state: 'active',
      name: 'Alex',
      greeting: 'Partial greeting',
      voice: 'partial-voice',
    });
  });

  it('self-heals invalid old-worker essentials without disabling a valid active assistant', async () => {
    const workspace = (await createWorkspace()) as { id: string; slug: string };
    const { assistants } = await data<{ assistants: Array<{ id: string }> }>(await request(env, '/api/me/bootstrap'));
    expect(
      (
        await request(
          env,
          `/api/me/assistants/${assistants[0].id}`,
          json('PUT', { name: 'Stable Maya', persona: 'calm', language: 'de', greeting: 'Welcome' })
        )
      ).status
    ).toBe(200);
    expect((await request(env, `/api/me/assistants/${assistants[0].id}/activate`, json('POST', {}))).status).toBe(200);

    db.database
      .prepare(
        `UPDATE agent_settings SET agent_name='', persona='', language='', greeting='invalid',
          llm_api_key='rotated-secret' WHERE business_id=?`
      )
      .run(workspace.id);
    expect((await request(env, '/api/me/bootstrap')).status).toBe(200);
    expect(db.database.prepare('SELECT state, name, persona, language, greeting FROM assistants WHERE id=?').get(assistants[0].id)).toEqual({
      state: 'active',
      name: 'Stable Maya',
      persona: 'calm',
      language: 'de',
      greeting: 'Welcome',
    });
    expect(db.database.prepare('SELECT agent_name, persona, language, greeting FROM agent_settings WHERE business_id=?').get(workspace.id)).toEqual({
      agent_name: 'Stable Maya',
      persona: 'calm',
      language: 'de',
      greeting: 'Welcome',
    });
    expect(db.database.prepare('SELECT llm_api_key FROM provider_settings WHERE business_id=?').get(workspace.id)).toEqual({
      llm_api_key: 'rotated-secret',
    });
    expect((await request(env, `/api/public/agent/${workspace.slug}`, {}, '')).status).toBe(200);
  });

  it('reconstructs missing compatibility settings from the assistant and provider without overwriting either', async () => {
    const workspace = (await createWorkspace()) as { id: string };
    const { assistants } = await data<{ assistants: Array<{ id: string }> }>(await request(env, '/api/me/bootstrap'));
    const assistantId = assistants[0].id;
    expect(
      (
        await request(
          env,
          `/api/me/assistants/${assistantId}`,
          json('PUT', {
            name: 'Nova',
            greeting: 'Welcome',
            persona: 'precise',
            language: 'de',
            engine: 'realtime',
            realtime_model: 'rt-stable',
            llm_model: 'llm-stable',
          })
        )
      ).status
    ).toBe(200);
    expect(
      (
        await request(
          env,
          '/api/me/provider',
          json('PUT', { baseUrl: 'https://provider.example/v1', apiKey: 'provider-stable' })
        )
      ).status
    ).toBe(200);
    const assistantBefore = db.database.prepare('SELECT * FROM assistants WHERE id=?').get(assistantId);
    const providerBefore = db.database.prepare('SELECT * FROM provider_settings WHERE business_id=?').get(workspace.id);

    db.database.prepare('DELETE FROM agent_settings WHERE business_id=?').run(workspace.id);
    expect((await request(env, '/api/me/bootstrap')).status).toBe(200);

    expect(db.database.prepare('SELECT * FROM assistants WHERE id=?').get(assistantId)).toEqual(assistantBefore);
    expect(db.database.prepare('SELECT * FROM provider_settings WHERE business_id=?').get(workspace.id)).toEqual(providerBefore);
    expect(
      db.database
        .prepare(
          `SELECT agent_name, greeting, persona, language, engine, realtime_model, llm_model,
            llm_base_url, llm_api_key FROM agent_settings WHERE business_id=?`
        )
        .get(workspace.id)
    ).toEqual({
      agent_name: 'Nova',
      greeting: 'Welcome',
      persona: 'precise',
      language: 'de',
      engine: 'realtime',
      realtime_model: 'rt-stable',
      llm_model: 'llm-stable',
      llm_base_url: 'https://provider.example/v1',
      llm_api_key: 'provider-stable',
    });
  });

  it('reprojects legacy knowledge and attaches the assistant when the default collection identity changes', async () => {
    const workspace = (await createWorkspace()) as { id: string };
    const { assistants } = await data<{ assistants: Array<{ id: string }> }>(await request(env, '/api/me/bootstrap'));
    db.database
      .prepare('UPDATE businesses SET services_json=? WHERE id=?')
      .run(JSON.stringify([{ name: 'Whitening', price: '€190' }]), workspace.id);
    db.database.prepare('DELETE FROM knowledge_collections WHERE business_id=? AND is_default=1').run(workspace.id);
    db.database
      .prepare('INSERT INTO knowledge_collections (id, business_id, name, is_default) VALUES (?, ?, ?, 1)')
      .run('replacement-default', workspace.id, 'Replacement default');

    expect((await request(env, '/api/me/bootstrap')).status).toBe(200);
    expect(
      db.database.prepare('SELECT collection_id FROM assistant_knowledge_collections WHERE assistant_id=?').all(assistants[0].id)
    ).toEqual([{ collection_id: 'replacement-default' }]);
    expect(
      db.database
        .prepare("SELECT collection_id, kind, title, content FROM knowledge_items WHERE business_id=? AND kind='service'")
        .get(workspace.id)
    ).toEqual({
      collection_id: 'replacement-default',
      kind: 'service',
      title: 'Whitening',
      content: '€190',
    });
    expect(db.database.prepare('SELECT collection_id FROM compatibility_sync_state WHERE business_id=?').get(workspace.id)).toEqual({
      collection_id: 'replacement-default',
    });
  });

  it('reconciles legacy workspaces and profiles created after migration 0008', async () => {
    db.exec(`
      INSERT INTO businesses (id, user_id, slug, name, description)
      VALUES ('legacy-late', 'user-1', 'late-dental-a1b2', 'Late Dental', 'Created by an old worker');
      INSERT INTO agent_settings (
        business_id, agent_name, greeting, persona, language, voice,
        llm_base_url, llm_api_key, llm_model, engine, realtime_model, realtime_voice
      ) VALUES (
        'legacy-late', 'Maya', 'Hello from Late Dental', 'calm', 'de', 'legacy-voice',
        'https://provider.example/v1', 'late-secret', 'late-model', 'realtime', 'late-rt', 'late-rt-voice'
      );
      INSERT INTO engine_profiles (
        id, business_id, name, engine, realtime_model, realtime_voice, language,
        voice, llm_base_url, llm_api_key, llm_model
      ) VALUES (
        'late-profile', 'legacy-late', 'Late preset', 'realtime', 'late-fast', 'late-voice', 'de',
        'legacy-voice', 'https://provider.example/v1', 'late-profile-secret', 'late-profile-model'
      );
      INSERT INTO knowledge_collections (id, business_id, name, is_default)
      VALUES ('late-alternate-default', 'legacy-late', 'Imported default', 1);
    `);
    db.database
      .prepare('UPDATE businesses SET services_json=?, faqs_json=? WHERE id=?')
      .run(
        JSON.stringify([{ name: 'Cleaning', price: '€90', duration: '45 min' }]),
        JSON.stringify([{ q: 'Do you take walk-ins?', a: 'Please call first.' }]),
        'legacy-late'
      );

    const bootstrap = await data<{
      assistants: Array<{ id: string; public_slug: string; state: string; name: string }>;
      readiness: { liveAssistantCount: number };
    }>(await request(env, '/api/me/bootstrap'));
    expect(bootstrap.assistants).toEqual([
      expect.objectContaining({ id: 'asst_legacy-late', public_slug: 'late-dental-a1b2', state: 'active', name: 'Maya' }),
    ]);
    expect(bootstrap.readiness.liveAssistantCount).toBe(1);
    expect(db.database.prepare("SELECT llm_api_key FROM provider_settings WHERE business_id='legacy-late'").get()).toEqual({
      llm_api_key: 'late-secret',
    });
    expect(db.database.prepare("SELECT llm_model FROM engine_presets WHERE id='late-profile'").get()).toEqual({
      llm_model: 'late-profile-model',
    });
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM knowledge_collections WHERE business_id='legacy-late' AND is_default=1").get()).toEqual({ n: 1 });
    expect(db.database.prepare("SELECT collection_id FROM assistant_knowledge_collections WHERE assistant_id='asst_legacy-late'").get()).toEqual({
      collection_id: 'late-alternate-default',
    });
    expect(
      db.database
        .prepare("SELECT kind, title, question, answer FROM knowledge_items WHERE business_id='legacy-late' ORDER BY kind")
        .all()
    ).toEqual([
      { kind: 'faq', title: '', question: 'Do you take walk-ins?', answer: 'Please call first.' },
      { kind: 'service', title: 'Cleaning', question: '', answer: '' },
    ]);
    expect((await request(env, '/api/public/agent/late-dental-a1b2', {}, '')).status).toBe(200);

    // Simulate an old worker changing legacy rows while both versions are in
    // rotation. A public lookup must reconcile values, not only missing rows.
    db.database
      .prepare(
        `UPDATE agent_settings SET agent_name='Maya Updated', language='en', llm_api_key='updated-secret'
          WHERE business_id='legacy-late'`
      )
      .run();
    db.database
      .prepare("UPDATE engine_profiles SET name='Updated preset', llm_model='updated-model' WHERE id='late-profile'")
      .run();
    db.database
      .prepare('UPDATE businesses SET services_json=?, faqs_json=? WHERE id=?')
      .run(
        JSON.stringify([{ name: 'Whitening', price: '€190', notes: 'Consultation required' }]),
        JSON.stringify([{ q: 'Is parking available?', a: 'Yes, behind the clinic.' }]),
        'legacy-late'
      );
    const repaired = await data<{ agentName: string; language: string }>(
      await request(env, '/api/public/agent/late-dental-a1b2', {}, '')
    );
    expect(repaired).toMatchObject({ agentName: 'Maya Updated', language: 'en' });
    expect(db.database.prepare("SELECT llm_api_key FROM provider_settings WHERE business_id='legacy-late'").get()).toEqual({
      llm_api_key: 'updated-secret',
    });
    expect(db.database.prepare("SELECT name, llm_model FROM engine_presets WHERE id='late-profile'").get()).toEqual({
      name: 'Updated preset',
      llm_model: 'updated-model',
    });
    expect(
      db.database
        .prepare("SELECT kind, title, question, answer FROM knowledge_items WHERE business_id='legacy-late' ORDER BY kind")
        .all()
    ).toEqual([
      { kind: 'faq', title: '', question: 'Is parking available?', answer: 'Yes, behind the clinic.' },
      { kind: 'service', title: 'Whitening', question: '', answer: '' },
    ]);

    db.database.prepare("DELETE FROM engine_profiles WHERE id='late-profile'").run();
    await request(env, '/api/me/bootstrap');
    expect(db.database.prepare("SELECT id FROM engine_presets WHERE id='late-profile'").get()).toBeUndefined();
  });

  it('supports independent assistants, lifecycle gates, default knowledge, and cross-user isolation', async () => {
    const workspace = await createWorkspace();
    const bootstrap = await data<{ assistants: Array<{ id: string; public_slug: string; state: string }> }>(
      await request(env, '/api/me/bootstrap')
    );
    expect(bootstrap.assistants).toHaveLength(1);
    expect(bootstrap.assistants[0].state).toBe('draft');

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
    expect((await request(env, '/api/public/call/start', json('POST', { slug: draft.public_slug }), '')).status).toBe(200);
    expect(db.database.prepare('SELECT name, language, persona FROM assistants WHERE id=?').get(draft.id)).toEqual({
      name: 'Maya',
      language: 'de',
      persona: 'calm',
    });
    expect((await request(env, `/api/me/assistants/${draft.id}/pause`, json('POST', {}))).status).toBe(200);
    expect((await request(env, `/api/public/agent/${draft.public_slug}`, {}, '')).status).toBe(404);
    expect((await request(env, `/api/me/assistants/${draft.id}/test-calls`, json('POST', {}))).status).toBe(201);

    const defaultAssistant = bootstrap.assistants[0];
    expect((await request(env, `/api/public/agent/${defaultAssistant.public_slug}`, {}, '')).status).toBe(404);
    expect(
      (
        await request(
          env,
          `/api/me/assistants/${defaultAssistant.id}`,
          json('PUT', { name: 'Alex', persona: 'friendly', language: 'en' })
        )
      ).status
    ).toBe(200);
    expect((await request(env, `/api/me/assistants/${defaultAssistant.id}/activate`, json('POST', {}))).status).toBe(200);
    expect((await request(env, `/api/public/agent/${defaultAssistant.public_slug}`, {}, '')).status).toBe(200);
    expect((await request(env, `/api/me/assistants/${defaultAssistant.id}`, json('PUT', { persona: '' }))).status).toBe(400);
    expect((await request(env, `/api/me/assistants/${defaultAssistant.id}/pause`, json('POST', {}))).status).toBe(200);
    expect(
      (
        await request(
          env,
          `/api/me/business/${workspace.id as string}/agent`,
          json('PUT', { agent_name: 'Alex', persona: 'friendly', language: 'en' })
        )
      ).status
    ).toBe(200);
    expect((await request(env, `/api/public/agent/${defaultAssistant.public_slug}`, {}, '')).status).toBe(404);
    expect((await request(env, `/api/me/assistants/${defaultAssistant.id}/activate`, json('POST', {}))).status).toBe(200);
    const publicStart = await request(env, '/api/public/call/start', json('POST', { slug: defaultAssistant.public_slug }), '');
    expect(publicStart.status).toBe(200);
    const pendingLive = (await publicStart.json()) as { callId: string };
    expect((await request(env, `/api/me/assistants/${defaultAssistant.id}/pause`, json('POST', {}))).status).toBe(200);
    expect(
      (
        await request(
          env,
          `/ws/call/${pendingLive.callId}`,
          { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '198.51.100.44' } },
          ''
        )
      ).status
    ).toBe(409);
    expect(db.database.prepare('SELECT connected_at FROM calls WHERE id=?').get(pendingLive.callId)).toEqual({
      connected_at: null,
    });
    const calls = await data<{ items: Array<{ environment: string; assistant_id: string }> }>(await request(env, '/api/me/calls'));
    expect(calls.items).toHaveLength(2);
    expect(calls.items.find((call) => call.assistant_id === defaultAssistant.id)).toMatchObject({
      environment: 'live',
      assistant_id: defaultAssistant.id,
    });
    expect(workspace.id).toBeDefined();
  });

  it('counts a first test only after its WebSocket has connected', async () => {
    await createWorkspace();
    const { assistants } = await data<{ assistants: Array<{ id: string }> }>(await request(env, '/api/me/bootstrap'));
    const testCall = await data<{ callId: string }>(
      await request(env, `/api/me/assistants/${assistants[0].id}/test-calls`, json('POST', {}))
    );

    const before = await data<{ setup: { firstTest: boolean } }>(await request(env, '/api/me/bootstrap'));
    expect(before.setup.firstTest).toBe(false);
    db.database.prepare("UPDATE calls SET connected_at=datetime('now') WHERE id=?").run(testCall.callId);
    const after = await data<{ setup: { firstTest: boolean } }>(await request(env, '/api/me/bootstrap'));
    expect(after.setup.firstTest).toBe(true);
  });

  it('allows only the owning authenticated account to attach a test call', async () => {
    await createWorkspace();
    const { assistants } = await data<{ assistants: Array<{ id: string }> }>(await request(env, '/api/me/bootstrap'));
    const { callId } = await data<{ callId: string }>(
      await request(env, `/api/me/assistants/${assistants[0].id}/test-calls`, json('POST', {}))
    );
    const upgrade = { headers: { Upgrade: 'websocket' } };

    expect((await request(env, `/ws/call/${callId}`, upgrade, '')).status).toBe(404);
    expect((await request(env, `/ws/call/${callId}`, upgrade, 'session-2')).status).toBe(404);
    expect(db.database.prepare('SELECT connected_at FROM calls WHERE id=?').get(callId)).toEqual({ connected_at: null });

    expect((await request(env, `/ws/call/${callId}`, upgrade, 'session-1')).status).toBe(200);
    expect(db.database.prepare('SELECT connected_at IS NOT NULL AS connected FROM calls WHERE id=?').get(callId)).toEqual({ connected: 1 });
  });

  it('routes mixed-version live tickets without assistant ids through the active compatibility assistant', async () => {
    const workspace = (await createWorkspace()) as { id: string };
    const { assistants } = await data<{ assistants: Array<{ id: string }> }>(await request(env, '/api/me/bootstrap'));
    expect(
      (
        await request(
          env,
          `/api/me/assistants/${assistants[0].id}`,
          json('PUT', { name: 'Maya', persona: 'calm', language: 'en' })
        )
      ).status
    ).toBe(200);
    expect((await request(env, `/api/me/assistants/${assistants[0].id}/activate`, json('POST', {}))).status).toBe(200);
    db.database
      .prepare("INSERT INTO calls (id, business_id, assistant_id, environment) VALUES ('legacy-ticket', ?, NULL, 'live')")
      .run(workspace.id);

    expect(
      (
        await request(
          env,
          '/ws/call/legacy-ticket',
          { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '198.51.100.45' } },
          ''
        )
      ).status
    ).toBe(200);
    expect(db.database.prepare("SELECT connected_at IS NOT NULL AS connected FROM calls WHERE id='legacy-ticket'").get()).toEqual({
      connected: 1,
    });
  });

  it('repairs an old-worker workspace first seen through a null-assistant live ticket', async () => {
    db.exec(`
      INSERT INTO businesses (id, user_id, slug, name, description)
      VALUES ('rollout-biz', 'user-1', 'rollout-studio-a1b2', 'Rollout Studio', 'Created by the old worker');
      INSERT INTO agent_settings (business_id, agent_name, persona, language)
      VALUES ('rollout-biz', 'Legacy Alex', 'friendly', 'en');
      INSERT INTO calls (id, business_id, assistant_id, environment)
      VALUES ('rollout-ticket', 'rollout-biz', NULL, 'live');
    `);
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM assistants WHERE business_id='rollout-biz'").get()).toEqual({ n: 0 });

    expect(
      (
        await request(
          env,
          '/ws/call/rollout-ticket',
          { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '198.51.100.46' } },
          ''
        )
      ).status
    ).toBe(200);
    expect(db.database.prepare("SELECT public_slug, state, name FROM assistants WHERE business_id='rollout-biz'").get()).toEqual({
      public_slug: 'rollout-studio-a1b2',
      state: 'active',
      name: 'Legacy Alex',
    });
    expect(db.database.prepare("SELECT connected_at IS NOT NULL AS connected FROM calls WHERE id='rollout-ticket'").get()).toEqual({
      connected: 1,
    });
  });

  it('isolates live and test concurrency pools while still capping simultaneous tests', async () => {
    const workspace = (await createWorkspace()) as { id: string };
    const { assistants } = await data<{ assistants: Array<{ id: string; public_slug: string }> }>(
      await request(env, '/api/me/bootstrap')
    );
    const assistant = assistants[0];
    expect(
      (
        await request(
          env,
          `/api/me/assistants/${assistant.id}`,
          json('PUT', { name: 'Maya', persona: 'calm', language: 'en' })
        )
      ).status
    ).toBe(200);
    expect((await request(env, `/api/me/assistants/${assistant.id}/activate`, json('POST', {}))).status).toBe(200);
    db.database.prepare('UPDATE businesses SET max_concurrent_calls=1 WHERE id=?').run(workspace.id);
    const upgrade = { headers: { Upgrade: 'websocket' } };

    const firstTest = await data<{ callId: string }>(
      await request(env, `/api/me/assistants/${assistant.id}/test-calls`, json('POST', {}))
    );
    expect((await request(env, `/ws/call/${firstTest.callId}`, upgrade)).status).toBe(200);

    // A connected test must not make the public assistant look busy.
    const live = await data<{ callId: string }>(
      await request(env, '/api/public/call/start', json('POST', { slug: assistant.public_slug }), '')
    );
    expect((await request(env, `/ws/call/${live.callId}`, upgrade, '')).status).toBe(200);

    // Retire the first test while leaving the live call connected. The live
    // slot must not block a new authenticated test.
    db.database
      .prepare("UPDATE calls SET status='completed', ended_at=datetime('now') WHERE id=?")
      .run(firstTest.callId);
    const secondTest = await data<{ callId: string }>(
      await request(env, `/api/me/assistants/${assistant.id}/test-calls`, json('POST', {}))
    );
    expect((await request(env, `/ws/call/${secondTest.callId}`, upgrade)).status).toBe(200);

    expect(
      db.database
        .prepare(
          "SELECT environment, COUNT(*) AS n FROM calls WHERE status='active' AND connected_at IS NOT NULL GROUP BY environment ORDER BY environment"
        )
        .all()
    ).toEqual([
      { environment: 'live', n: 1 },
      { environment: 'test', n: 1 },
    ]);

    // The SQLite D1 adapter used above cannot return SELECT rows from a mixed
    // batch, so exercise the route's atomic capacity claim with the focused D1
    // fake as well. A test pool is separate, but it is not unlimited.
    const capDb = new FakeD1();
    capDb.seedBusiness({
      id: 'cap-workspace',
      slug: 'cap-workspace-a1b2',
      name: 'Cap workspace',
      user_id: 'cap-owner',
      max_concurrent_calls: 1,
    });
    capDb.sessions.push({ token: 'cap-session', user_id: 'cap-owner', expires_at: '2026-09-10T12:00:00.000Z' });
    capDb.seedCall({
      id: 'connected-test',
      business_id: 'cap-workspace',
      assistant_id: 'asst_cap-workspace',
      environment: 'test',
      connected_at: Date.now(),
    });
    const pending = capDb.seedCall({
      id: 'pending-test',
      business_id: 'cap-workspace',
      assistant_id: 'asst_cap-workspace',
      environment: 'test',
    });
    const capped = await worker.fetch(
      new Request('https://openfon.test/ws/call/pending-test', {
        headers: { Upgrade: 'websocket', Cookie: 'ofs=cap-session' },
      }),
      fakeEnv(capDb),
      fakeCtx
    );
    expect(capped.status).toBe(429);
    expect(pending).toMatchObject({ status: 'abandoned', connected_at: null });
  });

  it('shares the per-minute studio allowance between test calls and provider checks', async () => {
    await createWorkspace();
    const { assistants } = await data<{ assistants: Array<{ id: string }> }>(await request(env, '/api/me/bootstrap'));
    const providerFetch = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', providerFetch);

    for (let i = 0; i < 9; i++) {
      expect((await request(env, `/api/me/assistants/${assistants[0].id}/test-calls`, json('POST', {}))).status).toBe(201);
    }
    expect((await request(env, '/api/me/provider/check', json('POST', {}))).status).toBe(200);
    const blocked = await request(env, '/api/me/provider/check', json('POST', {}));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it('enforces independent daily ceilings for test calls and provider checks without creating extra work', async () => {
    const workspace = (await createWorkspace()) as { id: string };
    const { assistants } = await data<{ assistants: Array<{ id: string }> }>(await request(env, '/api/me/bootstrap'));
    const insert = db.database.prepare(
      `INSERT INTO calls (id, business_id, assistant_id, environment, direction)
       VALUES (?, ?, ?, 'test', 'inbound')`
    );
    for (let i = 0; i < 100; i++) insert.run(`daily-test-${i}`, workspace.id, assistants[0].id);

    const testBlocked = await request(env, `/api/me/assistants/${assistants[0].id}/test-calls`, json('POST', {}));
    expect(testBlocked.status).toBe(429);
    expect(testBlocked.headers.get('Retry-After')).toBe('3600');
    expect(db.database.prepare("SELECT COUNT(*) AS n FROM calls WHERE business_id=? AND environment='test'").get(workspace.id)).toEqual({
      n: 100,
    });

    const providerDay = Math.floor(Date.now() / 1000 / 86_400) * 86_400;
    db.database
      .prepare('INSERT INTO rate_counters (bucket, window_start, count) VALUES (?, ?, 50)')
      .run(`studio:provider-day:${workspace.id}`, providerDay);
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);
    const providerBlocked = await request(env, '/api/me/provider/check', json('POST', {}));
    expect(providerBlocked.status).toBe(429);
    expect(providerBlocked.headers.get('Retry-After')).toBe('3600');
    expect(providerFetch).not.toHaveBeenCalled();
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

  it('keeps compatibility assistant, provider, and preset writes synchronized in both API generations', async () => {
    const workspace = await createWorkspace();
    const { assistants } = await data<{ assistants: Array<{ id: string }> }>(await request(env, '/api/me/bootstrap'));
    const assistantId = assistants[0].id;

    expect(
      (await request(
        env,
        `/api/me/assistants/${assistantId}`,
        json('PUT', { name: 'Nova', language: 'de', persona: 'concise', engine: 'realtime', realtime_model: 'rt-new' })
      )).status
    ).toBe(200);
    expect(db.database.prepare('SELECT agent_name, language, persona, engine, realtime_model FROM agent_settings WHERE business_id=?').get(workspace.id as string)).toEqual({
      agent_name: 'Nova',
      language: 'de',
      persona: 'concise',
      engine: 'realtime',
      realtime_model: 'rt-new',
    });

    expect(
      (await request(env, '/api/me/provider', json('PUT', { baseUrl: 'https://provider.example/v1', apiKey: 'sync-secret' }))).status
    ).toBe(200);
    expect(db.database.prepare('SELECT llm_base_url, llm_api_key FROM agent_settings WHERE business_id=?').get(workspace.id as string)).toEqual({
      llm_base_url: 'https://provider.example/v1',
      llm_api_key: 'sync-secret',
    });

    const preset = await data<{ id: string }>(
      await request(
        env,
        '/api/me/engine-presets',
        json('POST', { name: 'Fast', engine: 'pipeline', language: 'en', voice: 'voice-fast', llm_model: 'model-fast' })
      )
    );
    expect(db.database.prepare('SELECT name, llm_model, llm_api_key FROM engine_profiles WHERE id=?').get(preset.id)).toEqual({
      name: 'Fast',
      llm_model: 'model-fast',
      llm_api_key: 'sync-secret',
    });

    expect(
      (await request(env, `/api/me/profiles/${preset.id}`, json('PUT', { name: 'Faster', llm_model: 'model-faster' }))).status
    ).toBe(200);
    expect(db.database.prepare('SELECT name, llm_model FROM engine_presets WHERE id=?').get(preset.id)).toEqual({
      name: 'Faster',
      llm_model: 'model-faster',
    });

    expect((await request(env, `/api/me/engine-presets/${preset.id}/apply`, json('POST', { assistantId }))).status).toBe(200);
    expect(db.database.prepare('SELECT engine, voice, llm_model FROM assistants WHERE id=?').get(assistantId)).toEqual({
      engine: 'pipeline',
      voice: 'voice-fast',
      llm_model: 'model-faster',
    });
    expect(db.database.prepare('SELECT engine, voice, llm_model FROM agent_settings WHERE business_id=?').get(workspace.id as string)).toEqual({
      engine: 'pipeline',
      voice: 'voice-fast',
      llm_model: 'model-faster',
    });

    expect((await request(env, `/api/me/engine-presets/${preset.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM engine_presets WHERE id=?').get(preset.id)).toEqual({ n: 0 });
    expect(db.database.prepare('SELECT COUNT(*) AS n FROM engine_profiles WHERE id=?').get(preset.id)).toEqual({ n: 0 });
  });

  it('rejects invalid historical preset and profile languages without mutating the assistant or provider', async () => {
    const workspace = (await createWorkspace()) as { id: string };
    const { assistants } = await data<{ assistants: Array<{ id: string }> }>(await request(env, '/api/me/bootstrap'));
    const assistantId = assistants[0].id;
    expect(
      (
        await request(
          env,
          `/api/me/assistants/${assistantId}`,
          json('PUT', {
            name: 'Stable Nova',
            persona: 'careful',
            language: 'de',
            engine: 'pipeline',
            voice: 'stable-voice',
            llm_model: 'stable-model',
          })
        )
      ).status
    ).toBe(200);
    expect(
      (
        await request(
          env,
          '/api/me/provider',
          json('PUT', { baseUrl: 'https://provider.example/v1', apiKey: 'stable-secret' })
        )
      ).status
    ).toBe(200);
    db.database
      .prepare(
        `INSERT INTO engine_presets (
          id, business_id, name, engine, realtime_model, realtime_voice, language, voice, llm_model
         ) VALUES ('bad-preset', ?, 'Bad preset', 'realtime', 'bad-rt', 'bad-rt-voice', '', 'bad-voice', 'bad-model')`
      )
      .run(workspace.id);
    db.database
      .prepare(
        `INSERT INTO engine_profiles (
          id, business_id, name, engine, realtime_model, realtime_voice, language,
          voice, llm_base_url, llm_api_key, llm_model
         ) VALUES (
          'bad-profile', ?, 'Bad profile', 'realtime', 'bad-profile-rt', 'bad-profile-rt-voice', '',
          'bad-profile-voice', 'https://other.example/v1', 'bad-profile-secret', 'bad-profile-model'
         )`
      )
      .run(workspace.id);
    const assistantBefore = db.database
      .prepare('SELECT engine, realtime_model, realtime_voice, language, voice, llm_model FROM assistants WHERE id=?')
      .get(assistantId);
    const legacyBefore = db.database.prepare('SELECT * FROM agent_settings WHERE business_id=?').get(workspace.id);
    const providerBefore = db.database.prepare('SELECT * FROM provider_settings WHERE business_id=?').get(workspace.id);

    expect(
      (
        await request(
          env,
          '/api/me/engine-presets/bad-preset/apply',
          json('POST', { assistantId })
        )
      ).status
    ).toBe(400);
    expect((await request(env, '/api/me/profiles/bad-profile/apply', json('POST', {}))).status).toBe(400);
    expect(
      db.database
        .prepare('SELECT engine, realtime_model, realtime_voice, language, voice, llm_model FROM assistants WHERE id=?')
        .get(assistantId)
    ).toEqual(assistantBefore);
    expect(db.database.prepare('SELECT * FROM agent_settings WHERE business_id=?').get(workspace.id)).toEqual(legacyBefore);
    expect(db.database.prepare('SELECT * FROM provider_settings WHERE business_id=?').get(workspace.id)).toEqual(providerBefore);
  });

  it('returns complete numeric zero overview metrics for an empty workspace', async () => {
    await createWorkspace();
    const overview = await data<{ metrics: Record<string, number>; recentCalls: unknown[] }>(
      await request(env, '/api/me/overview?days=30')
    );
    expect(overview.metrics).toEqual({
      total: 0,
      completed: 0,
      failed: 0,
      messages: 0,
      booking_requests: 0,
      talk_time_s: 0,
      average_duration_s: 0,
    });
    expect(Object.values(overview.metrics).every((value) => typeof value === 'number')).toBe(true);
    expect(overview.recentCalls).toEqual([]);
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
