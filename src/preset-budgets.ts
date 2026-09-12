// SQL returns one scalar; historical profile text never crosses the D1 boundary.
// Oversized legacy workspaces retain their rows and can delete them via bounded lists.
export const PRESET_RECONCILIATION_SQL = `
WITH input AS (SELECT ? AS biz), legacy AS (SELECT * FROM engine_profiles WHERE business_id=(SELECT biz FROM input)),
 presets AS (SELECT * FROM engine_presets WHERE business_id=(SELECT biz FROM input)),
 changed AS (SELECT l.id FROM legacy l WHERE NOT EXISTS
   (SELECT 1 FROM presets p WHERE p.id=l.id AND p.name=l.name AND p.engine=l.engine AND p.realtime_model=l.realtime_model AND p.realtime_voice=l.realtime_voice AND p.language=l.language AND p.voice=l.voice AND p.llm_model=l.llm_model))
SELECT CASE WHEN (SELECT COUNT(*) FROM legacy)<=64
 AND (SELECT COUNT(*) FROM presets)<=64
 AND COALESCE((SELECT SUM(length(CAST(l.id AS BLOB))+length(CAST(l.name AS BLOB))+length(CAST(l.engine AS BLOB))+length(CAST(l.realtime_model AS BLOB))+length(CAST(l.realtime_voice AS BLOB))+length(CAST(l.language AS BLOB))+length(CAST(l.voice AS BLOB))+length(CAST(l.llm_model AS BLOB))) FROM legacy l),0)<=524288
 AND COALESCE((SELECT SUM(length(CAST(p.id AS BLOB))+length(CAST(p.name AS BLOB))+length(CAST(p.engine AS BLOB))+length(CAST(p.realtime_model AS BLOB))+length(CAST(p.realtime_voice AS BLOB))+length(CAST(p.language AS BLOB))+length(CAST(p.voice AS BLOB))+length(CAST(p.llm_model AS BLOB))) FROM presets p),0)<=524288
 AND COALESCE((SELECT count FROM rate_counters WHERE bucket='presets:'||(SELECT biz FROM input)
   AND window_start=CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400),0)
   +(SELECT COUNT(*) FROM changed)<=400
 AND (EXISTS(SELECT 1 FROM changed) OR EXISTS
   (SELECT 1 FROM presets p WHERE NOT EXISTS(SELECT 1 FROM legacy l WHERE l.id=p.id)))
 THEN 1 ELSE 0 END AS needed`;

export const PRESET_CHANGED_SQL = `p.name=l.name AND p.engine=l.engine AND p.realtime_model=l.realtime_model AND p.realtime_voice=l.realtime_voice AND p.language=l.language AND p.voice=l.voice AND p.llm_model=l.llm_model`;

import { HTTPException } from 'hono/http-exception';
import type { Env } from './types';
const fields = ['id','name','engine','realtime_model','realtime_voice','language','voice','llm_model'] as const;
/** Read-only preflight avoids known refusals after the first mirrored write.
 * SQL triggers remain authoritative for concurrent writers and batch rollback. */
export async function assertPresetWriteBudget(env: Env, businessId: string, row: Record<string, unknown>, creating: boolean): Promise<void> {
  const bytes = fields.reduce((sum, field) => sum + new TextEncoder().encode(String(row[field] ?? '')).byteLength, 0);
  const stats = await env.DB.prepare(`WITH input AS (SELECT ? AS biz, ? AS id) SELECT
    (SELECT COUNT(*) FROM engine_profiles WHERE business_id=(SELECT biz FROM input)) AS legacy_count,
    (SELECT COUNT(*) FROM engine_presets WHERE business_id=(SELECT biz FROM input)) AS preset_count,
    (SELECT COALESCE(SUM(${fields.map(f=>`length(CAST(${f} AS BLOB))`).join('+')}+length(CAST(llm_base_url AS BLOB))+length(CAST(llm_api_key AS BLOB))),0) FROM engine_profiles WHERE business_id=(SELECT biz FROM input)) AS legacy_bytes,
    (SELECT COALESCE(SUM(${fields.map(f=>`length(CAST(${f} AS BLOB))`).join('+')}),0) FROM engine_presets WHERE business_id=(SELECT biz FROM input)) AS preset_bytes,
    (SELECT ${fields.map(f=>`length(CAST(${f} AS BLOB))`).join('+')}+length(CAST(llm_base_url AS BLOB))+length(CAST(llm_api_key AS BLOB)) FROM engine_profiles WHERE business_id=(SELECT biz FROM input) AND id=(SELECT id FROM input)) AS legacy_old,
    (SELECT ${fields.map(f=>`length(CAST(${f} AS BLOB))`).join('+')} FROM engine_presets WHERE business_id=(SELECT biz FROM input) AND id=(SELECT id FROM input)) AS preset_old,
    COALESCE((SELECT count FROM rate_counters WHERE bucket='presets:'||(SELECT biz FROM input) AND window_start=CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400),0) AS writes`)
    .bind(businessId, String(row.id)).first<Record<string, number | null>>();
  if (!stats) throw new Error('Missing preset budget');
  for (const prefix of ['legacy','preset']) {
    const old = Number(stats[`${prefix}_old`] ?? 0);
    if ((creating && Number(stats[`${prefix}_count`]) >= 64) ||
      ((creating || bytes > old) && Number(stats[`${prefix}_bytes`]) - old + bytes > 524288)) {
      throw new HTTPException(409, { res: Response.json({ error: 'Preset storage limit reached. Delete or shorten existing presets first.' }, { status: 409 }) });
    }
  }
  const writes = creating ? 2 : Number(stats.legacy_old !== null) + Number(stats.preset_old !== null);
  if (Number(stats.writes) + writes > 400) throw new HTTPException(429, { res: Response.json({ error: 'Preset daily write limit reached. Try again tomorrow.' }, { status: 429 }) });
}

// Lists are recovery previews, even for pre-quota rows. Apply resolves the full row by ID.
export const PRESET_LIST_COLUMNS = `id,business_id,created_at,
 ${fields.filter(f=>f!=='id').map(f=>`substr(${f},1,256) AS ${f}`).join(',')},
 CASE WHEN ${fields.filter(f=>f!=='id').map(f=>`length(${f})>256`).join(' OR ')} THEN 1 ELSE 0 END AS preview_only`;

export const PRESET_ROW_BYTES = (alias: string) => fields.map(field => `length(CAST(${alias}.${field} AS BLOB))`).join('+');
