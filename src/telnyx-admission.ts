import { telephoneRealtimeAvailable } from './realtime-providers';
import type { AgentSettings, Env } from './types';
import type { TelnyxCallCorrelation } from './telnyx-webhook';

// A completed AI session can still own a paid carrier leg. Keep that reservation
// counted until a signed terminal carrier event confirms its release.
export const OCCUPIED_CALL_SQL = `((status = 'active' AND connected_at IS NOT NULL AND (channel != 'telnyx' OR carrier_released_at IS NULL))
  OR (reserved_at IS NOT NULL AND carrier_released_at IS NULL))`;

export async function telnyxLocalCallId(call: TelnyxCallCorrelation): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`telnyx\0${call.connectionId}\0${call.callLegId}`));
  return `tnx_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function reserveTelnyxCall(
  env: Env,
  callId: string,
  call: TelnyxCallCorrelation,
  to: string,
  from: string,
): Promise<boolean> {
  if (!/^\+[1-9]\d{1,14}$/.test(to)) return false;
  // Retrying after a crash between D1 commit and DO commit must reuse the row,
  // even if a later operator edit disables the number. Media rechecks policy.
  const existing = await env.DB.prepare(
    `SELECT call_id FROM telnyx_call_links WHERE call_id=? AND connection_id=?
       AND call_leg_id=? AND call_session_id=? AND call_control_id=?`
  ).bind(callId, call.connectionId, call.callLegId, call.callSessionId, call.callControlId).first();
  if (existing) return true;
  const settings = await env.DB.prepare(
    `SELECT assistants.engine, assistants.realtime_model,
       provider_settings.realtime_provider, provider_settings.realtime_base_url, provider_settings.realtime_api_key
     FROM telnyx_number_routes route JOIN assistants ON assistants.id=route.assistant_id
     LEFT JOIN provider_settings ON provider_settings.business_id=route.business_id
     WHERE route.connection_id=? AND route.phone_number=? AND route.enabled=1
       AND assistants.business_id=route.business_id AND assistants.state='active'`
  ).bind(call.connectionId, to).first<AgentSettings>();
  if (!telephoneRealtimeAvailable(env, settings)) return false;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO calls
         (id, business_id, assistant_id, channel, caller_id, environment, direction, reserved_at)
       SELECT ?, route.business_id, route.assistant_id, 'telnyx', ?, 'live', 'inbound', datetime('now')
         FROM telnyx_number_routes route JOIN assistants ON assistants.id=route.assistant_id
         JOIN businesses ON businesses.id=route.business_id
        WHERE route.connection_id=? AND route.phone_number=? AND route.enabled=1
          AND assistants.business_id=route.business_id AND assistants.state='active'
          AND assistants.engine='realtime'
          AND trim(assistants.name)<>'' AND trim(assistants.persona)<>''
          AND trim(assistants.language)<>''
          AND (SELECT COUNT(*) FROM calls WHERE business_id=route.business_id AND environment='live'
                 AND ${OCCUPIED_CALL_SQL}) < businesses.max_concurrent_calls
          AND (SELECT COUNT(*) FROM calls WHERE business_id=route.business_id AND environment='live'
                 AND started_at > datetime('now', '-1 day')
                 AND NOT (status='abandoned' AND connected_at IS NULL AND reserved_at IS NULL)) < businesses.max_calls_per_day`
    ).bind(callId, from, call.connectionId, to),
    env.DB.prepare(
      `INSERT OR IGNORE INTO telnyx_call_links
        (call_id, connection_id, call_leg_id, call_session_id, call_control_id, phone_number)
       SELECT id, ?, ?, ?, ?, ? FROM calls WHERE id=? AND channel='telnyx'`
    ).bind(call.connectionId, call.callLegId, call.callSessionId, call.callControlId, to, callId),
  ]);
  return Boolean(await env.DB.prepare('SELECT call_id FROM telnyx_call_links WHERE call_id=?').bind(callId).first());
}

export async function telnyxMediaAllowed(env: Env, callId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT calls.id FROM calls
      JOIN assistants ON assistants.id=calls.assistant_id AND assistants.business_id=calls.business_id
      JOIN telnyx_call_links link ON link.call_id=calls.id
      JOIN telnyx_number_routes route ON route.connection_id=link.connection_id
        AND route.business_id=calls.business_id AND route.assistant_id=calls.assistant_id
        AND route.phone_number=link.phone_number
     WHERE calls.id=? AND calls.channel='telnyx' AND calls.status='active'
       AND calls.reserved_at IS NOT NULL AND calls.carrier_released_at IS NULL
       AND route.enabled=1 AND assistants.state='active' AND assistants.engine='realtime'`
  ).bind(callId).first();
  return Boolean(row);
}
