import type { Hono } from 'hono';
import { newId } from './auth';
import { chatComplete, LlmConfigError, resolveLlm, sameLlmEndpoint, validateLlmBaseUrl } from './providers';
import type {
  AgentSettings,
  Assistant,
  Business,
  Env,
  KnowledgeCollection,
  KnowledgeItem,
  ProviderSettings,
} from './types';

type Vars = { userId: string };
type StudioApp = Hono<{ Bindings: Env; Variables: Vars }>;

type Workspace = Business & { user_id: string };

function slugBase(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'assistant'
  );
}

function assistantSlug(name: string): string {
  return `${slugBase(name)}-${newId().replace(/-/g, '').slice(0, 8)}`;
}

async function workspaceForUser(env: Env, userId: string): Promise<Workspace | null> {
  return env.DB.prepare('SELECT * FROM businesses WHERE user_id = ? LIMIT 1').bind(userId).first<Workspace>();
}

async function ownedAssistant(env: Env, userId: string, assistantId: string): Promise<Assistant | null> {
  return env.DB.prepare(
    `SELECT assistants.* FROM assistants
      JOIN businesses ON businesses.id = assistants.business_id
     WHERE assistants.id = ? AND businesses.user_id = ?`
  )
    .bind(assistantId, userId)
    .first<Assistant>();
}

async function ownedCollection(env: Env, userId: string, collectionId: string): Promise<KnowledgeCollection | null> {
  return env.DB.prepare(
    `SELECT knowledge_collections.* FROM knowledge_collections
      JOIN businesses ON businesses.id = knowledge_collections.business_id
     WHERE knowledge_collections.id = ? AND businesses.user_id = ?`
  )
    .bind(collectionId, userId)
    .first<KnowledgeCollection>();
}

async function ownedItem(env: Env, userId: string, itemId: string): Promise<KnowledgeItem | null> {
  return env.DB.prepare(
    `SELECT knowledge_items.* FROM knowledge_items
      JOIN businesses ON businesses.id = knowledge_items.business_id
     WHERE knowledge_items.id = ? AND businesses.user_id = ?`
  )
    .bind(itemId, userId)
    .first<KnowledgeItem>();
}

function normalizedState(value: unknown): 'draft' | 'active' | 'paused' | null {
  return value === 'draft' || value === 'active' || value === 'paused' ? value : null;
}

function normalizedKind(value: unknown): 'faq' | 'service' | 'note' | null {
  return value === 'faq' || value === 'service' || value === 'note' ? value : null;
}

function normalizedStatus(value: unknown): 'draft' | 'active' | null {
  return value === 'draft' || value === 'active' ? value : null;
}

function itemReady(item: Pick<KnowledgeItem, 'kind' | 'title' | 'question' | 'answer' | 'content'>): boolean {
  if (item.kind === 'faq') return Boolean(item.question.trim() && item.answer.trim());
  if (item.kind === 'service') return Boolean(item.title.trim());
  return Boolean(item.content.trim());
}

function providerConfigured(env: Env, provider: ProviderSettings | null): boolean {
  const baseUrl = provider?.llm_base_url.trim() ?? '';
  if (!baseUrl || sameLlmEndpoint(baseUrl, env.DEFAULT_LLM_BASE_URL)) {
    return Boolean(provider?.llm_api_key || env.DEFAULT_LLM_API_KEY);
  }
  return Boolean(provider?.llm_api_key);
}

function providerValidationError(env: Env, baseUrl: string, apiKey: string): string | null {
  const url = baseUrl.trim();
  if (!url || sameLlmEndpoint(url, env.DEFAULT_LLM_BASE_URL)) return null;
  const rejected = validateLlmBaseUrl(url, env.ALLOW_INSECURE_LLM_URL === 'true');
  if (rejected) return `LLM base URL ${rejected}`;
  if (!apiKey) return 'A custom LLM base URL needs its own API key.';
  return null;
}

function settingsForProvider(assistant: Assistant, provider: ProviderSettings | null): AgentSettings {
  return {
    business_id: assistant.business_id,
    agent_name: assistant.name,
    greeting: assistant.greeting,
    persona: assistant.persona,
    language: assistant.language,
    voice: assistant.voice,
    take_messages: assistant.take_messages,
    custom_instructions: assistant.custom_instructions,
    llm_base_url: provider?.llm_base_url ?? '',
    llm_api_key: provider?.llm_api_key ?? '',
    llm_model: assistant.llm_model,
    engine: assistant.engine,
    realtime_model: assistant.realtime_model,
    realtime_voice: assistant.realtime_voice,
  };
}

