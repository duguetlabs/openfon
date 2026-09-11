import type { Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie } from 'hono/cookie';
import { hashPassword, verifyPassword } from './auth';
import type { Env } from './types';

type App = Hono<{ Bindings: Env; Variables: { userId: string } }>;
type RecordRow = Record<string, unknown>;

// Explicit export columns prevent new credential fields from silently becoming portable.
const EXPORT_COLUMNS: Record<string, string[]> = {
  businesses: ['id', 'user_id', 'slug', 'name', 'description', 'address', 'phone', 'website', 'timezone', 'hours_json', 'services_json', 'faqs_json', 'created_at', 'closures_json', 'max_concurrent_calls', 'max_calls_per_day'],
  assistants: ['id', 'business_id', 'public_slug', 'state', 'name', 'greeting', 'persona', 'language', 'voice', 'take_messages', 'custom_instructions', 'engine', 'realtime_model', 'realtime_voice', 'llm_model', 'created_at', 'updated_at', 'activated_at'],
  agent_settings: ['business_id', 'agent_name', 'greeting', 'persona', 'language', 'voice', 'take_messages', 'custom_instructions', 'llm_base_url', 'llm_model', 'engine', 'realtime_model', 'realtime_voice'],
  provider_settings: ['business_id', 'llm_base_url', 'created_at', 'updated_at'],
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
  const accountLimit: MiddlewareHandler<{ Bindings: Env; Variables: { userId: string } }> = async (c, next) => {
    // Bound export reads and password verification work per account. A full
    // bucket is refused without growing its counter or running PBKDF2 again.
    const windowStart = Math.floor(Date.now() / 900_000) * 900;
    const reserved = await c.env.DB.prepare(
      `INSERT INTO rate_counters (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start) DO UPDATE SET count=count+1 WHERE count<10 RETURNING count`
    ).bind(`account:${c.get('userId')}`, windowStart).first();
    if (!reserved) return c.json({ error: 'Too many account actions. Please try again in 15 minutes.' }, 429, { 'Retry-After': '900' });
    await next();
  };
  app.use('/api/me/account', accountLimit);
  app.use('/api/me/account/*', accountLimit);

  app.post('/api/me/account/password', async (c) => {
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
    // The compare-and-swap prevents two simultaneous changes from overwriting
    // one another. D1 batch is transactional: session revocation and the hash
    // change succeed together, and a losing request cannot revoke sessions.
    const result = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE users SET password_hash=? WHERE id=? AND password_hash=?
        AND EXISTS (SELECT 1 FROM sessions WHERE token=? AND user_id=? AND expires_at>?)`)
        .bind(nextHash, userId, user.password_hash, token, userId, new Date().toISOString()),
      c.env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND token<>?
        AND EXISTS (SELECT 1 FROM users WHERE id=? AND password_hash=?)`)
        .bind(userId, token, userId, nextHash),
    ]);
    if (result[0].meta.changes !== 1) return c.json({ error: 'Your account changed during this request. Sign in again and retry.' }, 409);
    return c.json({ ok: true });
  });

  app.get('/api/me/account/export', async (c) => {
    const userId = c.get('userId');
    const account = await c.env.DB.prepare('SELECT id, email, created_at FROM users WHERE id=?').bind(userId).first();
    const data: Record<string, RecordRow[]> = {};
    // Keep the response below 4 MiB, leaving room for the envelope. Each SQL
    // statement measures serialized bytes and returns JSON only within the
    // remaining budget, from the SAME snapshot. A separate preflight query
    // would race concurrent edits and could still materialize an oversized row.
    let remainingBytes = EXPORT_BYTE_LIMIT - 4096;
    for (const [table, columns] of Object.entries(EXPORT_COLUMNS)) {
      const scope = table === 'businesses' ? 'user_id=?'
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
      const result = await c.env.DB.prepare(`WITH export_rows AS (
          SELECT CASE WHEN (${rawBytes})<=240000 THEN ${jsonRow} ELSE NULL END AS item FROM ${table} WHERE ${scope}
        ), measured AS (
          SELECT COUNT(*) AS row_count, COALESCE(SUM(length(CAST(item AS BLOB)) + 1), 0) + 2 AS bytes,
            COALESCE(MAX(CASE WHEN item IS NULL THEN 1500001 ELSE length(CAST(item AS BLOB)) END), 0) AS largest_row FROM export_rows
        ) SELECT row_count, bytes, largest_row, NULL AS payload FROM measured
          UNION ALL
          SELECT 0, 0, 0, item FROM export_rows, measured WHERE row_count<=? AND bytes<=? AND largest_row<=1500000`)
        .bind(userId, rowLimit, remainingBytes).all<{ row_count: number; bytes: number; largest_row: number; payload: string | null }>();
      const measurement = result.results.find(row => row.payload === null);
      if (!measurement || measurement.row_count > rowLimit || measurement.bytes > remainingBytes || measurement.largest_row > 1_500_000) {
        return c.json({ error: 'This account is too large for browser export. Ask your deployment administrator for a database export.' }, 413);
      }
      remainingBytes -= measurement.bytes;
      data[table] = result.results.filter(row => row.payload !== null).map(row => JSON.parse(row.payload!) as RecordRow);
    }
    c.header('Content-Disposition', 'attachment; filename="openfon-account.json"');
    return c.json({ schemaVersion: 1, exportedAt: new Date().toISOString(), account, data });
  });

  app.delete('/api/me/account', async (c) => {
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
