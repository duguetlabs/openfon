import type { Env } from './types';
import type { TelnyxCallCorrelation, VerifiedTelnyxEvent } from './telnyx-webhook';
import { reserveTelnyxCall, telnyxMediaAllowed } from './telnyx-admission';
import { createTelnyxMediaBridge } from './telnyx-media';

export type TelnyxAction = 'answer' | 'streaming_start' | 'hangup';
export interface TelnyxControlEvent {
  id: string;
  type: string;
  callId: string;
  call: TelnyxCallCorrelation;
  from?: string;
  to?: string;
}
interface Command {
  id: string;
  action: TelnyxAction;
  body: Record<string, unknown>;
  attempts: number;
  nextAt: number;
  accepted: boolean;
}
interface ControlState {
  callId: string;
  call: TelnyxCallCorrelation;
  inbox: TelnyxControlEvent[];
  seen: string[];
  admitted: boolean;
  initiationSeen: boolean;
  answered: boolean;
  streamStarted: boolean;
  ending: boolean;
  terminal: boolean;
  reason: string;
  setupDeadline: number;
  hardDeadline: number;
  cleanupAt: number | null;
  mediaClaimed: boolean;
  mediaValidated: boolean;
  streamToken: string;
  tokenExpiresAt: number;
  commands: Partial<Record<TelnyxAction, Command>>;
}

export const TELNYX_CONTROL_EVENTS = new Set([
  'call.initiated', 'call.answered', 'call.hangup',
  'streaming.started', 'streaming.stopped', 'streaming.failed',
]);

export function telnyxConfigured(env: Env): boolean {
  if (!env.TELNYX_CALL || !env.TELNYX_API_KEY || !env.TELNYX_PUBLIC_KEY || !env.TELNYX_CONNECTION_ID) return false;
  try { telnyxPublicOrigin(env); return true; } catch { return false; }
}

export function telnyxPublicOrigin(env: Env): string {
  const url = new URL(env.TELNYX_PUBLIC_ORIGIN || '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Invalid Telnyx public origin');
  }
  return url.origin;
}

export function telnyxControlEvent(event: VerifiedTelnyxEvent, callId: string): TelnyxControlEvent | null {
  if (!event.call || !TELNYX_CONTROL_EVENTS.has(event.eventType)) return null;
  if (event.eventType === 'call.initiated') {
    if (event.payload.direction !== 'incoming') return null;
    if (typeof event.payload.to !== 'string' || !/^\+[1-9]\d{1,14}$/.test(event.payload.to)) return null;
    if (typeof event.payload.from !== 'string' || event.payload.from.length > 512 || /[\u0000-\u001f\u007f]/.test(event.payload.from)) return null;
  }
  return {
    id: event.eventId, type: event.eventType, callId, call: event.call,
    ...(event.eventType === 'call.initiated' ? { to: event.payload.to as string, from: event.payload.from as string } : {}),
  };
}

