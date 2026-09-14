import type { Hono } from 'hono';
import { TelnyxMediaAdmission } from './telnyx-media-admission';
import type { Env } from './types';
import { verifyTelnyxWebhook, TelnyxWebhookError, TELNYX_WEBHOOK_MAX_BYTES } from './telnyx-webhook';
import { telnyxConfigured, telnyxControlEvent } from './telnyx-control';
import { telnyxLocalCallId } from './telnyx-admission';

async function boundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new TelnyxWebhookError('invalid_payload');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > TELNYX_WEBHOOK_MAX_BYTES) {
        await reader.cancel();
        throw new TelnyxWebhookError('body_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export function registerTelnyxRoutes(app: Hono<{ Bindings: Env; Variables: { userId: string } }>): void {
  const mediaAdmission = new TelnyxMediaAdmission();
  app.post('/api/telnyx/webhooks', async c => {
    c.header('Cache-Control', 'no-store');
    if (!c.env.TELNYX_CALL || !c.env.TELNYX_PUBLIC_KEY || !c.env.TELNYX_CONNECTION_ID) return c.json({ error: 'Carrier ingress unavailable' }, 503);
    try {
      const event = await verifyTelnyxWebhook({
        body: await boundedBody(c.req.raw), contentType: c.req.header('Content-Type') ?? null,
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
        const status = error.code === 'body_too_large' ? 413 : error.code === 'invalid_content_type' ? 415
          : error.code === 'invalid_configuration' ? 503 : error.code === 'invalid_payload' ? 400 : 401;
        return c.json({ error: 'Invalid carrier webhook' }, status);
      }
      return c.json({ error: 'Carrier event could not be accepted' }, 503);
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
