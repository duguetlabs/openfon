import type { Hono } from 'hono';
import { TelnyxMediaAdmission } from './telnyx-media-admission';
import { TelnyxWebhookAdmission, type TelnyxWebhookLease } from './telnyx-webhook-admission';
import type { Env } from './types';
import { verifyTelnyxWebhook, TelnyxWebhookError, TELNYX_WEBHOOK_MAX_BYTES,
  TELNYX_WEBHOOK_BODY_TIMEOUT_MS, TELNYX_WEBHOOK_MAX_READS } from './telnyx-webhook';
import { telnyxConfigured, telnyxControlEvent } from './telnyx-control';
import { telnyxLocalCallId } from './telnyx-admission';

// Shared by every route registration in this isolate, never by request identity.
const webhookAdmission = new TelnyxWebhookAdmission();

async function boundedBody(request: Request, lease: TelnyxWebhookLease): Promise<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false, cancelled = false;
  const cancel = () => {
    if (!reader || cancelled) return;
    cancelled = true;
    lease.cancellationStarted();
    // Do not await cleanup on the response path. A failure quarantines capacity;
    // an unresolved cancellation retains it even after the five-second response.
    try {
      void reader.cancel().then(() => lease.cancellationFulfilled(), () => lease.quarantine());
    } catch { lease.quarantine(); }
  };
  try {
    // Own the reader before any allocation/timer setup that can throw.
    if (!request.body) throw new TelnyxWebhookError('invalid_payload');
    reader = request.body.getReader();
    lease.readerAcquired();
    const bytes = new Uint8Array(TELNYX_WEBHOOK_MAX_BYTES);
    let size = 0, reads = 0;
    const expiresAt = Date.now() + TELNYX_WEBHOOK_BODY_TIMEOUT_MS;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TelnyxWebhookError('body_timeout')), TELNYX_WEBHOOK_BODY_TIMEOUT_MS);
    });
    const checkDeadline = () => {
      if (finished || Date.now() >= expiresAt) throw new TelnyxWebhookError('body_timeout');
    };
    const consume = async () => {
      for (;;) {
        checkDeadline();
        // Empty chunks consume no bytes and can starve timers. Bound read work
        // independently, allowing a full body fragmented into single bytes.
        if (++reads > TELNYX_WEBHOOK_MAX_READS) throw new TelnyxWebhookError('invalid_payload');
        const { value, done } = await reader!.read();
        checkDeadline();
        if (done) break;
        if (value.byteLength > TELNYX_WEBHOOK_MAX_BYTES - size) throw new TelnyxWebhookError('body_too_large');
        bytes.set(value, size); size += value.byteLength;
      }
      return bytes.subarray(0, size);
    };
    lease.consumeStarted();
    const consuming = consume().finally(() => lease.consumeSettled());
    // One deadline reaction, not one retained reaction per body fragment.
    return await Promise.race([consuming, deadline]);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    finished = true;
    try { if (timer !== undefined) clearTimeout(timer); } catch { lease.quarantine(); }
    if (reader) {
      try { reader.releaseLock(); lease.readerReleased(); } catch { lease.quarantine(); }
    }
    lease.bodySettled();
  }
}

