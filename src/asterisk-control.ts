import type { Env } from './types';
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
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const call = url.searchParams.get('call') || '';
    const route = url.searchParams.get('route') || '';
    if (url.pathname !== '/media' || !/^ast_[a-f0-9]{64}$/.test(call) || !/^[a-zA-Z0-9_-]{1,80}$/.test(route)) return new Response(null, { status: 400 });
    if (this.env.ASTERISK_ENABLED !== 'true' || !await authenticateAsterisk(this.env, route, request.headers.get('Authorization'))) return new Response(null, { status: 403 });
    // Synchronous latch closes the async admission race. Persistent identity
    // prevents reconnect/replay from creating a second session after eviction.
    if (this.claimed) return new Response(null, { status: 409 });
    this.claimed = true;
    if (await this.state.storage.get('call')) return new Response(null, { status: 409 });
    await this.state.storage.put('call', call);
    await this.state.storage.setAlarm(Date.now() + 30000);
    try {
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
      if (!row) { await this.state.storage.deleteAlarm(); return new Response(null, { status: 403 }); }
      const stub = this.env.CALL_SESSION.get(this.env.CALL_SESSION.idFromName(call));
      const response = await stub.fetch(new Request(`https://internal/?call=${call}`, { headers: { Upgrade: 'websocket' } }));
      if (!response.webSocket) throw Error('session_unavailable');
      this.session = response.webSocket; this.session.accept(); this.session.binaryType = 'arraybuffer';
      const pair = new WebSocketPair(); this.carrier = pair[1]; this.carrier.accept(); this.carrier.binaryType = 'arraybuffer';
      const send = (socket: WebSocket, data: string | ArrayBuffer) => {
        const buffered = (socket as WebSocket & { bufferedAmount?: number }).bufferedAmount;
        if (socket.readyState !== 1 || (buffered !== undefined && buffered > 65536)) throw Error('socket_closed');
        socket.send(data);
      };
      this.adapter = new AsteriskMediaAdapter({
        carrierSend: data => send(this.carrier!, data), sessionSend: data => send(this.session!, data),
        onEnd: reason => {
          for (const socket of [this.carrier, this.session]) { try { socket?.close(1000, 'call ended'); } catch { /* closed */ } }
          this.state.waitUntil(this.finish(call, reason));
        },
      });
      this.carrier.addEventListener('message', event => this.adapter?.carrierMessage(event.data));
      this.session.addEventListener('message', event => this.adapter?.sessionMessage(event.data));
      for (const socket of [this.carrier, this.session]) {
        socket.addEventListener('close', () => this.adapter?.close());
        socket.addEventListener('error', () => this.adapter?.close('socket_error'));
      }
      await this.env.DB.prepare("UPDATE calls SET connected_at=datetime('now') WHERE id=? AND status='active'").bind(call).run();
      await this.state.storage.put('deadline', Date.now() + 30 * 60000);
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'media' } });
    } catch {
      this.adapter?.close('setup_failed');
      try { this.session?.close(1011, 'setup failed'); } catch { /* closed */ }
      await this.finish(call, 'setup_failed');
      return new Response(null, { status: 503 });
    }
  }
  private async finish(call: string, reason: string): Promise<void> {
    // Alarm is retained until D1 release succeeds, including a failed waitUntil.
    await this.state.storage.put('ending', reason);
    await this.state.storage.setAlarm(Date.now() + 30000);
    await this.env.DB.prepare(`UPDATE calls SET carrier_released_at=COALESCE(carrier_released_at,datetime('now')),
      status=CASE WHEN status='active' AND connected_at IS NULL THEN 'failed' ELSE status END,
      ended_at=CASE WHEN connected_at IS NULL THEN COALESCE(ended_at,datetime('now')) ELSE ended_at END
      WHERE id=? AND channel='asterisk'`).bind(call).run();
    // CallSession normally persists the transcript/outcome. Let it finish before
    // a recovery alarm retires any row left active by a lost session owner.
    await this.state.storage.put('cleanup', Date.now() + 60000);
    await this.state.storage.setAlarm(Date.now() + 60000);
  }
  async alarm(): Promise<void> {
    const call = await this.state.storage.get<string>('call');
    if (!call) return;
    // Rearm before I/O so a prolonged D1 outage cannot exhaust platform retries.
    await this.state.storage.setAlarm(Date.now() + 30000);
    const cleanup = await this.state.storage.get<number>('cleanup');
    if (cleanup) {
      await this.env.DB.prepare(`UPDATE calls SET status='failed',ended_at=COALESCE(ended_at,datetime('now')),
        failure_code=COALESCE(failure_code,'asterisk_session_lost') WHERE id=? AND status='active' AND channel='asterisk'`).bind(call).run();
      await this.state.storage.deleteAlarm(); return;
    }
    const ending = await this.state.storage.get<string>('ending');
    const deadline = await this.state.storage.get<number>('deadline');
    if (ending || !this.adapter || !deadline || Date.now() >= deadline || this.env.ASTERISK_ENABLED !== 'true') {
      this.adapter?.close('call_duration_or_owner_limit');
      await this.finish(call, ending || 'owner_recovered');
    } else await this.state.storage.setAlarm(Math.min(deadline, Date.now() + 30000));
  }
}
