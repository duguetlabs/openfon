import { checkedPresetWriteSql, checkedPresetWrite, checkedPresetSourceSql, checkedPresetSource } from './preset-write-snapshot';
import { CHECKED_ASSISTANT_SNAPSHOT_SQL, checkedAssistantSnapshot } from './assistant-write-snapshot';
import { PRESET_RECONCILIATION_SQL, PRESET_CHANGED_SQL, assertPresetWriteBudget, PRESET_LIST_COLUMNS, PRESET_ROW_BYTES } from './preset-budgets';
import { CHECKED_REALTIME_PROVIDER_SQL, checkedRealtimeProvider, providerUpdate, assistantCompatibilityError, presetCompatibilityError, ProviderInputError, TEXT_PRESETS, OPENAI_REALTIME_VOICES } from './provider-settings';
import type { Hono } from 'hono';
import { readWorkspaceBody } from './request-validation';
import { newId } from './auth';
import { chatComplete, LlmConfigError, LlmRequestError, resolveLlm, sameLlmEndpoint, validateLlmBaseUrl } from './providers';
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

const STUDIO_SPEND_PER_MINUTE = 10;
const TEST_CALLS_PER_DAY = 100;
const PROVIDER_CHECKS_PER_DAY = 50;
const STUDIO_SPEND_PER_IP_PER_MINUTE = 20;
// One account can legitimately spend the full route-specific daily allowances,
// but creating more accounts must not reset the instance's exposure to the
// default provider key. This shared IP bucket spans every workspace and both
// studio-spending routes.
const STUDIO_SPEND_PER_IP_PER_DAY = TEST_CALLS_PER_DAY + PROVIDER_CHECKS_PER_DAY;
const DAY_SECONDS = 86_400;

export function fixedWindowRetryAfter(windowSeconds: number, now = Date.now()): number {
  const elapsed = Math.floor(now / 1000) % windowSeconds;
  return windowSeconds - elapsed;
}

function sqliteTimestampMs(value: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  return Date.parse(normalized);
}

function rollingDayRetryAfter(oldestStartedAt: string | undefined, now = Date.now()): number {
  if (!oldestStartedAt) return DAY_SECONDS;
  const startedAt = sqliteTimestampMs(oldestStartedAt);
  if (!Number.isFinite(startedAt)) return DAY_SECONDS;
  return Math.min(DAY_SECONDS, Math.max(1, Math.ceil((startedAt + DAY_SECONDS * 1000 - now) / 1000)));
}

async function testCallDayState(
  env: Env,
  businessId: string,
  now: number
): Promise<{ count: number; oldest_started_at: string | null }> {
  return (
    (await env.DB.prepare(
      `SELECT COUNT(*) AS count, MIN(started_at) AS oldest_started_at FROM calls
        WHERE business_id=? AND environment='test'
          AND started_at > datetime(?, 'unixepoch', '-1 day')`
    )
      .bind(businessId, now / 1000)
      .first<{ count: number; oldest_started_at: string | null }>()) ?? { count: 0, oldest_started_at: null }
  );
}

const AGENT_SNAPSHOT_SQL = `json_object(
  'agent_name', agent_settings.agent_name, 'greeting', agent_settings.greeting,
  'persona', agent_settings.persona, 'language', agent_settings.language,
  'voice', agent_settings.voice, 'take_messages', agent_settings.take_messages,
  'custom_instructions', agent_settings.custom_instructions, 'engine', agent_settings.engine,
  'realtime_model', agent_settings.realtime_model, 'realtime_voice', agent_settings.realtime_voice,
  'llm_model', agent_settings.llm_model
)`;

function updateAgentSnapshot(env: Env, businessId: string, afterMutation = false): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE compatibility_sync_state SET agent_snapshot=(
       SELECT ${AGENT_SNAPSHOT_SQL} FROM agent_settings WHERE business_id=?
     ), synced_at=datetime('now') WHERE business_id=?${afterMutation ? ' AND changes()>0' : ''}`
  ).bind(businessId, businessId);
}

interface StudioReservation {
  bucket: string;
  windowStart: number;
}

function studioWindowStart(windowSeconds: number, now = Date.now()): number {
  return Math.floor(now / 1000 / windowSeconds) * windowSeconds;
}

async function reserveStudioSpend(
  env: Env,
  subject: string,
  suffix: string,
  windowSeconds: number,
  max: number,
  now: number
): Promise<StudioReservation | null> {
  const windowStart = studioWindowStart(windowSeconds, now);
  const bucket = `studio:${suffix}:${subject}`;
  const row = await env.DB.prepare(
    `INSERT INTO rate_counters (bucket, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(bucket, window_start) DO UPDATE SET count=rate_counters.count + 1
       WHERE rate_counters.count < ?
     RETURNING count`
  )
    .bind(bucket, windowStart, max)
    .first<{ count: number }>();
  return row ? { bucket, windowStart } : null;
}

async function refundStudioSpend(env: Env, reservations: readonly StudioReservation[]): Promise<void> {
  if (!reservations.length) return;
  // The original window is part of each token. Recomputing it here would leak
  // capacity whenever a request crosses a minute/day boundary before a later
  // gate rejects. Decrement first, then remove a now-empty row so a rejected
  // action leaves no new counter record behind.
  const statements: D1PreparedStatement[] = [];
  for (const reservation of [...reservations].reverse()) {
    statements.push(
      env.DB.prepare(
        'UPDATE rate_counters SET count=count-1 WHERE bucket=? AND window_start=? AND count>0'
      ).bind(reservation.bucket, reservation.windowStart),
      env.DB.prepare('DELETE FROM rate_counters WHERE bucket=? AND window_start=? AND count=0').bind(
        reservation.bucket,
        reservation.windowStart
      )
    );
  }
  await env.DB.batch(statements);
}

async function studioSpendAtLimit(
  env: Env,
  subject: string,
  suffix: string,
  windowSeconds: number,
  max: number,
  now: number
): Promise<boolean> {
  const row = await env.DB.prepare('SELECT count FROM rate_counters WHERE bucket=? AND window_start=?')
    .bind(`studio:${suffix}:${subject}`, studioWindowStart(windowSeconds, now))
    .first<{ count: number }>();
  return (row?.count ?? 0) >= max;
}

function studioClientIp(connectingIp: string | undefined): string {
  // Cloudflare supplies this at the edge. Development and self-hosted requests
  // without it deliberately share one conservative bucket instead of getting
  // an unbounded fresh subject per request.
  return connectingIp?.trim() || 'local';
}

async function reserveStudioIpSpend(
  env: Env,
  connectingIp: string | undefined,
  now: number
): Promise<{ blocked: 'minute' | 'day' | null; reservations: StudioReservation[] }> {
  const subject = studioClientIp(connectingIp);
  const minute = await reserveStudioSpend(env, subject, 'ip-minute', 60, STUDIO_SPEND_PER_IP_PER_MINUTE, now);
  if (!minute) {
    return { blocked: 'minute', reservations: [] };
  }
  const day = await reserveStudioSpend(env, subject, 'ip-day', DAY_SECONDS, STUDIO_SPEND_PER_IP_PER_DAY, now);
  if (!day) {
    return { blocked: 'day', reservations: [minute] };
  }
  return { blocked: null, reservations: [minute, day] };
}

async function studioIpLimitAtCapacity(
  env: Env,
  connectingIp: string | undefined,
  now: number
): Promise<'minute' | 'day' | null> {
  const subject = studioClientIp(connectingIp);
  if (await studioSpendAtLimit(env, subject, 'ip-minute', 60, STUDIO_SPEND_PER_IP_PER_MINUTE, now)) {
    return 'minute';
  }
  if (await studioSpendAtLimit(env, subject, 'ip-day', DAY_SECONDS, STUDIO_SPEND_PER_IP_PER_DAY, now)) {
    return 'day';
  }
  return null;
}

function recordArray(raw: string): Record<string, unknown>[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
      : [];
  } catch {
    return [];
  }
}

function textField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key].trim() : '';
}

function optionalTextFields(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => record[key] === undefined || typeof record[key] === 'string');
}

interface LegacyServiceProjection {
  sourceIndex: number;
  name: string;
  price: string;
  duration: string;
  notes: string;
}

interface LegacyFaqProjection {
  sourceIndex: number;
  question: string;
  answer: string;
}

function projectedLegacyServices(raw: string): LegacyServiceProjection[] {
  const services: LegacyServiceProjection[] = [];
  recordArray(raw).forEach((service, sourceIndex) => {
    // Match the compatibility editors: a malformed optional field invalidates
    // the whole row. Treating {name: 'X', price: 5} as projected here while the
    // UI drops it would make cleanup look like an intentional deletion.
    if (typeof service.name !== 'string' || !optionalTextFields(service, ['price', 'duration', 'notes'])) return;
    const name = service.name.trim();
    if (!name) return;
    services.push({
      sourceIndex,
      name,
      price: textField(service, 'price'),
      duration: textField(service, 'duration'),
      notes: textField(service, 'notes'),
    });
  });
  return services;
}

function projectedLegacyFaqs(raw: string): LegacyFaqProjection[] {
  const faqs: LegacyFaqProjection[] = [];
  recordArray(raw).forEach((faq, sourceIndex) => {
    if (typeof faq.q !== 'string' || typeof faq.a !== 'string') return;
    const question = faq.q.trim();
    const answer = faq.a.trim();
    if (!question || !answer) return;
    faqs.push({ sourceIndex, question, answer });
  });
  return faqs;
}

export function sameLegacyKnowledgeProjection(
  kind: 'service' | 'faq',
  left: string,
  right: string
): boolean {
  if (left === right) return true;
  if (kind === 'service') {
    const signature = (raw: string) =>
      projectedLegacyServices(raw).map(({ name, price, duration, notes }) => ({ name, price, duration, notes }));
    return JSON.stringify(signature(left)) === JSON.stringify(signature(right));
  }
  const signature = (raw: string) =>
    projectedLegacyFaqs(raw).map(({ question, answer }) => ({ question, answer }));
  return JSON.stringify(signature(left)) === JSON.stringify(signature(right));
}

interface LegacyKnowledgeRow {
  id: string;
  collection_id: string;
  kind: 'faq' | 'service';
  status: 'active';
  title: string;
  question: string;
  answer: string;
  content: string;
}

function expectedLegacyKnowledge(
  businessId: string,
  collectionId: string,
  servicesJson: string,
  faqsJson: string
): LegacyKnowledgeRow[] {
  const rows: LegacyKnowledgeRow[] = [];
  projectedLegacyServices(servicesJson).forEach((service) => {
    const details = [service.price, service.duration].filter(Boolean).join(' · ');
    rows.push({
      id: `legacy_${businessId}_service_${service.sourceIndex}`,
      collection_id: collectionId,
      kind: 'service',
      status: 'active',
      title: service.name,
      question: '',
      answer: '',
      content: details && service.notes ? `${details} — ${service.notes}` : details || service.notes,
    });
  });
  projectedLegacyFaqs(faqsJson).forEach((faq) => {
    rows.push({
      id: `legacy_${businessId}_faq_${faq.sourceIndex}`,
      collection_id: collectionId,
      kind: 'faq',
      status: 'active',
      title: '',
      question: faq.question,
      answer: faq.answer,
      content: '',
    });
  });
  return rows;
}

export async function syncLegacyKnowledge(
  env: Env,
  workspace: Pick<Business, 'id' | 'services_json' | 'faqs_json'>,
  collectionId?: string,
  changed: { services: boolean; faqs: boolean } = { services: true, faqs: true },
  leadingStatements: D1PreparedStatement[] = []
): Promise<void> {
  const collection = collectionId
    ? { id: collectionId }
    : await env.DB.prepare(
        'SELECT id FROM knowledge_collections WHERE business_id = ? AND is_default = 1 ORDER BY created_at, id LIMIT 1'
      )
        .bind(workspace.id)
        .first<{ id: string }>();
  if (!collection) {
    if (leadingStatements.length) throw new Error('OPENFON_KNOWLEDGE_COLLECTION_MISSING');
    return;
  }
  const expected = expectedLegacyKnowledge(workspace.id, collection.id, workspace.services_json, workspace.faqs_json);
  const replacement = expected.filter(entry => entry.kind === 'service' ? changed.services : changed.faqs);
  // Refuse known quota failures before any compatibility source/counter writes.
  // SQLite triggers independently enforce the same limits against concurrent writers.
  const retained = await env.DB.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(length(CAST(kind AS BLOB))+length(CAST(title AS BLOB))+length(CAST(question AS BLOB))+
        length(CAST(answer AS BLOB))+length(CAST(content AS BLOB))),0) AS bytes
      FROM knowledge_items WHERE business_id=? AND NOT (
        (? AND (instr(id,?)=1 OR instr(id,?)=1)) OR (? AND (instr(id,?)=1 OR instr(id,?)=1)))`)
    .bind(workspace.id, Number(changed.services), `ki_service_${workspace.id}_`, `legacy_${workspace.id}_service_`,
      Number(changed.faqs), `ki_faq_${workspace.id}_`, `legacy_${workspace.id}_faq_`)
    .first<{ count: number; bytes: number }>();
  const encoder = new TextEncoder();
  const bytes = replacement.reduce((total, row) => total + [row.kind,row.title,row.question,row.answer,row.content]
    .reduce((size, value) => size + encoder.encode(value).byteLength, 0), 0);
  if ((retained?.count ?? 0) + replacement.length > 500 || (retained?.bytes ?? 0) + bytes > 2097152) {
    throw new Error('OPENFON_KNOWLEDGE_STORAGE_LIMIT');
  }
  const budget = await env.DB.prepare(`SELECT count FROM rate_counters WHERE bucket=?
      AND window_start=CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400`)
    .bind(`knowledge:${workspace.id}`).first<{ count: number }>();
  if ((budget?.count ?? 0) + replacement.length > 500) throw new Error('OPENFON_KNOWLEDGE_WRITE_LIMIT');
  const statements: D1PreparedStatement[] = [...leadingStatements];
  if (changed.services) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM knowledge_items WHERE business_id = ? AND (
          instr(id, ?) = 1 OR instr(id, ?) = 1
        )`
      ).bind(workspace.id, `ki_service_${workspace.id}_`, `legacy_${workspace.id}_service_`)
    );
  }
  if (changed.faqs) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM knowledge_items WHERE business_id = ? AND (
          instr(id, ?) = 1 OR instr(id, ?) = 1
        )`
      ).bind(workspace.id, `ki_faq_${workspace.id}_`, `legacy_${workspace.id}_faq_`)
    );
  }
  for (const row of replacement) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO knowledge_items (
          id, business_id, collection_id, kind, status, title, question, answer, content, activated_at
         ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, datetime('now'))`
      ).bind(
        row.id,
        workspace.id,
        row.collection_id,
        row.kind,
        row.title,
        row.question,
        row.answer,
        row.content
      )
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO compatibility_sync_state (business_id, services_json, faqs_json, collection_id, agent_snapshot)
       SELECT ?, ?, ?, ?, ${AGENT_SNAPSHOT_SQL} FROM agent_settings WHERE business_id=?
       ON CONFLICT(business_id) DO UPDATE SET services_json=excluded.services_json,
         faqs_json=excluded.faqs_json, collection_id=excluded.collection_id,
         synced_at=datetime('now')`
    ).bind(workspace.id, workspace.services_json, workspace.faqs_json, collection.id, workspace.id)
  );
  await env.DB.batch(statements);
}

