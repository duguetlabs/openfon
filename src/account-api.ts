import type { Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { hashPassword, newToken, verifyPassword } from './auth';
import type { Env } from './types';

type App = Hono<{ Bindings: Env; Variables: { userId: string } }>;
type RecordRow = Record<string, unknown>;

// Explicit export columns prevent new credential fields from silently becoming portable.
const EXPORT_COLUMNS: Record<string, string[]> = {
  businesses: ['id', 'user_id', 'slug', 'name', 'description', 'address', 'phone', 'website', 'timezone', 'hours_json', 'services_json', 'faqs_json', 'created_at', 'closures_json', 'max_concurrent_calls', 'max_calls_per_day'],
  assistants: ['id', 'business_id', 'public_slug', 'state', 'name', 'greeting', 'persona', 'language', 'voice', 'take_messages', 'custom_instructions', 'engine', 'realtime_model', 'realtime_voice', 'llm_model', 'created_at', 'updated_at', 'activated_at'],
  agent_settings: ['business_id', 'agent_name', 'greeting', 'persona', 'language', 'voice', 'take_messages', 'custom_instructions', 'llm_base_url', 'llm_model', 'engine', 'realtime_model', 'realtime_voice'],
  provider_settings: ['business_id', 'llm_base_url', 'llm_model', 'stt_provider', 'stt_base_url', 'stt_model', 'realtime_provider', 'realtime_base_url', 'created_at', 'updated_at'],
  engine_presets: ['id', 'business_id', 'name', 'engine', 'realtime_model', 'realtime_voice', 'language', 'voice', 'llm_model', 'created_at', 'updated_at'],
  engine_profiles: ['id', 'business_id', 'name', 'engine', 'realtime_model', 'realtime_voice', 'language', 'voice', 'llm_base_url', 'llm_model', 'created_at'],
  knowledge_collections: ['id', 'business_id', 'name', 'description', 'is_default', 'created_at', 'updated_at'],
  knowledge_items: ['id', 'business_id', 'collection_id', 'kind', 'status', 'title', 'question', 'answer', 'content', 'source_call_id', 'source_turn_id', 'created_at', 'updated_at', 'activated_at'],
  calls: ['id', 'business_id', 'channel', 'caller_id', 'status', 'started_at', 'ended_at', 'duration_s', 'summary', 'intent', 'message_json', 'connected_at', 'assistant_id', 'environment', 'direction', 'outcome', 'unanswered_json', 'failure_code', 'failure_message'],
  call_turns: ['id', 'call_id', 'role', 'text', 'ts'],
  assistant_knowledge_collections: ['assistant_id', 'collection_id', 'attached_at'],
};
const EXPORT_BYTE_LIMIT = 4 * 1024 * 1024;

export function registerAccountApi(app: App): void {
  app.use('/api/me/account/*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Account request is too large.' }, 413) }));
  app.use('/api/me/account', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Account request is too large.' }, 413) }));
  const accountLimit = (action: 'export' | 'mutation'): MiddlewareHandler<{ Bindings: Env; Variables: { userId: string } }> => async (c, next) => {
    // Export needs only a session cookie. Its read budget must not consume the
    // password-authenticated mutation budget used to revoke stolen sessions.
    // Full buckets refuse without growing the counter or repeating PBKDF2.
    const windowStart = Math.floor(Date.now() / 900_000) * 900;
    const reserved = await c.env.DB.prepare(
      `INSERT INTO rate_counters (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start) DO UPDATE SET count=count+1 WHERE count<10 RETURNING count`
    ).bind(`account:${action}:${c.get('userId')}`, windowStart).first();
    if (!reserved) return c.json({ error: 'Too many account actions. Please try again in 15 minutes.' }, 429, { 'Retry-After': '900' });
    await next();
  };
  app.post('/api/me/account/password', accountLimit('mutation'), async (c) => {
    const body = await c.req.json<RecordRow>().catch(() => null);
    if (!body || typeof body.currentPassword !== 'string' || body.currentPassword.length > 1024 ||
        typeof body.newPassword !== 'string' || body.newPassword.length < 8 || body.newPassword.length > 1024) {
      return c.json({ error: 'Enter your current password and a new password between 8 and 1024 characters.' }, 400);
    }
    const userId = c.get('userId');
    const user = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(userId).first<{ password_hash: string }>();
    if (!user || !await verifyPassword(body.currentPassword, user.password_hash)) return c.json({ error: 'Current password is incorrect.' }, 403);
    if (body.currentPassword === body.newPassword) return c.json({ error: 'Choose a different new password.' }, 400);
    const nextHash = await hashPassword(body.newPassword);
    const token = getCookie(c, 'ofs') ?? '';
    const replacement = newToken();
    const now = Date.now();
    const expires = new Date(now + 30 * 86400_000).toISOString();
    // The compare-and-swap prevents two simultaneous changes from overwriting
    // one another. D1 batch is transactional: session revocation and the hash
    // change succeed together, and a losing request cannot revoke sessions.
    const result = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE users SET password_hash=? WHERE id=? AND password_hash=?
        AND EXISTS (SELECT 1 FROM sessions WHERE token=? AND user_id=? AND expires_at>?)`)
        .bind(nextHash, userId, user.password_hash, token, userId, new Date(now).toISOString()),
      c.env.DB.prepare(`DELETE FROM sessions WHERE user_id=?
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND password_hash=?)`)
        .bind(userId, userId, nextHash),
      c.env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at)
        SELECT ?, id, ? FROM users WHERE id=? AND password_hash=?`)
        .bind(replacement, expires, userId, nextHash),
    ]);
    if (result[0].meta.changes !== 1) return c.json({ error: 'Your account changed during this request. Sign in again and retry.' }, 409);
    setCookie(c, 'ofs', replacement, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 });
    return c.json({ ok: true });
  });

  app.get('/api/me/account/export', accountLimit('export'), async (c) => {
    const userId = c.get('userId');
    const data: Record<string, RecordRow[]> = {};
    const tables = { users: ['id', 'email', 'created_at'], ...EXPORT_COLUMNS };
    const ctes: string[] = [];
    const measurements: string[] = [];
    const rawMeasurements: string[] = [];
    const payloads: string[] = [];
    const bindings: string[] = [];
    // One SQL statement provides a snapshot across the owner and every table.
    // Measure all rows before returning any payload; a global byte gate prevents
    // independently bounded tables from multiplying peak response memory.
    for (const [table, columns] of Object.entries(tables)) {
      const scope = table === 'users' ? 'id=?' : table === 'businesses' ? 'user_id=?'
        : table === 'call_turns' ? 'call_id IN (SELECT calls.id FROM calls JOIN businesses ON businesses.id=calls.business_id WHERE businesses.user_id=?)'
        : table === 'assistant_knowledge_collections' ? 'assistant_id IN (SELECT assistants.id FROM assistants JOIN businesses ON businesses.id=assistants.business_id WHERE businesses.user_id=?)'
        : 'business_id IN (SELECT id FROM businesses WHERE user_id=?)';
      // D1 permits at most 32 arguments per SQL function. json_set preserves
      // nullable fields (json_patch would remove them) while adding more keys.
      let jsonRow = `json_object(${columns.slice(0, 16).map(column => `'${column}', ${column}`).join(', ')})`;
      for (let offset = 16; offset < columns.length; offset += 15) {
        jsonRow = `json_set(${jsonRow}, ${columns.slice(offset, offset + 15).map(column => `'$.${column}', ${column}`).join(', ')})`;
      }
      const rowLimit = table === 'call_turns' ? 25000 : 10000;
      // JSON escaping may expand a byte to six characters. Refuse unusually
      // large legacy rows before constructing JSON, below D1's 2 MB string
      // limit even in that worst case. Normal API writes are capped at 128 KiB.
      const rawBytes = columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(' + ');
      // ASCII keys, punctuation and null values plus worst-case six-byte JSON
      // escaping per raw byte. This scalar upper bound is measured before any
      // json_object/json_set allocation, including across different tables.
      const rowOverhead = 3 + columns.reduce((sum, column) => sum + column.length + 8, 0);
      // Measure bounded raw rows first; rejected accounts must never construct
      // JSON for their payload. The second scan shares this statement's snapshot.
      ctes.push(`${table}_raw AS MATERIALIZED (
        SELECT COUNT(*) AS row_count, COALESCE(SUM(raw_bytes),0) AS bytes,
          COALESCE(SUM(6 * raw_bytes + ${rowOverhead}),0) + 2 AS escaped_bound,
          COALESCE(MAX(raw_bytes),0) AS largest_row, ${rowLimit} AS row_limit
        FROM (SELECT (${rawBytes}) AS raw_bytes FROM ${table} WHERE ${scope} LIMIT ${rowLimit + 1})
      )`);
      bindings.push(userId);
      rawMeasurements.push(`SELECT * FROM ${table}_raw`);
      ctes.push(`${table}_rows AS MATERIALIZED (
        SELECT ${jsonRow} AS item FROM ${table}
        WHERE (SELECT escaped_bound<=${EXPORT_BYTE_LIMIT - 4096} AND largest_row<=240000 AND too_many=0 FROM raw_budget)
          AND ${scope} LIMIT ${rowLimit}
      )`);
      bindings.push(userId);
      measurements.push(`SELECT '${table}' AS table_name, COUNT(*) AS row_count,
        COALESCE(SUM(length(CAST(item AS BLOB)) + 1),0)+2 AS bytes,
        COALESCE(MAX(CASE WHEN item IS NULL THEN 1500001 ELSE length(CAST(item AS BLOB)) END),0) AS largest_row,
        ${rowLimit} AS row_limit FROM ${table}_rows`);
      payloads.push(`SELECT '${table}' AS table_name, item AS payload FROM ${table}_rows`);
    }
    // D1 caps a compound SELECT at five terms. Materialized groups also
    // prevent the planner flattening these bounded unions into a larger one.
    const groupedUnion = (name: string, queries: string[]) => {
      const groups: string[] = [];
      for (let offset=0; offset<queries.length; offset+=4) {
        const group = `${name}_${offset}`;
        ctes.push(`${group} AS MATERIALIZED (${queries.slice(offset,offset+4).join(' UNION ALL ')})`);
        groups.push(`SELECT * FROM ${group}`);
      }
      return groups.join(' UNION ALL ');
    };
    const rawSql = groupedUnion('raw_group', rawMeasurements);
    ctes.push(`raw_budget AS MATERIALIZED (SELECT SUM(bytes) AS bytes, SUM(escaped_bound) AS escaped_bound, MAX(largest_row) AS largest_row,
      MAX(CASE WHEN row_count>row_limit THEN 1 ELSE 0 END) AS too_many FROM (${rawSql}))`);
    const measuredSql = groupedUnion('measurement_group', measurements);
    const payloadSql = groupedUnion('payload_group', payloads);
    const result = await c.env.DB.prepare(`WITH ${ctes.join(',')},
      measured AS MATERIALIZED (${measuredSql}),
      budget AS (SELECT MAX(SUM(bytes), (SELECT escaped_bound FROM raw_budget)) AS bytes,
        MAX(MAX(largest_row), CASE WHEN (SELECT largest_row FROM raw_budget)>240000 THEN 1500001 ELSE 0 END) AS largest_row,
        MAX(MAX(CASE WHEN row_count>row_limit THEN 1 ELSE 0 END), (SELECT too_many FROM raw_budget)) AS too_many FROM measured),
      payloads AS MATERIALIZED (${payloadSql})
      SELECT NULL AS table_name, NULL AS payload, bytes, largest_row, too_many FROM budget
      UNION ALL
      SELECT table_name, payload, 0, 0, 0 FROM payloads, budget
        WHERE bytes<=${EXPORT_BYTE_LIMIT - 4096} AND largest_row<=1500000 AND too_many=0`)
      .bind(...bindings).all<{ table_name: string | null; payload: string | null; bytes: number; largest_row: number; too_many: number }>();
    const measurement = result.results.find(row => row.table_name === null);
    if (!measurement || measurement.bytes > EXPORT_BYTE_LIMIT - 4096 || measurement.largest_row > 1_500_000 || measurement.too_many) {
      return c.json({ error: 'This account is too large for browser export. Ask your deployment administrator for a database export.' }, 413);
    }
    let account: RecordRow | null = null;
    for (const table of Object.keys(EXPORT_COLUMNS)) data[table] = [];
    for (const row of result.results) {
      if (row.table_name === null || row.payload === null) continue;
      const item = JSON.parse(row.payload) as RecordRow;
      if (row.table_name === 'users') account = item;
      else data[row.table_name].push(item);
    }
    c.header('Content-Disposition', 'attachment; filename="openfon-account.json"');
    return c.json({ schemaVersion: 1, exportedAt: new Date().toISOString(), account, data });
  });

  app.delete('/api/me/account', accountLimit('mutation'), async (c) => {
    const body = await c.req.json<RecordRow>().catch(() => null);
    if (!body || body.confirmation !== 'DELETE' || typeof body.currentPassword !== 'string' || body.currentPassword.length > 1024) {
      return c.json({ error: 'Enter your current password and type DELETE to confirm.' }, 400);
    }
    const userId = c.get('userId');
    const user = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(userId).first<{ password_hash: string }>();
    if (!user || !await verifyPassword(body.currentPassword, user.password_hash)) return c.json({ error: 'Current password is incorrect.' }, 403);
    // FK cascades remove sessions, workspaces, calls, transcripts, assistants,
    // presets and knowledge. Refuse atomically if a live or pending call exists;
    // deleting its database row cannot stop a running Durable Object safely.
    const deleted = await c.env.DB.prepare(`DELETE FROM users WHERE id=? AND password_hash=?
      AND EXISTS (SELECT 1 FROM sessions WHERE token=? AND user_id=? AND expires_at>?)
      AND NOT EXISTS (SELECT 1 FROM calls JOIN businesses ON businesses.id=calls.business_id
        WHERE businesses.user_id=? AND (calls.status='active'
          OR (calls.reserved_at IS NOT NULL AND calls.carrier_released_at IS NULL))) RETURNING id`)
      .bind(userId, user.password_hash, getCookie(c, 'ofs') ?? '', userId, new Date().toISOString(), userId).first<{ id: string }>();
    // D1 meta.changes includes cascades; RETURNING identifies the deleted owner
    // directly instead of treating successful dependent deletes as a conflict.
    if (!deleted) return c.json({ error: 'Finish active calls and wait for pending calls to expire before deleting. If your account changed, sign in again.' }, 409);
    deleteCookie(c, 'ofs', { path: '/' });
    return c.json({ ok: true });
  });
}
