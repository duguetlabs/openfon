import { telephoneRealtimeAvailable, type RealtimeSettings } from './realtime-providers';
import type { AgentSettings, Env } from './types';
import { authenticateAsterisk } from './asterisk-routes';
import { AsteriskMediaAdapter } from './asterisk-media';
import { OCCUPIED_CALL_SQL } from './telnyx-admission';

/** One authenticated PBX channel per durable owner. A closed media websocket
 * hangs up chan_websocket itself; no external paid-leg command API is required.
 */
export class AsteriskCall implements DurableObject {
  private adapter?: AsteriskMediaAdapter;
  private carrier?: WebSocket;
  private session?: WebSocket;
  private claimed = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private state: DurableObjectState, private env: Env) {}

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.pending.then(run, run);
    this.pending = next.catch(() => {});
    return next;
  }

  private async compact(): Promise<void> {
    // Retain only replay protection, even if the workspace/D1 call is deleted.
    // Transaction failure leaves the old recovery state AND its alarm intact.
    await this.state.storage.transaction(async txn => {
      await txn.put('retired', true);
      await txn.delete(['call', 'deadline', 'ending', 'cleanup']);
      await txn.deleteAlarm();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const prepared = await this.exclusive(() => this.prepare(request));
    if (prepared instanceof Response) return prepared;
    const { call } = prepared;
    let response: Response | undefined;
    try {
      // Network/DO startup must not hold the owner lock: alarms can release the
      // reservation while it waits, and installation rechecks their decision.
      const stub = this.env.CALL_SESSION.get(this.env.CALL_SESSION.idFromName(call));
      response = await this.openSession(stub, call);
      return await this.exclusive(() => this.install(call, response!));
    } catch {
      if (response) this.closeResponse(response);
      return this.exclusive(async () => {
        await this.finish(call, 'setup_failed');
        return new Response(null, { status: 503 });
      });
    }
  }

  private closeResponse(response: Response): void {
    const socket = response.webSocket;
    if (!socket) return;
    try { socket.accept(); } catch { /* possibly already accepted */ }
    try { socket.close(1000, 'call ended'); } catch { /* already closed */ }
  }

  private async openSession(stub: DurableObjectStub, call: string): Promise<Response> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const opening = stub.fetch(new Request(`https://internal/?call=${call}`, { headers: { Upgrade: 'websocket' } }))
        .then(response => { if (expired) this.closeResponse(response); return response; });
      return await Promise.race([opening, new Promise<Response>((_resolve, reject) => {
        timer = setTimeout(() => { expired = true; reject(Error('session_start_timeout')); }, 10000);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private async prepare(request: Request): Promise<Response | { call: string }> {
    const url = new URL(request.url);
    const call = url.searchParams.get('call') || '';
    const route = url.searchParams.get('route') || '';
    if (url.pathname !== '/media' || !/^ast_[a-f0-9]{64}$/.test(call) || !/^[a-zA-Z0-9_-]{1,80}$/.test(route)) return new Response(null, { status: 400 });
    if (this.env.ASTERISK_ENABLED !== 'true' || !await authenticateAsterisk(this.env, route, request.headers.get('Authorization'))) return new Response(null, { status: 403 });
    // Synchronous latch closes the async admission race. Persistent identity
    // prevents reconnect/replay from creating a second session after eviction.
    if (await this.state.storage.get('retired') || this.claimed) return new Response(null, { status: 409 });
    this.claimed = true;
    if (await this.state.storage.get('call')) {
      // Wake legacy terminal/rejected state that older code left without alarm.
      await this.state.storage.setAlarm(Date.now() + 1);
      return new Response(null, { status: 409 });
    }
    try {
      await this.state.storage.transaction(async txn => {
        await txn.put('call', call);
        await txn.setAlarm(Date.now() + 30000);
      });
    } catch {
      this.claimed = false;
      return new Response(null, { status: 503 });
    }
    try {
      const settings = await this.env.DB.prepare(`SELECT a.engine,a.realtime_model,
        p.realtime_provider,p.realtime_base_url,p.realtime_api_key
        FROM asterisk_routes r JOIN assistants a ON a.id=r.assistant_id AND a.business_id=r.business_id
        LEFT JOIN provider_settings p ON p.business_id=r.business_id WHERE r.id=? AND r.enabled=1`)
        .bind(route).first<AgentSettings & RealtimeSettings>();
      if (!telephoneRealtimeAvailable(this.env, settings)) {
        await this.compact(); return new Response(null, { status: 403 });
      }
      const row = await this.env.DB.prepare(`INSERT OR IGNORE INTO calls
        (id,business_id,assistant_id,channel,caller_id,environment,direction,reserved_at)
        SELECT ?,r.business_id,r.assistant_id,'asterisk','PBX caller','live','inbound',datetime('now')
        FROM asterisk_routes r JOIN assistants a ON a.id=r.assistant_id AND a.business_id=r.business_id
        JOIN businesses b ON b.id=r.business_id
        WHERE r.id=? AND r.enabled=1 AND a.state='active' AND a.engine='realtime'
          AND trim(a.name)<>'' AND trim(a.persona)<>'' AND trim(a.language)<>''
          AND (SELECT COUNT(*) FROM calls WHERE business_id=r.business_id AND environment='live' AND ${OCCUPIED_CALL_SQL})<b.max_concurrent_calls
          AND (SELECT COUNT(*) FROM calls WHERE business_id=r.business_id AND environment='live'
            AND started_at>datetime('now','-1 day') AND NOT(status='abandoned' AND connected_at IS NULL AND reserved_at IS NULL))<b.max_calls_per_day
        RETURNING id`).bind(call, route).first();
      if (!row) { await this.compact(); return new Response(null, { status: 403 }); }
      return { call };
    } catch {
      await this.finish(call, 'setup_failed');
      return new Response(null, { status: 503 });
    }
  }

  private async install(call: string, response: Response): Promise<Response> {
    if (await this.state.storage.get('retired') || await this.state.storage.get('ending') ||
        await this.state.storage.get('cleanup') || this.env.ASTERISK_ENABLED !== 'true') {
      this.closeResponse(response);
      await this.finish(call, 'setup_cancelled');
      return new Response(null, { status: 409 });
    }
    try {
      if (response.status !== 101 || !response.webSocket) throw Error('session_unavailable');
      this.session = response.webSocket; this.session.accept(); this.session.binaryType = 'arraybuffer';
      const pair = new WebSocketPair(); this.carrier = pair[1]; this.carrier.accept(); this.carrier.binaryType = 'arraybuffer';
      const send = (socket: WebSocket, data: string | ArrayBuffer) => {
        const buffered = (socket as WebSocket & { bufferedAmount?: number }).bufferedAmount;
        if (socket.readyState !== 1 || (buffered !== undefined && buffered > 65536)) throw Error('socket_closed');
        socket.send(data);
      };
      this.adapter = new AsteriskMediaAdapter({
        carrierSend: data => send(this.carrier!, data), sessionSend: data => send(this.session!, data),
        onReady: () => {
          // Readiness is emitted only after valid PBX MEDIA_START + session ready.
          // Serialize with finish so the observed event order also owns metrics.
          this.state.waitUntil(this.exclusive(async () => {
            try {
              if (await this.state.storage.get('retired') || await this.state.storage.get('ending')) return;
              const connected = await this.env.DB.prepare(`UPDATE calls SET connected_at=COALESCE(connected_at,datetime('now'))
                WHERE id=? AND status='active' AND carrier_released_at IS NULL RETURNING id`).bind(call).first();
              if (!connected) throw Error('call_ended');
            } catch { this.adapter?.close('readiness_projection_failed'); }
          }));
        },
        onEnd: reason => {
          for (const socket of [this.carrier, this.session]) { try { socket?.close(1000, 'call ended'); } catch { /* closed */ } }
          this.state.waitUntil(this.exclusive(() => this.finish(call, reason)));
        },
      });
      this.carrier.addEventListener('message', event => this.adapter?.carrierMessage(event.data));
      this.session.addEventListener('message', event => this.adapter?.sessionMessage(event.data));
      for (const socket of [this.carrier, this.session]) {
        socket.addEventListener('close', event => this.adapter?.close(
          event.code === 1000 || event.code === 1005 ? 'socket_closed' : 'socket_error'));
        socket.addEventListener('error', () => this.adapter?.close('socket_error'));
      }
      await this.state.storage.put('deadline', Date.now() + 30 * 60000);
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'media' } });
    } catch {
      this.closeResponse(response);
      this.adapter?.close('setup_failed');
      try { this.session?.close(1011, 'setup failed'); } catch { /* closed */ }
      await this.finish(call, 'setup_failed');
      return new Response(null, { status: 503 });
    }
  }
  private async finish(call: string, reason: string): Promise<void> {
    if (await this.state.storage.get('retired')) return;
    // Alarm is retained until D1 release succeeds, including a failed waitUntil.
    const previous = await this.state.storage.get<string>('ending');
    // A generic hangup cannot convey these errors to CallSession. Preserve the
    // first known failure across retries; ordinary close/recovery is not proof
    // of failure for a connected call.
    const failures = new Set(['invalid_carrier_frame', 'invalid_session_frame', 'playback_error',
      'playback_overflow', 'drain_timeout', 'start_timeout', 'session_error', 'socket_error',
      'readiness_projection_failed', 'setup_failed', 'setup_cancelled', 'call_duration_or_owner_limit']);
    if (previous && failures.has(previous)) reason = previous;
    const failed = failures.has(reason) ? 1 : 0;
    await this.state.storage.put('ending', reason);
    await this.state.storage.setAlarm(Date.now() + 30000);
    await this.env.DB.prepare(`UPDATE calls SET carrier_released_at=COALESCE(carrier_released_at,datetime('now')),
      status=CASE WHEN connected_at IS NULL OR ? THEN 'failed' ELSE status END,
      outcome=CASE WHEN connected_at IS NULL OR ? THEN 'failed' ELSE outcome END,
      failure_code=CASE WHEN connected_at IS NULL OR ? THEN COALESCE(failure_code,CASE WHEN connected_at IS NULL THEN 'asterisk_start_failed' ELSE ? END) ELSE failure_code END,
      failure_message=CASE WHEN connected_at IS NULL OR ? THEN COALESCE(failure_message,CASE WHEN connected_at IS NULL THEN 'The telephone audio connection did not become ready.' ELSE ? END) ELSE failure_message END,
      ended_at=CASE WHEN connected_at IS NULL OR ? THEN COALESCE(ended_at,datetime('now')) ELSE ended_at END
      WHERE id=? AND channel='asterisk'`).bind(failed, failed, failed, `asterisk_${reason}`,
        failed, 'The telephone audio connection failed.', failed, call).run();
    // CallSession normally persists the transcript/outcome. Let it finish before
    // a recovery alarm retires any row left active by a lost session owner.
    await this.state.storage.put('cleanup', Date.now() + 60000);
    await this.state.storage.setAlarm(Date.now() + 60000);
  }
  alarm(): Promise<void> {
    return this.exclusive(() => this.tick());
  }

  private async tick(): Promise<void> {
    if (await this.state.storage.get('retired')) { await this.compact(); return; }
    const call = await this.state.storage.get<string>('call');
    if (!call) return;
    // Rearm before I/O so a prolonged D1 outage cannot exhaust platform retries.
    await this.state.storage.setAlarm(Date.now() + 30000);
    const cleanup = await this.state.storage.get<number>('cleanup');
    if (cleanup) {
      if (Date.now() < cleanup) { await this.state.storage.setAlarm(cleanup); return; }
      await this.env.DB.prepare(`UPDATE calls SET status='failed',ended_at=COALESCE(ended_at,datetime('now')),
        failure_code=COALESCE(failure_code,'asterisk_session_lost') WHERE id=? AND status='active' AND channel='asterisk'`).bind(call).run();
      await this.compact(); return;
    }
    const ending = await this.state.storage.get<string>('ending');
    const deadline = await this.state.storage.get<number>('deadline');
    if (ending || !this.adapter || !deadline || Date.now() >= deadline || this.env.ASTERISK_ENABLED !== 'true') {
      this.adapter?.close('call_duration_or_owner_limit');
      await this.finish(call, ending || 'owner_recovered');
    } else await this.state.storage.setAlarm(Math.min(deadline, Date.now() + 30000));
  }
}