export async function ensureWorkspaceFoundation(
  env: Env,
  workspace: Pick<Business, 'id' | 'slug' | 'services_json' | 'faqs_json'>
): Promise<void> {
  let [legacy, assistant, provider, presetReconciliation, defaultCollection] = await Promise.all([
    env.DB.prepare('SELECT * FROM agent_settings WHERE business_id = ?').bind(workspace.id).first<AgentSettings>(),
    env.DB.prepare('SELECT * FROM assistants WHERE business_id = ? AND public_slug = ? LIMIT 1')
      .bind(workspace.id, workspace.slug)
      .first<Assistant>(),
    env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?').bind(workspace.id).first<ProviderSettings>(),
    env.DB.prepare(PRESET_RECONCILIATION_SQL).bind(workspace.id).first<{ needed: number }>(),
    env.DB.prepare('SELECT id FROM knowledge_collections WHERE business_id=? AND is_default=1 LIMIT 1')
      .bind(workspace.id).first<{ id: string }>(),
  ]);
  if (!legacy) {
    if (assistant) {
      // New-domain rows are authoritative when only the compatibility adapter
      // was lost. Reconstructing defaults here would silently overwrite a
      // configured assistant and provider on the next reconciliation pass.
      await env.DB.batch([
        // Establish the restored row's baseline in the same transaction. A
        // reconstructed compatibility row is not a legacy edit or publication.
        env.DB.prepare(
          `INSERT INTO compatibility_sync_state (business_id, agent_snapshot)
           SELECT a.business_id, json_object(
             'agent_name',a.name,'greeting',a.greeting,'persona',a.persona,
             'language',a.language,'voice',a.voice,'take_messages',a.take_messages,
             'custom_instructions',a.custom_instructions,'engine',a.engine,
             'realtime_model',a.realtime_model,'realtime_voice',a.realtime_voice,
             'llm_model',a.llm_model)
           FROM assistants a WHERE a.id=?
             AND NOT EXISTS (SELECT 1 FROM agent_settings WHERE business_id=a.business_id)
           ON CONFLICT(business_id) DO UPDATE SET agent_snapshot=excluded.agent_snapshot`
        ).bind(assistant.id),
        env.DB.prepare(
        `INSERT OR IGNORE INTO agent_settings (
          business_id, agent_name, greeting, persona, language, voice,
          take_messages, custom_instructions, llm_base_url, llm_api_key,
          llm_model, engine, realtime_model, realtime_voice
         )
         SELECT assistants.business_id, assistants.name, assistants.greeting,
           assistants.persona, assistants.language, assistants.voice,
           assistants.take_messages, assistants.custom_instructions,
           COALESCE(provider_settings.llm_base_url, ''),
           COALESCE(provider_settings.llm_api_key, ''), assistants.llm_model,
           assistants.engine, assistants.realtime_model, assistants.realtime_voice
          FROM assistants
          LEFT JOIN provider_settings ON provider_settings.business_id=assistants.business_id
         WHERE assistants.id=?`
        ).bind(assistant.id),
      ]);
    } else {
      // With neither source present there is no configured legacy assistant to
      // publish. Blank essentials also keep concurrent repairs private.
      // A provider can survive loss of both assistant rows. Read its text
      // pair at insertion time; a missing provider still means instance defaults.
      await env.DB.prepare(
        `INSERT OR IGNORE INTO agent_settings
          (business_id,agent_name,persona,language,llm_base_url,llm_api_key)
         SELECT workspace.id,'','','',COALESCE(provider.llm_base_url,''),COALESCE(provider.llm_api_key,'')
         FROM businesses AS workspace
         LEFT JOIN provider_settings AS provider ON provider.business_id=workspace.id
         WHERE workspace.id=?`
      ).bind(workspace.id).run();
    }
    legacy = await env.DB.prepare('SELECT * FROM agent_settings WHERE business_id = ?')
      .bind(workspace.id)
      .first<AgentSettings>();
  }
  if (!legacy) throw new Error('Could not restore workspace settings');

  const [syncState, legacyLiveCall] = await Promise.all([
    env.DB.prepare(
        `SELECT compatibility_sync_state.services_json, compatibility_sync_state.faqs_json,
          compatibility_sync_state.collection_id,
          compatibility_sync_state.agent_snapshot,
          compatibility_sync_state.agent_snapshot <> ${AGENT_SNAPSHOT_SQL} AS agent_changed
         FROM compatibility_sync_state
         JOIN agent_settings ON agent_settings.business_id=compatibility_sync_state.business_id
        WHERE compatibility_sync_state.business_id = ?`
      )
        .bind(workspace.id)
        .first<{
          services_json: string;
          faqs_json: string;
          collection_id: string;
          agent_snapshot: string;
          agent_changed: number;
        }>(),
    env.DB.prepare(
      `SELECT 1 AS found FROM calls
        WHERE business_id=? AND environment='live' AND assistant_id IS NULL LIMIT 1`
    )
      .bind(workspace.id)
      .first<{ found: number }>(),
  ]);
  const legacyCallRepair = legacyLiveCall ? env.DB.prepare(
      `UPDATE calls SET assistant_id=(
         SELECT assistants.id FROM assistants
          WHERE assistants.business_id=calls.business_id
            AND assistants.public_slug=? LIMIT 1
       )
       WHERE business_id=? AND environment='live' AND assistant_id IS NULL
         AND EXISTS (
           SELECT 1 FROM assistants
            WHERE assistants.business_id=calls.business_id
              AND assistants.public_slug=?
         )`
    )
      .bind(workspace.slug, workspace.id, workspace.slug)
      : null;
  const statements: D1PreparedStatement[] = [];
  const assistantValues = [
    legacy.agent_name,
    legacy.greeting,
    legacy.persona,
    legacy.language,
    legacy.voice,
    legacy.take_messages,
    legacy.custom_instructions,
    legacy.engine,
    legacy.realtime_model,
    legacy.realtime_voice,
    legacy.llm_model,
  ];
  const legacyEssentialsReady = Boolean(
    legacy.agent_name.trim() && legacy.persona.trim() && legacy.language.trim()
  );
  let agentSnapshotNeedsUpdate = Boolean(syncState?.agent_changed);
  if (!assistant) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO assistants (
          id, business_id, public_slug, state, name, greeting, persona, language,
          voice, take_messages, custom_instructions, engine, realtime_model,
          realtime_voice, llm_model, activated_at
         )
         SELECT ?, ?, ?,
           CASE WHEN
             trim(agent_name, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>''
             AND trim(persona, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>''
             AND trim(language, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>''
           THEN 'active' ELSE 'draft' END,
           agent_name, greeting, persona, language,
           voice, take_messages, custom_instructions, engine, realtime_model,
           realtime_voice, llm_model,
           CASE WHEN
             trim(agent_name, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>''
             AND trim(persona, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>''
             AND trim(language, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>''
           THEN datetime('now') ELSE NULL END
           FROM agent_settings WHERE business_id=?`
      ).bind(`asst_${workspace.id}`, workspace.id, workspace.slug, workspace.id)
    );
  } else {
    const valuesDiffer = [
      assistant.name,
      assistant.greeting,
      assistant.persona,
      assistant.language,
      assistant.voice,
      assistant.take_messages,
      assistant.custom_instructions,
      assistant.engine,
      assistant.realtime_model,
      assistant.realtime_voice,
      assistant.llm_model,
    ].some((value, index) => value !== assistantValues[index]);
    if (
      assistant.state === 'draft' &&
      legacyEssentialsReady &&
      (Boolean(syncState?.agent_changed) ||
        !syncState)
    ) {
      statements.push(
        env.DB.prepare(
          `UPDATE assistants SET
            (name, greeting, persona, language, voice, take_messages, custom_instructions,
             engine, realtime_model, realtime_voice, llm_model) =
            (SELECT agent_name, greeting, persona, language, voice, take_messages, custom_instructions,
               engine, realtime_model, realtime_voice, llm_model
               FROM agent_settings WHERE business_id=?),
            state='active', activated_at=COALESCE(activated_at, datetime('now')),
            updated_at=datetime('now')
           WHERE id=?`
        ).bind(workspace.id, assistant.id)
      );
    } else if (assistant.state !== 'draft' && valuesDiffer) {
      if (legacyEssentialsReady) {
        statements.push(
          env.DB.prepare(
            `UPDATE assistants SET
              (name, greeting, persona, language, voice, take_messages, custom_instructions,
               engine, realtime_model, realtime_voice, llm_model) =
              (SELECT agent_name, greeting, persona, language, voice, take_messages, custom_instructions,
                 engine, realtime_model, realtime_voice, llm_model
                 FROM agent_settings WHERE business_id=?),
              updated_at=datetime('now')
             WHERE id=?`
          ).bind(workspace.id, assistant.id)
        );
      } else {
        // Old workers allowed incomplete writes. Never let one turn a valid
        // active/paused assistant into a permanently failing reconciliation;
        // restore the compatibility behavior fields from the valid source.
        statements.push(
          env.DB.prepare(
            `UPDATE agent_settings SET
              (agent_name, greeting, persona, language, voice, take_messages,
               custom_instructions, engine, realtime_model, realtime_voice, llm_model) =
              (SELECT name, greeting, persona, language, voice, take_messages,
                 custom_instructions, engine, realtime_model, realtime_voice, llm_model
                 FROM assistants WHERE id=?)
             WHERE business_id=?`
          ).bind(assistant.id, workspace.id)
        );
        agentSnapshotNeedsUpdate = true;
      }
    }
    if (agentSnapshotNeedsUpdate) {
      statements.push(updateAgentSnapshot(env, workspace.id));
    }
  }
  if (
    !provider ||
    provider.llm_base_url !== legacy.llm_base_url ||
    provider.llm_api_key !== legacy.llm_api_key
  ) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO provider_settings (business_id, llm_base_url, llm_api_key)
         SELECT business_id, llm_base_url, llm_api_key FROM agent_settings WHERE business_id=?
         ON CONFLICT(business_id) DO UPDATE SET llm_base_url=excluded.llm_base_url,
           llm_api_key=excluded.llm_api_key, updated_at=datetime('now')`
      ).bind(workspace.id)
    );
  }
  if (!syncState || !assistant || !defaultCollection) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO knowledge_collections (id, business_id, name, description, is_default)
         SELECT ?, ?, 'Workspace knowledge', 'Services and answers shared by default with new assistants.', 1
         WHERE NOT EXISTS (SELECT 1 FROM knowledge_collections WHERE business_id = ? AND is_default = 1)
           AND NOT EXISTS (SELECT 1 FROM knowledge_collections WHERE business_id = ? AND name='Workspace knowledge')`
      ).bind(`kc_default_${workspace.id}`, workspace.id, workspace.id, workspace.id),
      env.DB.prepare(
        `UPDATE knowledge_collections SET is_default=1, updated_at=datetime('now')
         WHERE business_id=? AND name='Workspace knowledge'
           AND NOT EXISTS (SELECT 1 FROM knowledge_collections WHERE business_id=? AND is_default=1)`
      ).bind(workspace.id, workspace.id),
    );
  }
  if (presetReconciliation?.needed) {
    statements.push(
      env.DB.prepare(`DELETE FROM engine_presets WHERE business_id=?
        AND NOT EXISTS(SELECT 1 FROM engine_profiles l WHERE l.id=engine_presets.id AND l.business_id=engine_presets.business_id)`)
        .bind(workspace.id),
      ...['<=','>'].map(comparison => env.DB.prepare(`UPDATE engine_presets AS p SET (name, engine, realtime_model, realtime_voice, language, voice, llm_model)=
        (SELECT name, engine, realtime_model, realtime_voice, language, voice, llm_model FROM engine_profiles l WHERE l.id=p.id AND l.business_id=p.business_id), updated_at=datetime('now')
        WHERE p.business_id=? AND EXISTS(SELECT 1 FROM engine_profiles l
          WHERE l.id=p.id AND l.business_id=p.business_id AND NOT (${PRESET_CHANGED_SQL})
          AND (${PRESET_ROW_BYTES('l')}) ${comparison} (${PRESET_ROW_BYTES('p')}))`)
        .bind(workspace.id)),
      env.DB.prepare(`INSERT INTO engine_presets (id,business_id,name, engine, realtime_model, realtime_voice, language, voice, llm_model,created_at,updated_at)
        SELECT id,business_id,name, engine, realtime_model, realtime_voice, language, voice, llm_model,created_at,datetime('now') FROM engine_profiles l
        WHERE business_id=? AND NOT EXISTS(SELECT 1 FROM engine_presets p WHERE p.id=l.id)`)
        .bind(workspace.id),
    );
  }
  if (!defaultCollection) {
    // Do not publish an empty repaired collection before its knowledge is restored.
    // A deterministic ID alone cannot distinguish a completed repair on retry.
    const named = await env.DB.prepare(
      "SELECT id FROM knowledge_collections WHERE business_id=? AND name='Workspace knowledge' ORDER BY created_at,id LIMIT 1"
    ).bind(workspace.id).first<{ id: string }>();
    const collectionId = named?.id ?? `kc_default_${workspace.id}`;
    const attach = env.DB.prepare(
      `INSERT OR IGNORE INTO assistant_knowledge_collections (assistant_id,collection_id)
       SELECT assistants.id,? FROM assistants WHERE assistants.business_id=? AND assistants.public_slug=?`
    ).bind(collectionId,workspace.id,workspace.slug);
    await syncLegacyKnowledge(env, workspace, collectionId, { services: true, faqs: true }, [...statements,attach,...(legacyCallRepair ? [legacyCallRepair] : [])]);
    return;
  }
  if (statements.length > 0) await env.DB.batch(statements);
  const collection = await env.DB.prepare(
    'SELECT id FROM knowledge_collections WHERE business_id = ? AND is_default = 1 ORDER BY created_at, id LIMIT 1'
  )
    .bind(workspace.id)
    .first<{ id: string }>();
  if (!collection) throw new Error('Could not restore workspace knowledge');
  if (!syncState || !assistant || !defaultCollection || syncState.collection_id !== collection.id) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO assistant_knowledge_collections (assistant_id, collection_id)
       SELECT assistants.id, ? FROM assistants
        WHERE assistants.business_id=? AND assistants.public_slug=?`
    )
      .bind(collection.id, workspace.id, workspace.slug)
      .run();
  }
  const collectionChanged = !defaultCollection || !syncState || syncState.collection_id !== collection.id;
  const servicesChanged =
    !syncState || !sameLegacyKnowledgeProjection('service', syncState.services_json, workspace.services_json);
  const faqsChanged =
    !syncState || !sameLegacyKnowledgeProjection('faq', syncState.faqs_json, workspace.faqs_json);
  if (collectionChanged || servicesChanged || faqsChanged) {
    await syncLegacyKnowledge(env, workspace, collection.id, {
      services: collectionChanged || servicesChanged,
      faqs: collectionChanged || faqsChanged,
    });
  }
  // Keep the prior raw marker when only formatting, unsupported fields, or
  // malformed/nonprojected siblings changed. The projection comparison above
  // makes repeated checks safe, while advancing the marker would erase the
  // provenance needed to distinguish cleanup from a later real source edit.
  if (legacyLiveCall) {
    // Migration 0008 backfills every call it can see, but an old worker can
    // still insert live rows without assistant_id until the rollout finishes.
    // Attribute every such row to the singular compatibility assistant only
    // after its collection projection is ready, so a new CallSession cannot
    // observe a repaired id with half-repaired knowledge. Test rows deliberately
    // remain explicit: they are created by the authenticated assistant route
    // and must never be guessed from the workspace slug.
    await legacyCallRepair!.run();
  }
}

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
  const workspace = await env.DB.prepare('SELECT * FROM businesses WHERE user_id = ? ORDER BY created_at, id LIMIT 1')
    .bind(userId)
    .first<Workspace>();
  if (workspace) await ensureWorkspaceFoundation(env, workspace);
  return workspace;
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

async function isCompatibilityAssistant(env: Env, assistant: Assistant): Promise<boolean> {
  return Boolean(
    await env.DB.prepare('SELECT 1 AS found FROM businesses WHERE id = ? AND slug = ?')
      .bind(assistant.business_id, assistant.public_slug)
      .first()
  );
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
    llm_model: assistant.llm_model || provider?.llm_model || '',
    engine: assistant.engine,
    realtime_model: assistant.realtime_model,
    realtime_voice: assistant.realtime_voice,
  };
}