/** Stable persisted command bodies are retried against a fixed provider origin. */
export async function sendTelnyxCommand(env: Env, callControlId: string, command: Pick<Command, 'action' | 'body'>): Promise<boolean> {
  if (!env.TELNYX_API_KEY) return false;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 8000);
  try {
    const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/${command.action}`, {
      method: 'POST', redirect: 'manual', signal: abort.signal,
      headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command.body),
    });
    void response.body?.cancel().catch(() => {});
    return response.ok;
  } catch { return false; }
  finally { clearTimeout(timeout); }
}

/** Authenticated status reconciliation for a lost terminal webhook. A 404, an
 * ambiguous response, or an identity mismatch is not evidence of release.
 * Endpoint: https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-commands-and-resources
 */
export async function telnyxCallEnded(env: Env, call: TelnyxCallCorrelation): Promise<boolean> {
  if (!env.TELNYX_API_KEY) return false;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 8000);
  try {
    const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(call.callControlId)}`, {
      headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}` }, redirect: 'manual', signal: abort.signal,
    });
    if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); return false; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) { await reader.cancel(); return false; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as { data?: Record<string, unknown> };
    return body?.data?.record_type === 'call' && body.data.is_alive === false &&
      body.data.call_control_id === call.callControlId && body.data.call_leg_id === call.callLegId &&
      body.data.call_session_id === call.callSessionId;
  } catch { return false; }
  finally { clearTimeout(timeout); }
}

export function equalStreamToken(actual: string | null, expected: string): boolean {
  if (!actual || actual.length !== 64 || expected.length !== 64) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

const CARRIER_FAILURES = new Set([
  'carrier_stream_failed', 'media_owner_restarted', 'media_setup_timeout',
  'media_bridge_failed', 'assistant_unavailable', 'start_timeout', 'carrier_error',
  'invalid_carrier_frame', 'invalid_media_order', 'drain_timeout',
  'session_error', 'invalid_session_frame', 'playback_error', 'playback_overflow', 'socket_closed',
]);

function newState(event: TelnyxControlEvent): ControlState {
  const now = Date.now();
  return {
    callId: event.callId, call: event.call, inbox: [], seen: [], admitted: false,
    initiationSeen: false, answered: false, streamStarted: false, ending: false, terminal: false, reason: '',
    setupDeadline: now + 60_000, hardDeadline: now + 30 * 60_000, cleanupAt: null,
    mediaClaimed: false, mediaValidated: false, streamToken: '', tokenExpiresAt: 0, commands: {},
  };
}

/** One durable owner for a carrier leg. HTTP ingress only durably enqueues;
 * alarms drive admission, commands and cleanup, including after an isolate restart.
 */
export class TelnyxCall implements DurableObject {
  private tail: Promise<unknown> = Promise.resolve();
  private bridge: { close(reason?: string): void } | null = null;
  private recoveryChecked = false;

  constructor(private state: DurableObjectState, private env: Env) {}

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.then(() => {}, () => {});
    return next;
  }

  private async load(): Promise<ControlState | undefined> {
    return this.state.storage.get<ControlState>('control');
  }

  // Keep only a non-identifying marker after cleanup. Terminal-first calls may
  // have no D1 row, so deleting replay protection would let a late initiation
  // recreate a paid leg. The marker must survive eviction and account deletion.
  private async retired(): Promise<boolean> {
    return (await this.state.storage.get<boolean>('retired')) === true;
  }

  private async compact(): Promise<void> {
    // Atomically replace operational state and its alarm with replay protection.
    // A crash can retain the old terminal state or the marker, never neither.
    await this.state.storage.transaction(async txn => {
      await txn.put('retired', true);
      await txn.delete('control');
      await txn.deleteAlarm();
    });
  }

  private async persist(s: ControlState): Promise<void> {
    // Arm before storing. If a put fails, ingress does not acknowledge the event;
    // the earlier alarm can safely wake an empty object, and delivery retries.
    const deadlines = s.terminal ? [Math.min(s.cleanupAt ?? Date.now() + 60_000, Date.now() + 30_000)] : s.ending ? [] : [s.hardDeadline];
    if (!s.terminal && (!s.ending || !s.initiationSeen) && !s.mediaValidated) deadlines.push(s.setupDeadline);
    if (s.inbox.length) deadlines.push(Date.now() + 1);
    for (const command of Object.values(s.commands)) {
      if (command && !command.accepted) deadlines.push(command.nextAt);
    }
    await this.state.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...(deadlines.length ? deadlines : [Date.now() + 60_000]))));
    await this.state.storage.put('control', s);
  }

  private end(s: ControlState, reason: string): void {
    if (s.terminal) return;
    s.ending = true;
    s.reason ||= reason;
    delete s.commands.answer;
    delete s.commands.streaming_start;
    if (s.initiationSeen || s.admitted) this.plan(s, 'hangup', {});
  }

  private async projectFailure(s: ControlState): Promise<void> {
    if (!s.admitted || !CARRIER_FAILURES.has(s.reason)) return;
    // Only fixed internal reason codes become owner-visible. Keep this separate
    // from carrier release, and repeat after session finalization may overwrite it.
    await this.env.DB.prepare(`UPDATE calls SET
      failure_code=?, failure_message='The telephone audio connection failed. Please review the call and retry.',
      outcome='failed', status=CASE WHEN status!='active' OR (?=1 AND connected_at IS NULL) THEN 'failed' ELSE status END,
      ended_at=CASE WHEN ?=1 AND connected_at IS NULL THEN COALESCE(ended_at,datetime('now')) ELSE ended_at END
      WHERE id=? AND channel='telnyx'`)
      .bind(s.reason, s.terminal ? 1 : 0, s.terminal ? 1 : 0, s.callId).run();
  }

  private plan(s: ControlState, action: TelnyxAction, body: Record<string, unknown>): void {
    if (s.commands[action]) return;
    const id = crypto.randomUUID();
    s.commands[action] = { id, action, body: { ...body, command_id: id }, attempts: 0, nextAt: Date.now(), accepted: false };
  }

  private async consume(s: ControlState, event: TelnyxControlEvent): Promise<void> {
    if (event.type === 'call.hangup') {
      s.terminal = true;
      s.ending = true;
      s.commands = {};
      s.streamToken = '';
      s.cleanupAt ??= Date.now() + 35 * 60_000;
      await this.env.DB.prepare(
        "UPDATE calls SET carrier_released_at=COALESCE(carrier_released_at, datetime('now')) WHERE id=? AND channel='telnyx'"
      ).bind(s.callId).run();
      await this.env.DB.prepare("UPDATE telnyx_call_links SET carrier_state='ended', updated_at=datetime('now') WHERE call_id=?").bind(s.callId).run();
      this.bridge?.close('carrier_hangup');
      return;
    }
    if (s.terminal) return;
    if (event.type === 'call.initiated' && !s.initiationSeen) {
      s.initiationSeen = true;
      if (s.ending || this.env.TELNYX_ENABLED !== 'true') { this.end(s, 'feature_disabled'); return; }
      s.admitted = await reserveTelnyxCall(this.env, s.callId, s.call, event.to || '', event.from || 'anonymous');
      if (!s.admitted) this.end(s, 'admission_rejected');
    } else if (s.ending) return;
    else if (event.type === 'call.answered') {
      s.answered = true;
      delete s.commands.answer;
    } else if (event.type === 'streaming.started') {
      s.streamStarted = true;
      delete s.commands.streaming_start;
    } else if (event.type === 'streaming.stopped' || event.type === 'streaming.failed') {
      this.end(s, event.type === 'streaming.failed' ? 'carrier_stream_failed' : 'carrier_stream_stopped');
    }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/media') return this.media(request);
    if (path === '/reconcile' && request.method === 'POST') {
      return this.exclusive(async () => {
        if (await this.retired()) await this.compact();
        else await this.state.storage.setAlarm(Date.now() + 1);
        return new Response(null, { status: 204 });
      });
    }
    if (path !== '/events' || request.method !== 'POST') return new Response(null, { status: 404 });
    const event = await request.json<TelnyxControlEvent>();
    // Binding-only endpoint, still reject malformed or mismatched internal input.
    if (!event.call || !/^tnx_[0-9a-f]{64}$/.test(event.callId) || !event.id || !TELNYX_CONTROL_EVENTS.has(event.type)) {
      return new Response(null, { status: 400 });
    }
    return this.exclusive(async () => {
      if (await this.retired()) return new Response(null, { status: 204 });
      const existing = await this.load();
      if (!existing && this.env.TELNYX_ENABLED !== 'true') return new Response(null, { status: 204 });
      const s = existing ?? newState(event);
      if (s.callId !== event.callId || Object.entries(s.call).some(([key, value]) => value !== event.call[key as keyof TelnyxCallCorrelation])) {
        return new Response(null, { status: 409 });
      }
      if (!s.seen.includes(event.id) && !s.inbox.some(item => item.id === event.id)) {
        if (s.inbox.length >= 128) return new Response(null, { status: 503 });
        s.inbox.push(event);
      }
      await this.persist(s);
      // The alarm is the durable authority; waitUntil is only a latency aid.
      this.state.waitUntil(this.alarm());
      return new Response(null, { status: 204 });
    });
  }

  async alarm(): Promise<void> {
    try { await this.tick(); }
    catch {
      // D1/provider outages must not strand an already acknowledged inbox after
      // the platform exhausts its short automatic alarm retry sequence.
      await this.state.storage.setAlarm(Date.now() + 60_000);
    }
  }

  private async tick(): Promise<void> {
    const dispatch = await this.exclusive(async () => {
      if (await this.retired()) { await this.compact(); return null; }
      const s = await this.load();
      if (!s) { await this.state.storage.deleteAlarm(); return null; }
      if (!this.recoveryChecked) {
        this.recoveryChecked = true;
        if (s.mediaClaimed && !this.bridge) this.end(s, 'media_owner_restarted');
      }
      while (s.inbox.length) {
        const event = s.inbox[0];
        await this.consume(s, event);
        s.inbox.shift(); s.seen.push(event.id); s.seen = s.seen.slice(-512);
        await this.persist(s);
      }
      if (s.terminal) {
        await this.projectFailure(s);
        if (s.cleanupAt === null || Date.now() >= s.cleanupAt) {
          await this.env.DB.prepare(
            `UPDATE calls SET status='abandoned', ended_at=COALESCE(ended_at, datetime('now')),
              failure_code=COALESCE(failure_code, 'carrier_finalization_timeout')
             WHERE id=? AND channel='telnyx' AND status='active' AND carrier_released_at IS NOT NULL`
          ).bind(s.callId).run();
          // Reconcile first, then compact atomically. Null also handles legacy
          // records whose previous cleanup left the full state with no alarm.
          await this.compact();
        } else await this.persist(s);
        return null;
      }
      if (this.env.TELNYX_ENABLED !== 'true') this.end(s, 'feature_disabled');
      if (Date.now() >= s.hardDeadline) this.end(s, 'call_duration_limit');
      if (!s.mediaValidated && Date.now() >= s.setupDeadline) this.end(s, 'media_setup_timeout');
      // Unowned/outgoing legs can share this application. Observations alone
      // never authorize commands; expire their reorder buffer without touching
      // the carrier if no authenticated incoming initiation follows.
      if (!s.initiationSeen && !s.admitted) {
        s.commands = {};
        if (Date.now() >= s.setupDeadline) { s.terminal = true; s.cleanupAt = Date.now() + 35 * 60_000; }
      }
      if (!s.ending && s.admitted) {
        if (!s.answered) this.plan(s, 'answer', {});
        else if (!s.mediaClaimed && !s.streamStarted) {
          if (!s.streamToken) {
            s.streamToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
            s.tokenExpiresAt = s.setupDeadline;
          }
          this.plan(s, 'streaming_start', {
            stream_url: `${telnyxPublicOrigin(this.env).replace(/^https:/, 'wss:')}/ws/telnyx/${s.callId}`,
            stream_auth_token: s.streamToken, stream_track: 'inbound_track', stream_codec: 'PCMU',
            stream_bidirectional_mode: 'rtp', stream_bidirectional_codec: 'PCMU',
            stream_bidirectional_sampling_rate: 8000, stream_bidirectional_target_legs: 'self',
          });
        }
      }
      if (s.ending) {
        this.bridge?.close('carrier_ending');
        await this.projectFailure(s);
      }
      const command = Object.values(s.commands).find(item => item && !item.accepted && item.nextAt <= Date.now());
      if (command) { command.attempts++; command.nextAt = Date.now() + 10_000; }
      await this.persist(s);
      return command ? { command: structuredClone(command), callControlId: s.call.callControlId, call: s.call } : null;
    });
    if (!dispatch) return;
    // Do not hold the event/inbox lock over external I/O. A terminal webhook can
    // be durably accepted even while a provider command times out.
    const accepted = await sendTelnyxCommand(this.env, dispatch.callControlId, dispatch.command);
    const ended = dispatch.command.action === 'hangup' && dispatch.command.attempts >= 2
      ? await telnyxCallEnded(this.env, dispatch.call) : false;
    await this.exclusive(async () => {
      const s = await this.load();
      const command = s?.commands[dispatch.command.action];
      if (!s || !command || command.id !== dispatch.command.id) return;
      if (ended) {
        await this.consume(s, { id: 'status-reconciled', type: 'call.hangup', callId: s.callId, call: s.call });
        await this.persist(s);
        return;
      }
      if (accepted && command.action !== 'hangup') command.accepted = true;
      // Successful hangup means command accepted, not proven carrier release.
      // Keep the reservation and retry until a signed call.hangup is received.
      command.nextAt = Date.now() + (accepted ? 30_000 : Math.min(60_000, 1000 * 2 ** Math.min(command.attempts, 6)));
      await this.persist(s);
    });
  }

  private async terminate(reason: string): Promise<void> {
    await this.exclusive(async () => {
      const s = await this.load();
      if (!s || s.terminal) return;
      this.end(s, reason);
      await this.persist(s);
    });
  }

  private async media(request: Request): Promise<Response> {
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
    return this.exclusive(async () => {
      if (await this.retired()) return new Response(null, { status: 403 });
      const s = await this.load();
      if (this.env.TELNYX_ENABLED !== 'true' || !s || !s.admitted || s.ending || !s.answered ||
          Date.now() >= s.tokenExpiresAt || !equalStreamToken(request.headers.get('x-telnyx-streaming-auth-token'), s.streamToken)) {
        return new Response(null, { status: 403 });
      }
      if (s.mediaClaimed) return new Response(null, { status: 409 });
      if (!await telnyxMediaAllowed(this.env, s.callId)) {
        this.end(s, 'assistant_unavailable'); await this.persist(s); return new Response(null, { status: 403 });
      }
      s.mediaClaimed = true;
      this.recoveryChecked = true;
      await this.persist(s);
      let session: WebSocket | null = null;
      let carrier: WebSocket | null = null;
      try {
        const stub = this.env.CALL_SESSION.get(this.env.CALL_SESSION.idFromName(s.callId));
        const response = await stub.fetch(new Request(`https://internal/?call=${s.callId}`, { headers: { Upgrade: 'websocket' } }));
        if (response.status !== 101 || !response.webSocket) throw new Error('session_unavailable');
        session = response.webSocket;
        session.accept();
        const pair = new WebSocketPair();
        carrier = pair[1]; carrier.accept();
        this.bridge = createTelnyxMediaBridge({
          carrier, session, callId: s.callId, callControlId: s.call.callControlId,
          callLegId: s.call.callLegId, callSessionId: s.call.callSessionId, streamToken: s.streamToken,
          onStart: () => this.exclusive(async () => {
            const current = await this.load();
            if (!current || current.ending) throw new Error('call_ended');
            await this.env.DB.prepare("UPDATE calls SET connected_at=COALESCE(connected_at, datetime('now')) WHERE id=? AND status='active'").bind(s.callId).run();
            current.mediaValidated = true;
            delete current.commands.streaming_start;
            await this.persist(current);
          }),
          onEnded: reason => { this.state.waitUntil(this.terminate(reason)); },
        });
        return new Response(null, { status: 101, webSocket: pair[0] });
      } catch {
        try { session?.close(); carrier?.close(); } catch { /* best effort; durable hangup below */ }
        this.end(s, 'media_bridge_failed'); await this.persist(s);
        return new Response(null, { status: 502 });
      }
    });
  }
}