export function registerTelnyxRoutes(app: Hono<{ Bindings: Env; Variables: { userId: string } }>): void {
  const mediaAdmission = new TelnyxMediaAdmission();
  app.post('/api/telnyx/webhooks', async c => {
    c.header('Cache-Control', 'no-store');
    if (!c.env.TELNYX_CALL || !c.env.TELNYX_PUBLIC_KEY || !c.env.TELNYX_CONNECTION_ID) return c.json({ error: 'Carrier ingress unavailable' }, 503);
    if (!c.req.raw.body) return c.json({ error: 'Invalid carrier webhook' }, 400);
    const lease = webhookAdmission.acquire();
    // Never acquire/cancel a rejected reader or queue work outside the budget.
    if (!lease) return c.json({ error: 'Carrier ingress unavailable' }, 503, { 'Retry-After': '1' });
    try {
      const event = await verifyTelnyxWebhook({
        body: await boundedBody(c.req.raw, lease), contentType: c.req.header('Content-Type') ?? null,
        signature: c.req.header('telnyx-signature-ed25519') ?? null,
        timestamp: c.req.header('telnyx-timestamp') ?? null,
      }, { publicKey: c.env.TELNYX_PUBLIC_KEY!, nowSeconds: Math.floor(Date.now() / 1000) });
      if (!event.call) return c.json({ received: true });
      if (event.call.connectionId !== c.env.TELNYX_CONNECTION_ID) return c.json({ error: 'Unexpected carrier application' }, 403);
      const callId = await telnyxLocalCallId(event.call);
      if (event.eventType === 'call.initiated' && c.env.TELNYX_ENABLED === 'true' && !telnyxConfigured(c.env)) return c.json({ error: 'Carrier ingress unavailable' }, 503);
      const control = telnyxControlEvent(event, callId);
      if (!control) return c.json({ received: true });
      const stub = c.env.TELNYX_CALL!.get(c.env.TELNYX_CALL!.idFromName(callId));
      const result = await stub.fetch(new Request('https://internal/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(control),
      }));
      if (!result.ok) return c.json({ error: 'Carrier event could not be accepted' }, 503);
      return c.json({ received: true });
    } catch (error) {
      if (error instanceof TelnyxWebhookError) {
        const status = error.code === 'body_timeout' ? 408 : error.code === 'body_too_large' ? 413 : error.code === 'invalid_content_type' ? 415
          : error.code === 'invalid_configuration' ? 503 : error.code === 'invalid_payload' ? 400 : 401;
        return c.json({ error: 'Invalid carrier webhook' }, status);
      }
      return c.json({ error: 'Carrier event could not be accepted' }, 503);
    } finally {
      // Successful body aliases/copies remain owned through crypto and durable
      // dispatch. This is not a new deadline on either downstream operation.
      lease.routeSettled();
    }
  });

  app.get('/ws/telnyx/:callId', async c => {
    if (c.env.TELNYX_ENABLED !== 'true' || !telnyxConfigured(c.env)) return c.json({ error: 'Carrier ingress unavailable' }, 503);
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return c.json({ error: 'Expected websocket' }, 426);
    const callId = c.req.param('callId');
    if (!/^tnx_[0-9a-f]{64}$/.test(callId)) return c.json({ error: 'Not found' }, 404);
    const headers = new Headers({ Upgrade: 'websocket' });
    const token = c.req.header('x-telnyx-streaming-auth-token');
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return c.json({ error: 'Invalid stream authorization' }, 403);
    // Admission precedes all D1/DO work and never writes persistent counters.
    const release = mediaAdmission.acquire();
    if (!release) return c.json({ error: 'Too many stream attempts' }, 429, { 'Retry-After': '1' });
    let call;
    try {
      // Row existence is not authentication; owner token/claim checks follow.
      call = await c.env.DB.prepare(
        `SELECT id FROM calls WHERE id=? AND channel='telnyx' AND status='active'
          AND reserved_at IS NOT NULL AND carrier_released_at IS NULL`
      ).bind(callId).first();
    } finally { release(); }
    // Do not hold a lookup permit for the owner upgrade or socket lifetime.
    if (!call) return c.json({ error: 'Not found' }, 404);
    headers.set('x-telnyx-streaming-auth-token', token);
    const stub = c.env.TELNYX_CALL!.get(c.env.TELNYX_CALL!.idFromName(callId));
    return stub.fetch(new Request('https://internal/media', { headers }));
  });
}

/** Sweep only wakes durable owners; it never releases an unconfirmed carrier leg. */
export async function reconcileTelnyxCalls(env: Env): Promise<void> {
  if (!env.TELNYX_CALL) return;
  const { results } = await env.DB.prepare(
    `SELECT calls.id FROM calls JOIN telnyx_call_links link ON link.call_id=calls.id
      WHERE calls.reserved_at IS NOT NULL AND calls.carrier_released_at IS NULL
        AND calls.reserved_at < datetime('now', '-2 minutes') ORDER BY calls.reserved_at LIMIT 100`
  ).all<{ id: string }>();
  await Promise.all(results.map(async row => {
    const stub = env.TELNYX_CALL!.get(env.TELNYX_CALL!.idFromName(row.id));
    await stub.fetch(new Request('https://internal/reconcile', { method: 'POST' }));
  }));
}