function encodeCursor(startedAt: string, id: string): string {
  return btoa(JSON.stringify([startedAt, id])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeCursor(raw: string | undefined): [string, string] | null {
  if (!raw || raw.length > 2048) return null;
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

async function knowledgePage(env: Env, collectionId: string, rawCursor?: string) {
  const decoded = rawCursor ? decodeCursor(rawCursor) : null;
  const position = decoded?.[0].split('|');
  if (rawCursor && (!decoded || position?.length !== 2 || !['active','draft'].includes(position[0]) || !position[1] || !decoded[1])) return null;
  const query = env.DB.prepare(`SELECT * FROM knowledge_items WHERE collection_id=?
    ${decoded ? 'AND (status,created_at,id) > (?,?,?)' : ''}
    ORDER BY status,created_at,id LIMIT 21`);
  const { results } = await (decoded ? query.bind(collectionId, position![0], position![1], decoded[1]) : query.bind(collectionId)).all<KnowledgeItem>();
  const items = results.slice(0,20); const last = items[items.length - 1];
  return { items, nextCursor: results.length > 20 && last ? encodeCursor(`${last.status}|${last.created_at}`, last.id) : null };
}

function likeTerm(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

interface NormalizedTimestamp {
  sqlite: string;
  epochMs: number;
}

// Call timestamps are stored by SQLite as UTC text (`YYYY-MM-DD HH:mm:ss`).
// Comparing that text directly with an RFC 3339 query value containing `T`,
// `Z`, milliseconds, or an offset gives chronological nonsense. Accept one
// unambiguous Internet timestamp shape and convert it to the same sortable UTC
// representation before binding it. Milliseconds are retained when non-zero so
// an exact sub-second boundary is not widened to the whole second.
function normalizedCallTimestamp(raw: string): NormalizedTimestamp | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/i.exec(raw);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  if (zone.toUpperCase() !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const epochMs = Date.parse(raw);
  if (!Number.isFinite(epochMs)) return null;
  const iso = new Date(epochMs).toISOString();
  // Applying an offset to a four-digit input can cross into ISO year 0000 or
  // the extended-year form (`+010000-...`). Neither has the fixed-width shape
  // used by D1's `YYYY-MM-DD HH:mm:ss` call timestamps, so reject it instead of
  // slicing a malformed SQL bound.
  if (iso.startsWith('0000-') || !/^\d{4}-/.test(iso)) return null;
  const seconds = iso.slice(0, 19).replace('T', ' ');
  const milliseconds = iso.slice(19, 23);
  return { sqlite: milliseconds === '.000' ? seconds : `${seconds}${milliseconds}`, epochMs };
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
    const [{ results: assistants }, provider, test, assistantStatus] = await Promise.all([
      c.env.DB.prepare("SELECT id,business_id,public_slug,state,substr(name,1,256) AS name,substr(persona,1,2048) AS persona,substr(language,1,64) AS language, (trim(name,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>'' AND trim(persona,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>'' AND trim(language,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>'') AS essentials_ready FROM assistants WHERE business_id = ? ORDER BY public_slug=? DESC,created_at,id LIMIT 32").bind(workspace.id,workspace.slug).all<Pick<Assistant, 'id'|'business_id'|'public_slug'|'state'|'name'|'persona'|'language'>>(),
      c.env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?').bind(workspace.id).first<ProviderSettings>(),
      c.env.DB.prepare(
        "SELECT 1 AS found FROM calls WHERE business_id = ? AND environment = 'test' AND connected_at IS NOT NULL LIMIT 1"
      )
        .bind(workspace.id)
        .first<{ found: number }>(),
      c.env.DB.prepare("SELECT COUNT(CASE WHEN state='active' THEN 1 END) AS live, COUNT(CASE WHEN trim(name,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>'' AND trim(persona,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>'' AND trim(language,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>'' THEN 1 END) AS ready FROM assistants WHERE business_id=?").bind(workspace.id).first<{live:number;ready:number}>(),
    ]);
    return c.json({
      account,
      workspace,
      assistants,
      setup: {
        account: true,
        workspace: Boolean(workspace.name.trim() && workspace.description.trim()),
        firstAssistant: Boolean(assistantStatus?.ready),
        firstTest: Boolean(test),
      },
      readiness: {
        providerConfigured: providerConfigured(c.env, provider),
        liveAssistantCount: assistantStatus?.live || 0,
      },
    });
  });

  app.get('/api/me/assistants', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json([]);
    const offset = Number(c.req.query('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) return c.json({ error: 'Invalid assistant offset' }, 400);
    const { results } = await c.env.DB.prepare(
      `SELECT id,business_id,public_slug,state,substr(name,1,256) AS name,substr(persona,1,2048) AS persona,
        substr(language,1,64) AS language,engine,created_at,updated_at,
        (SELECT MAX(started_at) FROM calls WHERE calls.assistant_id = assistants.id AND environment = 'live') AS last_live_call_at,
        (SELECT MAX(started_at) FROM calls WHERE calls.assistant_id = assistants.id AND environment = 'test') AS last_test_at
       FROM assistants WHERE business_id = ? ORDER BY created_at, id LIMIT 32 OFFSET ?`
    )
      .bind(workspace.id, offset)
      .all();
    return c.json(results);
  });

  app.post('/api/me/assistants', async (c) => {
    // Reject incompatible drafts before compatibility bootstrap can write.
    const workspace = await c.env.DB.prepare('SELECT id FROM businesses WHERE user_id=? ORDER BY created_at,id LIMIT 1')
      .bind(c.get('userId')).first<{ id: string }>();
    if (!workspace) return c.json({ error: 'Create a workspace first' }, 409);
    const body = await readWorkspaceBody<Partial<Omit<Assistant, 'take_messages'>> & { take_messages?: number | boolean }>(c.req);
    if (
      (body.name !== undefined && !body.name.trim()) ||
      (body.persona !== undefined && !body.persona.trim()) ||
      (body.language !== undefined && !body.language.trim())
    ) {
      return c.json({ error: 'Assistant name, personality, and language cannot be blank' }, 400);
    }
    if (!body.name?.trim()) return c.json({ error: 'Assistant name required' }, 400);
    const realtimeProvider = await c.env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?')
      .bind(workspace.id).first<ProviderSettings>();
    const incompatibility = assistantCompatibilityError(c.env, realtimeProvider, body);
    if (incompatibility) return c.json({ error: incompatibility }, 400);
    await workspaceForUser(c.env, c.get('userId'));
    // Foundation may repair a missing provider row. Validate and pin that
    // resulting snapshot; earlier legitimate repairs are outside this batch.
    const createProvider = await c.env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?')
      .bind(workspace.id).first<ProviderSettings>();
    if (assistantCompatibilityError(c.env, createProvider, body)) {
      return c.json({ error: 'Provider configuration changed. Reload and retry.' }, 409);
    }
    // The shared UPDATE predicate needs an explicit source workspace for INSERT.
    const createProviderSql = CHECKED_REALTIME_PROVIDER_SQL.replaceAll('assistants.business_id', 'create_workspace.id');
    const id = newId();
    const createAssistant = c.env.DB.prepare(
      `INSERT INTO assistants (
        id, business_id, public_slug, state, name, greeting, persona, language,
        voice, take_messages, custom_instructions, engine, realtime_model,
        realtime_voice, llm_model
      ) SELECT ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM businesses AS create_workspace
        WHERE create_workspace.id=? AND ${createProviderSql}`
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
        body.take_messages === 0 || body.take_messages === false ? 0 : 1,
        body.custom_instructions ?? '',
        body.engine === 'realtime' ? 'realtime' : 'pipeline',
        body.realtime_model ?? '',
        body.realtime_voice ?? '',
        body.llm_model ?? '',
        workspace.id,
        ...checkedRealtimeProvider(createProvider)
      );
    const attachDefault = c.env.DB.prepare(
      `INSERT OR IGNORE INTO assistant_knowledge_collections (assistant_id, collection_id)
       SELECT ?, id FROM knowledge_collections WHERE business_id = ? AND is_default = 1 AND changes()>0`
    )
      .bind(id, workspace.id);
    const responseRow = c.env.DB.prepare('SELECT * FROM assistants WHERE id = ?').bind(id);
    const [created, , response] = await c.env.DB.batch<Assistant>([createAssistant, attachDefault, responseRow]);
    if (!created.meta.changes) return c.json({ error: 'Provider configuration changed. Reload and retry.' }, 409);
    return c.json(response.results[0], 201);
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
    const body = await readWorkspaceBody<Partial<Omit<Assistant, 'take_messages'>> & { take_messages?: number | boolean }>(c.req);
    if (
      (body.name !== undefined && !body.name.trim()) ||
      (body.persona !== undefined && !body.persona.trim()) ||
      (body.language !== undefined && !body.language.trim())
    ) {
      return c.json({ error: 'Assistant name, personality, and language cannot be blank' }, 400);
    }
    const name = body.name?.trim() || assistant.name;
    const engine = body.engine === 'realtime' ? 'realtime' : body.engine === 'pipeline' ? 'pipeline' : assistant.engine;
    const greeting = body.greeting ?? assistant.greeting;
    const persona = body.persona ?? assistant.persona;
    const language = body.language ?? assistant.language;
    const voice = body.voice ?? assistant.voice;
    const takeMessages = body.take_messages !== undefined ? (body.take_messages ? 1 : 0) : assistant.take_messages;
    const instructions = body.custom_instructions ?? assistant.custom_instructions;
    const realtimeModel = body.realtime_model ?? assistant.realtime_model;
    const realtimeVoice = body.realtime_voice ?? assistant.realtime_voice;
    const realtimeProvider = await c.env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?')
      .bind(assistant.business_id).first<ProviderSettings>();
    const incompatibility = assistantCompatibilityError(c.env, realtimeProvider,
      { engine, realtime_model: realtimeModel, realtime_voice: realtimeVoice });
    if (incompatibility) return c.json({ error: incompatibility }, 400);
    const llmModel = body.llm_model ?? assistant.llm_model;
    if (assistant.state === 'active' && (!name.trim() || !persona.trim() || !language.trim())) {
      return c.json({ error: 'Active assistants require a name, personality, and language' }, 400);
    }
    const statements = [
      c.env.DB.prepare(
      `UPDATE assistants SET name=?, greeting=?, persona=?, language=?, voice=?, take_messages=?,
        custom_instructions=?, engine=?, realtime_model=?, realtime_voice=?, llm_model=?, updated_at=datetime('now')
       WHERE id=? AND ${CHECKED_REALTIME_PROVIDER_SQL}
        AND ${CHECKED_ASSISTANT_SNAPSHOT_SQL}`
      ).bind(
        name,
        greeting,
        persona,
        language,
        voice,
        takeMessages,
        instructions,
        engine,
        realtimeModel,
        realtimeVoice,
        llmModel,
        assistant.id,
        ...checkedRealtimeProvider(realtimeProvider),
        ...checkedAssistantSnapshot(assistant)
      ),
    ];
    if (await isCompatibilityAssistant(c.env, assistant)) {
      statements.push(
        c.env.DB.prepare(
        `UPDATE agent_settings SET agent_name=?, greeting=?, persona=?, language=?, voice=?, take_messages=?,
          custom_instructions=?, llm_model=?, engine=?, realtime_model=?, realtime_voice=? WHERE business_id=? AND changes()>0`
        ).bind(
          name,
          greeting,
          persona,
          language,
          voice,
          takeMessages,
          instructions,
          llmModel,
          engine,
          realtimeModel,
          realtimeVoice,
          assistant.business_id
        )
      );
      statements.push(updateAgentSnapshot(c.env, assistant.business_id, true));
    }
    const [updated] = await c.env.DB.batch(statements);
    if (!updated.meta.changes) {
      return c.json({ error: 'Assistant or provider configuration changed. Reload and retry.' }, 409);
    }
    const row = await c.env.DB.prepare('SELECT * FROM assistants WHERE id = ?').bind(assistant.id).first<Assistant>();
    return c.json(row);
  });

  app.delete('/api/me/assistants/:assistantId', async (c) => {
    const assistant = await ownedAssistant(c.env, c.get('userId'), c.req.param('assistantId'));
    if (!assistant) return c.json({ error: 'Not found' }, 404);
    if (await isCompatibilityAssistant(c.env, assistant)) return c.json({ error: 'The workspace primary assistant cannot be deleted. Edit its configuration instead.' }, 409);
    const deleted = await c.env.DB.prepare(`DELETE FROM assistants WHERE id=? AND state<>'active'
      AND NOT EXISTS(SELECT 1 FROM calls WHERE assistant_id=assistants.id AND (status='active' OR (channel IN ('telnyx','asterisk') AND reserved_at IS NOT NULL AND carrier_released_at IS NULL)))
      AND NOT EXISTS(SELECT 1 FROM asterisk_routes WHERE assistant_id=assistants.id)
      AND NOT EXISTS(SELECT 1 FROM telnyx_number_routes WHERE assistant_id=assistants.id)
      RETURNING id`).bind(assistant.id).first();
    if (!deleted) return c.json({ error: 'Pause this assistant, finish its calls, and remove any carrier routes before deleting it.' }, 409);
    return c.json({ ok: true });
  });

  app.post('/api/me/assistants/:assistantId/activate', async (c) => {
    const assistant = await ownedAssistant(c.env, c.get('userId'), c.req.param('assistantId'));
    if (!assistant) return c.json({ error: 'Not found' }, 404);
    if (!assistant.name.trim() || !assistant.language.trim() || !assistant.persona.trim()) {
      return c.json({ error: 'Complete the assistant essentials before activation' }, 400);
    }
    const provider = await c.env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?')
      .bind(assistant.business_id).first<ProviderSettings>();
    const incompatibility = assistantCompatibilityError(c.env, provider, assistant);
    if (incompatibility) return c.json({ error: incompatibility }, 400);
    // Pin the checked configuration in the write itself. A concurrent provider
    // switch preserves draft fields; it must not race this activation check.
    const activated = await c.env.DB.prepare(
      `UPDATE assistants SET state='active', activated_at=COALESCE(activated_at, datetime('now')),
        updated_at=datetime('now')
       WHERE id=? AND state IS ?
         AND engine IS ? AND realtime_model IS ? AND realtime_voice IS ?
         AND EXISTS(SELECT 1 FROM provider_settings WHERE business_id=assistants.business_id)=?
         AND (SELECT realtime_provider FROM provider_settings WHERE business_id=assistants.business_id) IS ?
         AND trim(name, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>''
         AND trim(persona, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>''
         AND trim(language, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>'' RETURNING id`
    )
      .bind(assistant.id, assistant.state, assistant.engine, assistant.realtime_model, assistant.realtime_voice,
        provider ? 1 : 0, provider?.realtime_provider ?? null)
      .first<{ id: string }>();
    if (!activated) {
      return c.json({ error: 'Assistant or provider configuration changed. Reload, check the assistant essentials and provider settings, then retry activation.' }, 409);
    }
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
    const rateLimitNow = Date.now();
    const minuteRetryAfter = String(fixedWindowRetryAfter(60, rateLimitNow));
    // This read makes a known-full rolling day a zero-write refusal. The
    // conditional INSERT below remains the authority for concurrent requests.
    const dayState = await testCallDayState(c.env, assistant.business_id, rateLimitNow);
    if (dayState.count >= TEST_CALLS_PER_DAY) {
      return c.json({ error: 'Daily test-call limit reached. Try again tomorrow.' }, 429, {
        'Retry-After': String(rollingDayRetryAfter(dayState.oldest_started_at ?? undefined, rateLimitNow)),
      });
    }
    const knownIpLimit = await studioIpLimitAtCapacity(c.env, c.req.header('CF-Connecting-IP'), rateLimitNow);
    if (knownIpLimit === 'minute') {
      return c.json({ error: 'Too many studio actions from this connection. Please wait a minute.' }, 429, {
        'Retry-After': minuteRetryAfter,
      });
    }
    if (knownIpLimit === 'day') {
      return c.json({ error: 'Daily studio action limit reached. Try again tomorrow.' }, 429, {
        'Retry-After': String(fixedWindowRetryAfter(DAY_SECONDS, rateLimitNow)),
      });
    }
    const workspaceReservation = await reserveStudioSpend(
      c.env,
      assistant.business_id,
      'minute',
      60,
      STUDIO_SPEND_PER_MINUTE,
      rateLimitNow
    );
    if (!workspaceReservation) {
      return c.json({ error: 'Too many test actions. Please wait a minute.' }, 429, {
        'Retry-After': minuteRetryAfter,
      });
    }
    const ipLimit = await reserveStudioIpSpend(c.env, c.req.header('CF-Connecting-IP'), rateLimitNow);
    const reservations = [workspaceReservation, ...ipLimit.reservations];
    if (ipLimit.blocked === 'minute') {
      await refundStudioSpend(c.env, reservations);
      return c.json({ error: 'Too many studio actions from this connection. Please wait a minute.' }, 429, {
        'Retry-After': minuteRetryAfter,
      });
    }
    if (ipLimit.blocked === 'day') {
      await refundStudioSpend(c.env, reservations);
      return c.json({ error: 'Daily studio action limit reached. Try again tomorrow.' }, 429, {
        'Retry-After': String(fixedWindowRetryAfter(DAY_SECONDS, rateLimitNow)),
      });
    }
    // A cached assistant ID can bypass every listing/bootstrap reconciliation.
    // Refresh mixed-version legacy settings and workspace credentials before
    // issuing the ticket, but only after the spend gates admit this request.
    let workspace: Workspace | null;
    try {
      workspace = await workspaceForUser(c.env, c.get('userId'));
    } catch (error) {
      await refundStudioSpend(c.env, reservations);
      throw error;
    }
    if (!workspace) {
      await refundStudioSpend(c.env, reservations);
      return c.json({ error: 'Not found' }, 404);
    }
    const callId = newId();
    let inserted: D1Result;
    try {
      inserted = await c.env.DB.prepare(
        `INSERT INTO calls (id, business_id, assistant_id, channel, caller_id, environment, direction, started_at, browser_claim_required)
         SELECT ?, ?, ?, 'web', ?, 'test', 'inbound', datetime(?, 'unixepoch'), 1
          WHERE (SELECT COUNT(*) FROM calls
                  WHERE business_id=? AND environment='test'
                    AND started_at > datetime(?, 'unixepoch', '-1 day')) < ?`
      )
        .bind(
          callId,
          assistant.business_id,
          assistant.id,
          `owner:${c.get('userId')}`,
          rateLimitNow / 1000,
          assistant.business_id,
          rateLimitNow / 1000,
          TEST_CALLS_PER_DAY
        )
        .run();
    } catch (error) {
      await refundStudioSpend(c.env, reservations);
      throw error;
    }
    if ((inserted.meta.changes ?? 0) !== 1) {
      await refundStudioSpend(c.env, reservations);
      const currentDay = await testCallDayState(c.env, assistant.business_id, rateLimitNow);
      return c.json({ error: 'Daily test-call limit reached. Try again tomorrow.' }, 429, {
        'Retry-After': String(rollingDayRetryAfter(currentDay.oldest_started_at ?? undefined, rateLimitNow)),
      });
    }
    return c.json({ callId, assistantId: assistant.id, environment: 'test' }, 201);
  });

  // Cancellation only retires an unused, owner-authenticated test ticket. The
  // DELETE races atomically with the socket's connected_at claim: whichever
  // wins makes the other a no-op, without terminating an established call.
  app.delete('/api/me/test-calls/:callId', async (c) => {
    await c.env.DB.prepare(
      `DELETE FROM calls WHERE id=? AND environment='test' AND channel='web'
         AND status='active' AND connected_at IS NULL
         AND business_id IN (SELECT id FROM businesses WHERE user_id=?)`
    ).bind(c.req.param('callId'), c.get('userId')).run();
    // Idempotent and opaque for unknown, foreign, live, or already-used tickets.
    return c.json({ ok: true });
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
    const from = q.from === undefined ? null : normalizedCallTimestamp(q.from);
    const to = q.to === undefined ? null : normalizedCallTimestamp(q.to);
    if (q.from !== undefined && !from) return c.json({ error: 'Invalid from timestamp; use RFC 3339 with a timezone' }, 400);
    if (q.to !== undefined && !to) return c.json({ error: 'Invalid to timestamp; use RFC 3339 with a timezone' }, 400);
    if (from && to && from.epochMs > to.epochMs) {
      return c.json({ error: 'The from timestamp must be before or equal to the to timestamp' }, 400);
    }
    // Preserve the route's half-open range contract: from is inclusive and to
    // is exclusive. Adjacent windows can therefore share an endpoint without
    // returning the boundary call twice. Equal endpoints are a valid empty
    // range; only a genuinely reversed range is rejected above.
    if (from) (conditions.push('calls.started_at >= ?'), args.push(from.sqlite));
    if (to) (conditions.push('calls.started_at < ?'), args.push(to.sqlite));
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
    if (!workspace) {
      return c.json({
        days,
        metrics: {
          total: 0,
          completed: 0,
          failed: 0,
          messages: 0,
          booking_requests: 0,
          talk_time_s: 0,
          average_duration_s: 0,
        },
        recentCalls: [],
      });
    }
    const since = `-${days} days`;
    const [metrics, recent] = await Promise.all([
      c.env.DB.prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(CASE
            WHEN message_json IS NOT NULL AND json_valid(message_json) THEN
              CASE WHEN json_type(message_json, '$.message') = 'text'
                AND trim(CAST(json_extract(message_json, '$.message') AS TEXT)) <> ''
                THEN 1 ELSE 0 END
            ELSE 0
          END), 0) AS messages,
          COALESCE(SUM(CASE WHEN intent = 'booking' THEN 1 ELSE 0 END), 0) AS booking_requests,
          COALESCE(SUM(duration_s), 0) AS talk_time_s,
          COALESCE(AVG(CASE WHEN status = 'completed' THEN duration_s END), 0) AS average_duration_s
         FROM calls WHERE business_id = ? AND environment = 'live' AND connected_at IS NOT NULL
           AND started_at >= datetime('now', ?)`
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
    const body = await readWorkspaceBody<{ name?: string; description?: string }>(c.req);
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
    const page = await knowledgePage(c.env, collection.id, c.req.query('cursor'));
    if (!page) return c.json({ error: 'Invalid knowledge cursor' }, 400);
    const { results: assistants } = await c.env.DB.prepare(
      `SELECT assistants.id, assistants.name, assistants.state FROM assistants
        JOIN assistant_knowledge_collections ON assistant_knowledge_collections.assistant_id = assistants.id
       WHERE assistant_knowledge_collections.collection_id = ? ORDER BY assistants.name`
    )
      .bind(collection.id)
      .all();
    return c.json({ ...collection, ...page, assistants });
  });

  app.put('/api/me/knowledge/collections/:collectionId', async (c) => {
    const collection = await ownedCollection(c.env, c.get('userId'), c.req.param('collectionId'));
    if (!collection) return c.json({ error: 'Not found' }, 404);
    const body = await readWorkspaceBody<{ name?: string; description?: string }>(c.req);
    const name = body.name?.trim() || collection.name;
    const duplicate = await c.env.DB.prepare(
      'SELECT id FROM knowledge_collections WHERE business_id = ? AND name = ? AND id != ?'
    )
      .bind(collection.business_id, name, collection.id)
      .first();
    if (duplicate) return c.json({ error: 'A collection with this name already exists' }, 409);
    const updated = await c.env.DB.prepare(
      "UPDATE knowledge_collections SET name=?, description=?, updated_at=datetime('now') WHERE id=? AND business_id=? AND name IS ? AND description IS ?"
    )
      .bind(name, body.description ?? collection.description, collection.id, collection.business_id, collection.name, collection.description)
      .run();
    if (!updated.meta.changes) return c.json({ error: 'Collection changed. Reload and retry.' }, 409);
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
    const page = await knowledgePage(c.env, collection.id, c.req.query('cursor'));
    if (!page) return c.json({ error: 'Invalid knowledge cursor' }, 400);
    if (page.nextCursor) c.header('X-Next-Cursor', page.nextCursor);
    return c.json(page.items);
  });

  app.post('/api/me/knowledge/collections/:collectionId/items', async (c) => {
    const collection = await ownedCollection(c.env, c.get('userId'), c.req.param('collectionId'));
    if (!collection) return c.json({ error: 'Not found' }, 404);
    const body = await readWorkspaceBody<Partial<KnowledgeItem>>(c.req);
    const kind = normalizedKind(body.kind);
    if (!kind) return c.json({ error: 'Knowledge kind must be faq, service, or note' }, 400);
    if (body.status !== undefined && !normalizedStatus(body.status)) return c.json({ error: 'Knowledge status must be draft or active' }, 400);
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
    const body = await readWorkspaceBody<Partial<KnowledgeItem>>(c.req);
    let collectionId = body.collection_id ?? item.collection_id;
    if (collectionId !== item.collection_id) {
      const collection = await ownedCollection(c.env, c.get('userId'), collectionId);
      if (!collection || collection.business_id !== item.business_id) return c.json({ error: 'Collection not found' }, 404);
      collectionId = collection.id;
    }
    if (body.kind !== undefined && !normalizedKind(body.kind)) return c.json({ error: 'Knowledge kind must be faq, service, or note' }, 400);
    if (body.status !== undefined && !normalizedStatus(body.status)) return c.json({ error: 'Knowledge status must be draft or active' }, 400);
    const candidate = {
      kind: normalizedKind(body.kind) ?? item.kind,
      title: body.title?.trim() ?? item.title,
      question: body.question?.trim() ?? item.question,
      answer: body.answer?.trim() ?? item.answer,
      content: body.content?.trim() ?? item.content,
    };
    const status = normalizedStatus(body.status) ?? item.status;
    if (status === 'active' && !itemReady(candidate)) return c.json({ error: 'Complete the item before activation' }, 400);
    const updated = await c.env.DB.prepare(
      `UPDATE knowledge_items SET collection_id=?, kind=?, status=?, title=?, question=?, answer=?, content=?,
        updated_at=datetime('now'),
        activated_at=CASE WHEN ?='active' THEN COALESCE(activated_at, datetime('now')) ELSE NULL END
       WHERE id=? AND business_id=? AND collection_id IS ? AND kind IS ? AND status IS ?
         AND title IS ? AND question IS ? AND answer IS ? AND content IS ?`
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
        item.id, item.business_id, item.collection_id, item.kind, item.status,
        item.title, item.question, item.answer, item.content
      )
      .run();
    if (!updated.meta.changes) return c.json({ error: 'Knowledge item changed. Reload and retry.' }, 409);
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
    const body = await readWorkspaceBody<{ callId?: string; turnId?: number; collectionId?: string }>(c.req);
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
      workspaceApiKeyConfigured: Boolean(provider?.llm_api_key),
      model: provider?.llm_model ?? '',
      presets: TEXT_PRESETS,
      realtime_provider: provider?.realtime_provider ?? 'instance',
      realtime_base_url: provider?.realtime_base_url ?? '',
      // Key presence follows runtime selection; it is not a connection check.
      realtime_api_key_configured: Boolean((provider?.realtime_provider || 'instance') === 'instance'
        ? c.env.REALTIME_API_KEY || ((c.env.REALTIME_PROVIDER || 'kataleptic') === 'kataleptic' ? c.env.DEFAULT_LLM_API_KEY : '')
        : provider?.realtime_api_key),
      stt_provider: provider?.stt_provider ?? 'instance',
      stt_base_url: provider?.stt_base_url ?? '',
      stt_model: provider?.stt_model ?? '',
      stt_api_key_configured: Boolean((provider?.stt_provider || 'instance') === 'instance'
        ? c.env.DEFAULT_STT_API_KEY : provider?.stt_api_key),
      tts_provider: c.env.DEFAULT_TTS_PROVIDER,
      updatedAt: provider?.updated_at ?? null,
    });
  });

  app.put('/api/me/provider', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json({ error: 'Create a workspace first' }, 409);
    const current = await c.env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?')
      .bind(workspace.id)
      .first<ProviderSettings>();
    const body = await readWorkspaceBody<Record<string, unknown>>(c.req);
    let next: ProviderSettings;
    try { next = providerUpdate(c.env, current, body); }
    catch (e) { if (e instanceof ProviderInputError) return c.json({ error: e.message }, 400); throw e; }
    const baseUrl = next.llm_base_url;
    const apiKey = next.llm_api_key;
    // Partial updates were derived from this whole persisted snapshot. Compare
    // it at the write boundary, including a concurrently created/missing row.
    const fields = ['llm_base_url', 'llm_api_key', 'llm_model', 'realtime_provider',
      'realtime_base_url', 'realtime_api_key', 'stt_provider', 'stt_base_url',
      'stt_api_key', 'stt_model'] as const;
    const matches = fields.map(field => `${field} IS ?`).join(' AND ');
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO provider_settings (business_id, llm_base_url, llm_api_key, llm_model,
          realtime_provider, realtime_base_url, realtime_api_key, stt_provider, stt_base_url, stt_api_key, stt_model)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (?=0 AND NOT EXISTS(SELECT 1 FROM provider_settings WHERE business_id=?))
            OR (?=1 AND EXISTS(SELECT 1 FROM provider_settings WHERE business_id=? AND ${matches}))
         ON CONFLICT(business_id) DO UPDATE SET
           llm_base_url=excluded.llm_base_url, llm_api_key=excluded.llm_api_key, llm_model=excluded.llm_model,
           realtime_provider=excluded.realtime_provider, realtime_base_url=excluded.realtime_base_url,
           realtime_api_key=excluded.realtime_api_key, stt_provider=excluded.stt_provider,
           stt_base_url=excluded.stt_base_url, stt_api_key=excluded.stt_api_key, stt_model=excluded.stt_model,
           updated_at=datetime('now')`
      ).bind(workspace.id, baseUrl, apiKey, next.llm_model, next.realtime_provider, next.realtime_base_url,
        next.realtime_api_key, next.stt_provider, next.stt_base_url, next.stt_api_key, next.stt_model,
        current ? 1 : 0, workspace.id, current ? 1 : 0, workspace.id, ...fields.map(field => current?.[field] ?? null)),
      // Abort the entire transaction on a failed first write. Later cleanup
      // statements can legitimately affect zero rows, so a changes() chain
      // through those statements would incorrectly suppress subsequent work.
      c.env.DB.prepare(`SELECT CASE WHEN changes()>0 THEN 1
        ELSE json_extract('[0]', '$[OPENFON_PROVIDER_WRITE_CONFLICT]') END`),
      c.env.DB.prepare('UPDATE agent_settings SET llm_base_url=?, llm_api_key=? WHERE business_id=?').bind(baseUrl, apiKey, workspace.id),
    ];
    // Model and voice compatibility are independent. Keep inactive custom model IDs,
    // but clear any voice outside the direct OpenAI catalog, even with a blank
    // or custom model. Blank fields use the adapter defaults.
    const effectiveRealtimeProvider = (selection: string | undefined) =>
      !selection || selection === 'instance' ? c.env.REALTIME_PROVIDER || 'kataleptic' : selection;
    if (effectiveRealtimeProvider(next.realtime_provider) === 'openai' &&
        effectiveRealtimeProvider(current?.realtime_provider) !== 'openai') {
      // Inactive drafts and saved profiles keep custom model intent. Active
      // realtime routes must not retain a model the direct adapter rejects.
      // Match /^gpt-(realtime|4o.*realtime)/ exactly: SQL wildcards span
      // line terminators, but JavaScript dot does not. Only the prefix through
      // the first "realtime" matters; trailing line terminators remain valid.
      const uninterruptedPrefix = [10, 13, 0x2028, 0x2029].map(code =>
        `(instr(realtime_model,char(${code}))=0 OR instr(realtime_model,char(${code}))>instr(realtime_model,'realtime'))`).join(' AND ');
      const incompatibleModel = `realtime_model<>'' AND NOT (
        substr(realtime_model,1,12)='gpt-realtime' OR
        (substr(realtime_model,1,6)='gpt-4o' AND instr(realtime_model,'realtime')>0 AND ${uninterruptedPrefix}))`;
      statements.push(c.env.DB.prepare(
        `UPDATE assistants SET realtime_model='' WHERE business_id=?
         AND state='active' AND engine='realtime' AND ${incompatibleModel}`
      ).bind(workspace.id));
      statements.push(c.env.DB.prepare(
        `UPDATE agent_settings SET realtime_model='' WHERE business_id=?
         AND engine='realtime' AND ${incompatibleModel}
         AND EXISTS (SELECT 1 FROM assistants JOIN businesses ON businesses.id=assistants.business_id
           WHERE assistants.business_id=agent_settings.business_id AND assistants.public_slug=businesses.slug
             AND assistants.state='active' AND assistants.engine='realtime')`
      ).bind(workspace.id));
      const voicePlaceholders = OPENAI_REALTIME_VOICES.map(() => '?').join(', ');
      for (const table of ['assistants', 'agent_settings']) {
        statements.push(c.env.DB.prepare(
          `UPDATE ${table} SET realtime_model='' WHERE business_id=?
           AND (realtime_model LIKE 'kataleptic-%' OR realtime_model='gpt-realtime-2')`
        ).bind(workspace.id));
        statements.push(c.env.DB.prepare(
          `UPDATE ${table} SET realtime_voice='' WHERE business_id=?
           AND realtime_voice<>'' AND realtime_voice NOT IN (${voicePlaceholders})`
        ).bind(workspace.id, ...OPENAI_REALTIME_VOICES));
      }
      // This owner-side cleanup is not an edit from an old worker.
      statements.push(updateAgentSnapshot(c.env, workspace.id));
    }
    try {
      await c.env.DB.batch(statements);
    } catch (error) {
      // D1 can wrap the SQLite cause. Match only our fixed assertion marker;
      // quota failures and other database errors keep their existing handling.
      let cause: unknown = error;
      for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
        if (cause.message.includes('[OPENFON_PROVIDER_WRITE_CONFLICT]')) {
          return c.json({ error: 'Provider configuration changed. Reload and retry.' }, 409);
        }
        cause = cause.cause;
      }
      throw error;
    }
    return c.json({
      ok: true,
      apiKeyConfigured: providerConfigured(c.env, {
        ...(current ?? {}),
        llm_base_url: baseUrl,
        llm_api_key: apiKey,
      } as ProviderSettings),
      workspaceApiKeyConfigured: Boolean(apiKey),
    });
  });

  app.post('/api/me/provider/check', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json({ error: 'Create a workspace first' }, 409);
    const body: { assistantId?: string } = await readWorkspaceBody<{ assistantId?: string }>(c.req, true);
    let assistant: Assistant | null = null;
    if (body.assistantId) assistant = await ownedAssistant(c.env, c.get('userId'), body.assistantId);
    else {
      assistant = await c.env.DB.prepare(
        'SELECT * FROM assistants WHERE business_id = ? AND public_slug = ? LIMIT 1'
      )
        .bind(workspace.id, workspace.slug)
        .first<Assistant>();
    }
    if (!assistant) return c.json({ error: 'Create an assistant first' }, 409);
    const provider = await c.env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?')
      .bind(workspace.id)
      .first<ProviderSettings>();
    let cfg: ReturnType<typeof resolveLlm>;
    try {
      // Invalid or incomplete configuration is not provider spend and must not
      // let one account drain a shared office/NAT allowance without making an
      // upstream request.
      cfg = resolveLlm(c.env, settingsForProvider(assistant, provider));
    } catch (error) {
      if (error instanceof LlmConfigError) return c.json({ error: error.message }, 400);
      return c.json({ error: 'Provider configuration is invalid.' }, 400);
    }
    const rateLimitNow = Date.now();
    const minuteRetryAfter = String(fixedWindowRetryAfter(60, rateLimitNow));
    if (
      await studioSpendAtLimit(
        c.env,
        workspace.id,
        'provider-day',
        DAY_SECONDS,
        PROVIDER_CHECKS_PER_DAY,
        rateLimitNow
      )
    ) {
      return c.json({ error: 'Daily provider-check limit reached. Try again tomorrow.' }, 429, {
        'Retry-After': String(fixedWindowRetryAfter(DAY_SECONDS, rateLimitNow)),
      });
    }
    const knownIpLimit = await studioIpLimitAtCapacity(c.env, c.req.header('CF-Connecting-IP'), rateLimitNow);
    if (knownIpLimit === 'minute') {
      return c.json({ error: 'Too many studio actions from this connection. Please wait a minute.' }, 429, {
        'Retry-After': minuteRetryAfter,
      });
    }
    if (knownIpLimit === 'day') {
      return c.json({ error: 'Daily studio action limit reached. Try again tomorrow.' }, 429, {
        'Retry-After': String(fixedWindowRetryAfter(DAY_SECONDS, rateLimitNow)),
      });
    }
    const workspaceReservation = await reserveStudioSpend(
      c.env,
      workspace.id,
      'minute',
      60,
      STUDIO_SPEND_PER_MINUTE,
      rateLimitNow
    );
    if (!workspaceReservation) {
      return c.json({ error: 'Too many provider checks. Please wait a minute.' }, 429, {
        'Retry-After': minuteRetryAfter,
      });
    }
    const ipLimit = await reserveStudioIpSpend(c.env, c.req.header('CF-Connecting-IP'), rateLimitNow);
    const reservations = [workspaceReservation, ...ipLimit.reservations];
    if (ipLimit.blocked === 'minute') {
      await refundStudioSpend(c.env, reservations);
      return c.json({ error: 'Too many studio actions from this connection. Please wait a minute.' }, 429, {
        'Retry-After': minuteRetryAfter,
      });
    }
    if (ipLimit.blocked === 'day') {
      await refundStudioSpend(c.env, reservations);
      return c.json({ error: 'Daily studio action limit reached. Try again tomorrow.' }, 429, {
        'Retry-After': String(fixedWindowRetryAfter(DAY_SECONDS, rateLimitNow)),
      });
    }
    const providerReservation = await reserveStudioSpend(
      c.env,
      workspace.id,
      'provider-day',
      DAY_SECONDS,
      PROVIDER_CHECKS_PER_DAY,
      rateLimitNow
    );
    if (!providerReservation) {
      await refundStudioSpend(c.env, reservations);
      return c.json({ error: 'Daily provider-check limit reached. Try again tomorrow.' }, 429, {
        'Retry-After': String(fixedWindowRetryAfter(DAY_SECONDS, rateLimitNow)),
      });
    }
    try {
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
      if (error instanceof LlmRequestError) return c.json({ error: error.message }, 502);
      return c.json({ error: 'Provider check failed. Verify the endpoint, API key, and model.' }, 502);
    }
  });

  app.get('/api/me/engine-presets', async (c) => {
    const workspace = await workspaceForUser(c.env, c.get('userId'));
    if (!workspace) return c.json([]);
    const { results } = await c.env.DB.prepare(
      `SELECT ${PRESET_LIST_COLUMNS},updated_at FROM engine_presets WHERE business_id = ? ORDER BY created_at, id LIMIT 64`
    )
      .bind(workspace.id)
      .all();
    return c.json(results);
  });

  app.post('/api/me/engine-presets', async (c) => {
    // Creation needs only ownership; reconciliation must not write before a quota refusal.
    const workspace = await c.env.DB.prepare('SELECT id FROM businesses WHERE user_id=? ORDER BY created_at,id LIMIT 1')
      .bind(c.get('userId')).first<{ id: string }>();
    if (!workspace) return c.json({ error: 'Create a workspace first' }, 409);
    const body = await readWorkspaceBody<Record<string, unknown>>(c.req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ error: 'Preset name required' }, 400);
    const id = newId();
    const engine = body.engine === 'realtime' ? 'realtime' : 'pipeline';
    const realtimeModel = typeof body.realtime_model === 'string' ? body.realtime_model : '';
    const realtimeVoice = typeof body.realtime_voice === 'string' ? body.realtime_voice : '';
    const language = typeof body.language === 'string' ? body.language.trim() || 'en' : 'en';
    const voice = typeof body.voice === 'string' ? body.voice : '';
    const llmModel = typeof body.llm_model === 'string' ? body.llm_model : '';
    await assertPresetWriteBudget(c.env, workspace.id, { id, name, engine,
      realtime_model:realtimeModel, realtime_voice:realtimeVoice, language, voice, llm_model:llmModel }, true);
    await c.env.DB.batch([
      c.env.DB.prepare(
      `INSERT INTO engine_presets (
        id, business_id, name, engine, realtime_model, realtime_voice, language, voice, llm_model
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, workspace.id, name, engine, realtimeModel, realtimeVoice, language, voice, llmModel),
      c.env.DB.prepare(
        `INSERT INTO engine_profiles (
          id, business_id, name, engine, realtime_model, realtime_voice, language,
          voice, llm_base_url, llm_api_key, llm_model
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        workspace.id,
        name,
        engine,
        realtimeModel,
        realtimeVoice,
        language,
        voice,
        '', // Preset compatibility rows do not snapshot provider URLs or keys.
        '',
        llmModel
      ),
    ]);
    const row = await c.env.DB.prepare('SELECT * FROM engine_presets WHERE id = ?').bind(id).first();
    return c.json(row, 201);
  });

  app.post('/api/me/engine-presets/:presetId/apply', async (c) => {
    const body = await readWorkspaceBody<{ assistantId?: string }>(c.req);
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
    if (!preset.language.trim()) return c.json({ error: 'Preset language is required before applying it' }, 400);
    const provider = await c.env.DB.prepare('SELECT * FROM provider_settings WHERE business_id = ?')
      .bind(assistant.business_id).first<ProviderSettings>();
    const incompatibility = presetCompatibilityError(c.env, provider, preset);
    if (incompatibility) return c.json({ error: incompatibility }, 400);
    const statements = [
      c.env.DB.prepare(
        `UPDATE assistants SET engine=?, realtime_model=?, realtime_voice=?, language=?, voice=?, llm_model=?, updated_at=datetime('now')
         WHERE id=? AND ${CHECKED_REALTIME_PROVIDER_SQL}
           AND ${checkedPresetSourceSql('engine_presets')}`
      ).bind(
        preset.engine,
        preset.realtime_model,
        preset.realtime_voice,
        preset.language,
        preset.voice,
        preset.llm_model,
        assistant.id,
        ...checkedRealtimeProvider(provider),
        ...checkedPresetSource(preset)
      ),
    ];
    if (await isCompatibilityAssistant(c.env, assistant)) {
      statements.push(
        c.env.DB.prepare(
          `UPDATE agent_settings SET engine=?, realtime_model=?, realtime_voice=?, language=?, voice=?, llm_model=?
           WHERE business_id=? AND changes()>0`
        ).bind(
          preset.engine,
          preset.realtime_model,
          preset.realtime_voice,
          preset.language,
          preset.voice,
          preset.llm_model,
          assistant.business_id
        )
      );
      statements.push(updateAgentSnapshot(c.env, assistant.business_id, true));
    }
    const [updated] = await c.env.DB.batch(statements);
    if (!updated.meta.changes) {
      return c.json({ error: 'Assistant or provider configuration changed. Reload and retry.' }, 409);
    }
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
    const body = await readWorkspaceBody<Record<string, unknown>>(c.req);
    const value = (key: string) => (typeof body[key] === 'string' ? body[key] as string : preset[key]);
    const name = value('name').trim() || preset.name;
    const engine = body.engine === 'realtime' ? 'realtime' : body.engine === 'pipeline' ? 'pipeline' : preset.engine;
    const realtimeModel = value('realtime_model');
    const realtimeVoice = value('realtime_voice');
    const language = value('language');
    if (!language.trim()) return c.json({ error: 'Preset language is required' }, 400);
    const voice = value('voice');
    const llmModel = value('llm_model');
    await assertPresetWriteBudget(c.env, preset.business_id as string, { id:preset.id, name, engine,
      realtime_model:realtimeModel, realtime_voice:realtimeVoice, language, voice, llm_model:llmModel }, false);
    const [updated] = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE engine_presets SET name=?, engine=?, realtime_model=?, realtime_voice=?, language=?, voice=?, llm_model=?, updated_at=datetime('now')
         WHERE id=? AND business_id=? AND ${checkedPresetWriteSql('engine_presets')}`
      ).bind(name, engine, realtimeModel, realtimeVoice, language, voice, llmModel, preset.id, preset.business_id, ...checkedPresetWrite(preset)),
      c.env.DB.prepare(
        `UPDATE engine_profiles SET name=?, engine=?, realtime_model=?, realtime_voice=?, language=?, voice=?, llm_model=?
         WHERE id=? AND business_id=? AND changes()>0`
      ).bind(name, engine, realtimeModel, realtimeVoice, language, voice, llmModel, preset.id, preset.business_id),
    ]);
    if (!updated.meta.changes) return c.json({ error: 'Preset changed. Reload and retry.' }, 409);
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
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM engine_presets WHERE id = ?').bind(preset.id),
      c.env.DB.prepare('DELETE FROM engine_profiles WHERE id = ?').bind(preset.id),
    ]);
    return c.json({ ok: true });
  });
}