function encodeCursor(startedAt: string, id: string): string {
  return btoa(JSON.stringify([startedAt, id])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeCursor(raw: string | undefined): [string, string] | null {
  if (!raw) return null;
  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))) as unknown;
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every((x) => typeof x === 'string')
      ? [parsed[0], parsed[1]]
      : null;
  } catch {
    return null;
  }
}

function likeTerm(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

export function registerStudioApi(app: StudioApp): void {
  app.get('/api/me/bootstrap', async (c) => {
    const userId = c.get('userId');
    const account = await c.env.DB.prepare('SELECT id, email, created_at FROM users WHERE id = ?')
      .bind(userId)
      .first<{ id: string; email: string; created_at: string }>();
    const workspace = await workspaceForUser(c.env, userId);
    if (!workspace) {
      return c.json({
        account,
        workspace: null,
        assistants: [],
        setup: { account: true, workspace: false, firstAssistant: false, firstTest: false },
        readiness: { providerConfigured: Boolean(c.env.DEFAULT_LLM_API_KEY), liveAssistantCount: 0 },
      });
    }
    const [{ results: assistants }, provider, test] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM assistants WHERE business_id = ? ORDER BY created_at, id').bind(workspace.id).all<Assistant>(),
      c.env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?').bind(workspace.id).first<ProviderSettings>(),
      c.env.DB.prepare("SELECT 1 AS found FROM calls WHERE business_id = ? AND environment = 'test' LIMIT 1")
        .bind(workspace.id)
        .first<{ found: number }>(),
    ]);
    return c.json({
      account,
      workspace,
      assistants,
      setup: {
        account: true,
        workspace: Boolean(workspace.name.trim() && workspace.description.trim()),
        firstAssistant: assistants.some((a) => Boolean(a.name.trim() && a.language.trim() && a.persona.trim())),
        firstTest: Boolean(test),
      },
      readiness: {
        providerConfigured: providerConfigured(c.env, provider),
        liveAssistantCount: assistants.filter((a) => a.state === 'active').length,
      },
    });
  });

  app.get('/api/me/assistants', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json([]);
    const { results } = await c.env.DB.prepare(
      `SELECT assistants.*,
        (SELECT MAX(started_at) FROM calls WHERE calls.assistant_id = assistants.id AND environment = 'live') AS last_live_call_at,
        (SELECT MAX(started_at) FROM calls WHERE calls.assistant_id = assistants.id AND environment = 'test') AS last_test_at
       FROM assistants WHERE business_id = ? ORDER BY created_at, id`
    )
      .bind(workspace.id)
      .all();
    return c.json(results);
  });

  app.post('/api/me/assistants', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json({ error: 'Create a workspace first' }, 409);
    const body = await c.req.json<Partial<Assistant>>();
    if (!body.name?.trim()) return c.json({ error: 'Assistant name required' }, 400);
    const id = newId();
    await c.env.DB.prepare(
      `INSERT INTO assistants (
        id, business_id, public_slug, state, name, greeting, persona, language,
        voice, take_messages, custom_instructions, engine, realtime_model,
        realtime_voice, llm_model
      ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        workspace.id,
        assistantSlug(body.name),
        body.name.trim(),
        body.greeting ?? '',
        body.persona?.trim() || 'friendly and professional',
        body.language?.trim() || 'en',
        body.voice ?? '',
        body.take_messages === 0 ? 0 : 1,
        body.custom_instructions ?? '',
        body.engine === 'realtime' ? 'realtime' : 'pipeline',
        body.realtime_model ?? '',
        body.realtime_voice ?? '',
        body.llm_model ?? ''
      )
      .run();
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO assistant_knowledge_collections (assistant_id, collection_id)
       SELECT ?, id FROM knowledge_collections WHERE business_id = ? AND is_default = 1`
    )
      .bind(id, workspace.id)
      .run();
    const row = await c.env.DB.prepare('SELECT * FROM assistants WHERE id = ?').bind(id).first<Assistant>();
    return c.json(row, 201);
  });

  app.get('/api/me/assistants/:assistantId', async (c) => {
    const assistant = await ownedAssistant(c.env, c.get('userId'), c.req.param('assistantId'));
    if (!assistant) return c.json({ error: 'Not found' }, 404);
    const { results: collectionIds } = await c.env.DB.prepare(
      'SELECT collection_id FROM assistant_knowledge_collections WHERE assistant_id = ? ORDER BY collection_id'
    )
      .bind(assistant.id)
      .all<{ collection_id: string }>();
    return c.json({ ...assistant, collectionIds: collectionIds.map((x) => x.collection_id) });
  });

  app.put('/api/me/assistants/:assistantId', async (c) => {
    const assistant = await ownedAssistant(c.env, c.get('userId'), c.req.param('assistantId'));
    if (!assistant) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json<Partial<Assistant>>();
    const name = body.name?.trim() || assistant.name;
    const engine = body.engine === 'realtime' ? 'realtime' : body.engine === 'pipeline' ? 'pipeline' : assistant.engine;
    await c.env.DB.prepare(
      `UPDATE assistants SET name=?, greeting=?, persona=?, language=?, voice=?, take_messages=?,
        custom_instructions=?, engine=?, realtime_model=?, realtime_voice=?, llm_model=?, updated_at=datetime('now')
       WHERE id=?`
    )
      .bind(
        name,
        body.greeting ?? assistant.greeting,
        body.persona ?? assistant.persona,
        body.language ?? assistant.language,
        body.voice ?? assistant.voice,
        body.take_messages !== undefined ? (body.take_messages ? 1 : 0) : assistant.take_messages,
        body.custom_instructions ?? assistant.custom_instructions,
        engine,
        body.realtime_model ?? assistant.realtime_model,
        body.realtime_voice ?? assistant.realtime_voice,
        body.llm_model ?? assistant.llm_model,
        assistant.id
      )
      .run();
    const row = await c.env.DB.prepare('SELECT * FROM assistants WHERE id = ?').bind(assistant.id).first<Assistant>();
    return c.json(row);
  });

  app.post('/api/me/assistants/:assistantId/activate', async (c) => {
    const assistant = await ownedAssistant(c.env, c.get('userId'), c.req.param('assistantId'));
    if (!assistant) return c.json({ error: 'Not found' }, 404);
    if (!assistant.name.trim() || !assistant.language.trim() || !assistant.persona.trim()) {
      return c.json({ error: 'Complete the assistant essentials before activation' }, 400);
    }
    await c.env.DB.prepare(
      "UPDATE assistants SET state='active', activated_at=COALESCE(activated_at, datetime('now')), updated_at=datetime('now') WHERE id=?"
    )
      .bind(assistant.id)
      .run();
    return c.json({ ok: true, state: 'active' });
  });

  app.post('/api/me/assistants/:assistantId/pause', async (c) => {
    const assistant = await ownedAssistant(c.env, c.get('userId'), c.req.param('assistantId'));
    if (!assistant) return c.json({ error: 'Not found' }, 404);
    await c.env.DB.prepare("UPDATE assistants SET state='paused', updated_at=datetime('now') WHERE id=?")
      .bind(assistant.id)
      .run();
    return c.json({ ok: true, state: 'paused' });
  });

  app.post('/api/me/assistants/:assistantId/test-calls', async (c) => {
    const assistant = await ownedAssistant(c.env, c.get('userId'), c.req.param('assistantId'));
    if (!assistant) return c.json({ error: 'Not found' }, 404);
    const callId = newId();
    await c.env.DB.prepare(
      `INSERT INTO calls (id, business_id, assistant_id, channel, caller_id, environment, direction)
       VALUES (?, ?, ?, 'web', ?, 'test', 'inbound')`
    )
      .bind(callId, assistant.business_id, assistant.id, `owner:${c.get('userId')}`)
      .run();
    return c.json({ callId, assistantId: assistant.id, environment: 'test' }, 201);
  });

  app.get('/api/me/calls', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json({ items: [], nextCursor: null });
    const q = c.req.query();
    const limit = Math.min(100, Math.max(1, Number.parseInt(q.limit ?? '30', 10) || 30));
    const conditions = ['calls.business_id = ?'];
    const args: unknown[] = [workspace.id];
    const environment = q.environment === 'all' ? null : q.environment === 'test' ? 'test' : 'live';
    if (environment) (conditions.push('calls.environment = ?'), args.push(environment));
    if (q.assistantId) (conditions.push('calls.assistant_id = ?'), args.push(q.assistantId));
    if (q.status) (conditions.push('calls.status = ?'), args.push(q.status));
    if (q.intent) (conditions.push('calls.intent = ?'), args.push(q.intent));
    if (q.direction === 'inbound' || q.direction === 'outbound') {
      conditions.push('calls.direction = ?');
      args.push(q.direction);
    }
    if (q.from) (conditions.push('calls.started_at >= ?'), args.push(q.from));
    if (q.to) (conditions.push('calls.started_at < ?'), args.push(q.to));
    if (q.search?.trim()) {
      conditions.push(
        `(calls.caller_id LIKE ? ESCAPE '\\' OR calls.summary LIKE ? ESCAPE '\\' OR EXISTS (
          SELECT 1 FROM call_turns WHERE call_turns.call_id = calls.id AND call_turns.text LIKE ? ESCAPE '\\'
        ))`
      );
      const term = likeTerm(q.search.trim());
      args.push(term, term, term);
    }
    const cursor = decodeCursor(q.cursor);
    if (q.cursor && !cursor) return c.json({ error: 'Invalid cursor' }, 400);
    if (cursor) {
      conditions.push('(calls.started_at < ? OR (calls.started_at = ? AND calls.id < ?))');
      args.push(cursor[0], cursor[0], cursor[1]);
    }
    const { results } = await c.env.DB.prepare(
      `SELECT calls.*, assistants.name AS assistant_name, assistants.public_slug AS assistant_slug
       FROM calls LEFT JOIN assistants ON assistants.id = calls.assistant_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY calls.started_at DESC, calls.id DESC LIMIT ?`
    )
      .bind(...args, limit + 1)
      .all<Record<string, unknown> & { id: string; started_at: string }>();
    const hasMore = results.length > limit;
    const items = results.slice(0, limit);
    const last = items.at(-1);
    return c.json({ items, nextCursor: hasMore && last ? encodeCursor(last.started_at, last.id) : null });
  });

  app.get('/api/me/overview', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    const parsed = Number.parseInt(c.req.query('days') ?? '30', 10);
    const days = parsed === 7 || parsed === 90 ? parsed : 30;
    if (!workspace) return c.json({ days, metrics: { total: 0 }, recentCalls: [] });
    const since = `-${days} days`;
    const [metrics, recent] = await Promise.all([
      c.env.DB.prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN intent = 'message' OR message_json IS NOT NULL THEN 1 ELSE 0 END) AS messages,
          SUM(CASE WHEN intent = 'booking' THEN 1 ELSE 0 END) AS booking_requests,
          COALESCE(SUM(duration_s), 0) AS talk_time_s,
          COALESCE(AVG(CASE WHEN status = 'completed' THEN duration_s END), 0) AS average_duration_s
         FROM calls WHERE business_id = ? AND environment = 'live' AND started_at >= datetime('now', ?)`
      )
        .bind(workspace.id, since)
        .first(),
      c.env.DB.prepare(
        `SELECT calls.*, assistants.name AS assistant_name FROM calls
          LEFT JOIN assistants ON assistants.id = calls.assistant_id
         WHERE calls.business_id = ? AND calls.environment = 'live'
         ORDER BY calls.started_at DESC, calls.id DESC LIMIT 8`
      )
        .bind(workspace.id)
        .all(),
    ]);
    return c.json({ days, metrics, recentCalls: recent.results });
  });

  app.get('/api/me/knowledge/collections', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json([]);
    const { results } = await c.env.DB.prepare(
      `SELECT knowledge_collections.*,
        COUNT(DISTINCT knowledge_items.id) AS item_count,
        COUNT(DISTINCT CASE WHEN knowledge_items.status = 'active' THEN knowledge_items.id END) AS active_item_count,
        GROUP_CONCAT(DISTINCT assistant_knowledge_collections.assistant_id) AS assistant_ids
       FROM knowledge_collections
       LEFT JOIN knowledge_items ON knowledge_items.collection_id = knowledge_collections.id
       LEFT JOIN assistant_knowledge_collections ON assistant_knowledge_collections.collection_id = knowledge_collections.id
       WHERE knowledge_collections.business_id = ?
       GROUP BY knowledge_collections.id ORDER BY knowledge_collections.is_default DESC, knowledge_collections.created_at`
    )
      .bind(workspace.id)
      .all();
    return c.json(results);
  });

  app.post('/api/me/knowledge/collections', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json({ error: 'Create a workspace first' }, 409);
    const body = await c.req.json<{ name?: string; description?: string }>();
    if (!body.name?.trim()) return c.json({ error: 'Collection name required' }, 400);
    const duplicate = await c.env.DB.prepare('SELECT id FROM knowledge_collections WHERE business_id = ? AND name = ?')
      .bind(workspace.id, body.name.trim())
      .first();
    if (duplicate) return c.json({ error: 'A collection with this name already exists' }, 409);
    const id = newId();
    await c.env.DB.prepare(
      'INSERT INTO knowledge_collections (id, business_id, name, description) VALUES (?, ?, ?, ?)'
    )
      .bind(id, workspace.id, body.name.trim(), body.description?.trim() ?? '')
      .run();
    const row = await c.env.DB.prepare('SELECT * FROM knowledge_collections WHERE id = ?').bind(id).first();
    return c.json(row, 201);
  });

  app.get('/api/me/knowledge/collections/:collectionId', async (c) => {
    const collection = await ownedCollection(c.env, c.get('userId'), c.req.param('collectionId'));
    if (!collection) return c.json({ error: 'Not found' }, 404);
    const { results: items } = await c.env.DB.prepare(
      'SELECT * FROM knowledge_items WHERE collection_id = ? ORDER BY status, created_at, id'
    )
      .bind(collection.id)
      .all();
    const { results: assistants } = await c.env.DB.prepare(
      `SELECT assistants.id, assistants.name, assistants.state FROM assistants
        JOIN assistant_knowledge_collections ON assistant_knowledge_collections.assistant_id = assistants.id
       WHERE assistant_knowledge_collections.collection_id = ? ORDER BY assistants.name`
    )
      .bind(collection.id)
      .all();
    return c.json({ ...collection, items, assistants });
  });

  app.put('/api/me/knowledge/collections/:collectionId', async (c) => {
    const collection = await ownedCollection(c.env, c.get('userId'), c.req.param('collectionId'));
    if (!collection) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json<{ name?: string; description?: string }>();
    const name = body.name?.trim() || collection.name;
    const duplicate = await c.env.DB.prepare(
      'SELECT id FROM knowledge_collections WHERE business_id = ? AND name = ? AND id != ?'
    )
      .bind(collection.business_id, name, collection.id)
      .first();
    if (duplicate) return c.json({ error: 'A collection with this name already exists' }, 409);
    await c.env.DB.prepare(
      "UPDATE knowledge_collections SET name=?, description=?, updated_at=datetime('now') WHERE id=?"
    )
      .bind(name, body.description ?? collection.description, collection.id)
      .run();
    return c.json({ ok: true });
  });

  app.delete('/api/me/knowledge/collections/:collectionId', async (c) => {
    const collection = await ownedCollection(c.env, c.get('userId'), c.req.param('collectionId'));
    if (!collection) return c.json({ error: 'Not found' }, 404);
    if (collection.is_default) return c.json({ error: 'The default collection cannot be deleted' }, 409);
    await c.env.DB.prepare('DELETE FROM knowledge_collections WHERE id = ?').bind(collection.id).run();
    return c.json({ ok: true });
  });

  app.get('/api/me/knowledge/collections/:collectionId/items', async (c) => {
    const collection = await ownedCollection(c.env, c.get('userId'), c.req.param('collectionId'));
    if (!collection) return c.json({ error: 'Not found' }, 404);
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM knowledge_items WHERE collection_id = ? ORDER BY status, created_at, id'
    )
      .bind(collection.id)
      .all();
    return c.json(results);
  });

  app.post('/api/me/knowledge/collections/:collectionId/items', async (c) => {
    const collection = await ownedCollection(c.env, c.get('userId'), c.req.param('collectionId'));
    if (!collection) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json<Partial<KnowledgeItem>>();
    const kind = normalizedKind(body.kind);
    if (!kind) return c.json({ error: 'Knowledge kind must be faq, service, or note' }, 400);
    const candidate = {
      kind,
      title: body.title?.trim() ?? '',
      question: body.question?.trim() ?? '',
      answer: body.answer?.trim() ?? '',
      content: body.content?.trim() ?? '',
    };
    const status = normalizedStatus(body.status) ?? 'draft';
    if (status === 'active' && !itemReady(candidate)) return c.json({ error: 'Complete the item before activation' }, 400);
    const id = newId();
    await c.env.DB.prepare(
      `INSERT INTO knowledge_items (
        id, business_id, collection_id, kind, status, title, question, answer, content, activated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'active' THEN datetime('now') ELSE NULL END)`
    )
      .bind(
        id,
        collection.business_id,
        collection.id,
        candidate.kind,
        status,
        candidate.title,
        candidate.question,
        candidate.answer,
        candidate.content,
        status
      )
      .run();
    const row = await c.env.DB.prepare('SELECT * FROM knowledge_items WHERE id = ?').bind(id).first();
    return c.json(row, 201);
  });

  app.get('/api/me/knowledge/items/:itemId', async (c) => {
    const item = await ownedItem(c.env, c.get('userId'), c.req.param('itemId'));
    return item ? c.json(item) : c.json({ error: 'Not found' }, 404);
  });

  app.put('/api/me/knowledge/items/:itemId', async (c) => {
    const item = await ownedItem(c.env, c.get('userId'), c.req.param('itemId'));
    if (!item) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json<Partial<KnowledgeItem>>();
    let collectionId = body.collection_id ?? item.collection_id;
    if (collectionId !== item.collection_id) {
      const collection = await ownedCollection(c.env, c.get('userId'), collectionId);
      if (!collection || collection.business_id !== item.business_id) return c.json({ error: 'Collection not found' }, 404);
      collectionId = collection.id;
    }
    const candidate = {
      kind: normalizedKind(body.kind) ?? item.kind,
      title: body.title?.trim() ?? item.title,
      question: body.question?.trim() ?? item.question,
      answer: body.answer?.trim() ?? item.answer,
      content: body.content?.trim() ?? item.content,
    };
    const status = normalizedStatus(body.status) ?? item.status;
    if (status === 'active' && !itemReady(candidate)) return c.json({ error: 'Complete the item before activation' }, 400);
    await c.env.DB.prepare(
      `UPDATE knowledge_items SET collection_id=?, kind=?, status=?, title=?, question=?, answer=?, content=?,
        updated_at=datetime('now'),
        activated_at=CASE WHEN ?='active' THEN COALESCE(activated_at, datetime('now')) ELSE NULL END
       WHERE id=?`
    )
      .bind(
        collectionId,
        candidate.kind,
        status,
        candidate.title,
        candidate.question,
        candidate.answer,
        candidate.content,
        status,
        item.id
      )
      .run();
    const row = await c.env.DB.prepare('SELECT * FROM knowledge_items WHERE id = ?').bind(item.id).first();
    return c.json(row);
  });

  app.delete('/api/me/knowledge/items/:itemId', async (c) => {
    const item = await ownedItem(c.env, c.get('userId'), c.req.param('itemId'));
    if (!item) return c.json({ error: 'Not found' }, 404);
    await c.env.DB.prepare('DELETE FROM knowledge_items WHERE id = ?').bind(item.id).run();
    return c.json({ ok: true });
  });

  app.post('/api/me/knowledge/drafts/from-turn', async (c) => {
    const body = await c.req.json<{ callId?: string; turnId?: number; collectionId?: string }>();
    if (!body.callId || !Number.isInteger(body.turnId)) return c.json({ error: 'Call and caller turn required' }, 400);
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json({ error: 'Not found' }, 404);
    const turn = await c.env.DB.prepare(
      `SELECT call_turns.id, call_turns.text, call_turns.role FROM call_turns
        JOIN calls ON calls.id = call_turns.call_id
       WHERE call_turns.id = ? AND call_turns.call_id = ? AND calls.business_id = ?`
    )
      .bind(body.turnId, body.callId, workspace.id)
      .first<{ id: number; text: string; role: string }>();
    if (!turn || turn.role !== 'caller') return c.json({ error: 'Caller turn not found' }, 404);
    let collection: KnowledgeCollection | null = null;
    if (body.collectionId) collection = await ownedCollection(c.env, c.get('userId'), body.collectionId);
    else {
      collection = await c.env.DB.prepare(
        'SELECT * FROM knowledge_collections WHERE business_id = ? AND is_default = 1 LIMIT 1'
      )
        .bind(workspace.id)
        .first<KnowledgeCollection>();
    }
    if (!collection || collection.business_id !== workspace.id) return c.json({ error: 'Collection not found' }, 404);
    const id = newId();
    await c.env.DB.prepare(
      `INSERT INTO knowledge_items (
        id, business_id, collection_id, kind, status, question, answer, source_call_id, source_turn_id
       ) VALUES (?, ?, ?, 'faq', 'draft', ?, '', ?, ?)`
    )
      .bind(id, workspace.id, collection.id, turn.text.trim(), body.callId, turn.id)
      .run();
    const row = await c.env.DB.prepare('SELECT * FROM knowledge_items WHERE id = ?').bind(id).first();
    return c.json(row, 201);
  });

  app.post('/api/me/assistants/:assistantId/knowledge-collections/:collectionId', async (c) => {
    const [assistant, collection] = await Promise.all([
      ownedAssistant(c.env, c.get('userId'), c.req.param('assistantId')),
      ownedCollection(c.env, c.get('userId'), c.req.param('collectionId')),
    ]);
    if (!assistant || !collection || assistant.business_id !== collection.business_id) return c.json({ error: 'Not found' }, 404);
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO assistant_knowledge_collections (assistant_id, collection_id) VALUES (?, ?)'
    )
      .bind(assistant.id, collection.id)
      .run();
    return c.json({ ok: true });
  });

  app.delete('/api/me/assistants/:assistantId/knowledge-collections/:collectionId', async (c) => {
    const [assistant, collection] = await Promise.all([
      ownedAssistant(c.env, c.get('userId'), c.req.param('assistantId')),
      ownedCollection(c.env, c.get('userId'), c.req.param('collectionId')),
    ]);
    if (!assistant || !collection || assistant.business_id !== collection.business_id) return c.json({ error: 'Not found' }, 404);
    await c.env.DB.prepare('DELETE FROM assistant_knowledge_collections WHERE assistant_id = ? AND collection_id = ?')
      .bind(assistant.id, collection.id)
      .run();
    return c.json({ ok: true });
  });

  app.get('/api/me/provider', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json({ error: 'Create a workspace first' }, 409);
    const provider = await c.env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?')
      .bind(workspace.id)
      .first<ProviderSettings>();
    return c.json({
      baseUrl: provider?.llm_base_url || c.env.DEFAULT_LLM_BASE_URL,
      usesInstanceDefault: !provider?.llm_base_url || sameLlmEndpoint(provider.llm_base_url, c.env.DEFAULT_LLM_BASE_URL),
      apiKeyConfigured: providerConfigured(c.env, provider),
      updatedAt: provider?.updated_at ?? null,
    });
  });

  app.put('/api/me/provider', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json({ error: 'Create a workspace first' }, 409);
    const current = await c.env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?')
      .bind(workspace.id)
      .first<ProviderSettings>();
    const body = await c.req.json<{ baseUrl?: string; apiKey?: string | null }>();
    const baseUrl = body.baseUrl !== undefined ? body.baseUrl.trim() : current?.llm_base_url ?? '';
    const apiKey = body.apiKey !== undefined ? body.apiKey?.trim() ?? '' : current?.llm_api_key ?? '';
    const bad = providerValidationError(c.env, baseUrl, apiKey);
    if (bad) return c.json({ error: bad }, 400);
    await c.env.DB.prepare(
      `INSERT INTO provider_settings (business_id, llm_base_url, llm_api_key)
       VALUES (?, ?, ?)
       ON CONFLICT(business_id) DO UPDATE SET
         llm_base_url=excluded.llm_base_url,
         llm_api_key=excluded.llm_api_key,
         updated_at=datetime('now')`
    )
      .bind(workspace.id, baseUrl, apiKey)
      .run();
    return c.json({ ok: true, apiKeyConfigured: providerConfigured(c.env, { ...(current ?? {}), llm_base_url: baseUrl, llm_api_key: apiKey } as ProviderSettings) });
  });

  app.post('/api/me/provider/check', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json({ error: 'Create a workspace first' }, 409);
    const body: { assistantId?: string } = await c.req.json<{ assistantId?: string }>().catch(() => ({}));
    let assistant: Assistant | null = null;
    if (body.assistantId) assistant = await ownedAssistant(c.env, c.get('userId'), body.assistantId);
    else {
      assistant = await c.env.DB.prepare('SELECT * FROM assistants WHERE business_id = ? ORDER BY created_at LIMIT 1')
        .bind(workspace.id)
        .first<Assistant>();
    }
    if (!assistant) return c.json({ error: 'Create an assistant first' }, 409);
    const provider = await c.env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?')
      .bind(workspace.id)
      .first<ProviderSettings>();
    try {
      const cfg = resolveLlm(c.env, settingsForProvider(assistant, provider));
      await chatComplete(
        cfg,
        [
          { role: 'system', content: 'Reply with only OK.' },
          { role: 'user', content: 'Connection check' },
        ],
        { maxTokens: 2, temperature: 0 }
      );
      return c.json({ ok: true, model: cfg.model });
    } catch (error) {
      if (error instanceof LlmConfigError) return c.json({ error: error.message }, 400);
      return c.json({ error: 'Provider check failed. Verify the endpoint, API key, and model.' }, 502);
    }
  });

  app.get('/api/me/engine-presets', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json([]);
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM engine_presets WHERE business_id = ? ORDER BY created_at, id'
    )
      .bind(workspace.id)
      .all();
    return c.json(results);
  });

  app.post('/api/me/engine-presets', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json({ error: 'Create a workspace first' }, 409);
    const body = await c.req.json<Record<string, unknown>>();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ error: 'Preset name required' }, 400);
    const id = newId();
    await c.env.DB.prepare(
      `INSERT INTO engine_presets (
        id, business_id, name, engine, realtime_model, realtime_voice, language, voice, llm_model
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        workspace.id,
        name,
        body.engine === 'realtime' ? 'realtime' : 'pipeline',
        typeof body.realtime_model === 'string' ? body.realtime_model : '',
        typeof body.realtime_voice === 'string' ? body.realtime_voice : '',
        typeof body.language === 'string' ? body.language : 'en',
        typeof body.voice === 'string' ? body.voice : '',
        typeof body.llm_model === 'string' ? body.llm_model : ''
      )
      .run();
    const row = await c.env.DB.prepare('SELECT * FROM engine_presets WHERE id = ?').bind(id).first();
    return c.json(row, 201);
  });

  app.post('/api/me/engine-presets/:presetId/apply', async (c) => {
    const body = await c.req.json<{ assistantId?: string }>();
    if (!body.assistantId) return c.json({ error: 'Assistant id required' }, 400);
    const assistant = await ownedAssistant(c.env, c.get('userId'), body.assistantId);
    const preset = await c.env.DB.prepare(
      `SELECT engine_presets.* FROM engine_presets
        JOIN businesses ON businesses.id = engine_presets.business_id
       WHERE engine_presets.id = ? AND businesses.user_id = ?`
    )
      .bind(c.req.param('presetId'), c.get('userId'))
      .first<Record<string, string>>();
    if (!assistant || !preset || assistant.business_id !== preset.business_id) return c.json({ error: 'Not found' }, 404);
    await c.env.DB.prepare(
      `UPDATE assistants SET engine=?, realtime_model=?, realtime_voice=?, language=?, voice=?, llm_model=?, updated_at=datetime('now')
       WHERE id=?`
    )
      .bind(
        preset.engine,
        preset.realtime_model,
        preset.realtime_voice,
        preset.language,
        preset.voice,
        preset.llm_model,
        assistant.id
      )
      .run();
    return c.json({ ok: true });
  });

  app.put('/api/me/engine-presets/:presetId', async (c) => {
    const preset = await c.env.DB.prepare(
      `SELECT engine_presets.* FROM engine_presets
        JOIN businesses ON businesses.id = engine_presets.business_id
       WHERE engine_presets.id = ? AND businesses.user_id = ?`
    )
      .bind(c.req.param('presetId'), c.get('userId'))
      .first<Record<string, string>>();
    if (!preset) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json<Record<string, unknown>>();
    const value = (key: string) => (typeof body[key] === 'string' ? body[key] as string : preset[key]);
    await c.env.DB.prepare(
      `UPDATE engine_presets SET name=?, engine=?, realtime_model=?, realtime_voice=?, language=?, voice=?, llm_model=?, updated_at=datetime('now')
       WHERE id=?`
    )
      .bind(
        value('name').trim() || preset.name,
        body.engine === 'realtime' ? 'realtime' : body.engine === 'pipeline' ? 'pipeline' : preset.engine,
        value('realtime_model'),
        value('realtime_voice'),
        value('language'),
        value('voice'),
        value('llm_model'),
        preset.id
      )
      .run();
    return c.json({ ok: true });
  });

  app.delete('/api/me/engine-presets/:presetId', async (c) => {
    const preset = await c.env.DB.prepare(
      `SELECT engine_presets.id FROM engine_presets
        JOIN businesses ON businesses.id = engine_presets.business_id
       WHERE engine_presets.id = ? AND businesses.user_id = ?`
    )
      .bind(c.req.param('presetId'), c.get('userId'))
      .first<{ id: string }>();
    if (!preset) return c.json({ error: 'Not found' }, 404);
    await c.env.DB.prepare('DELETE FROM engine_presets WHERE id = ?').bind(preset.id).run();
    return c.json({ ok: true });
  });
}
