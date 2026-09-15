import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseTelnyxWebhookBody, verifyTelnyxWebhook, TELNYX_WEBHOOK_MAX_BYTES,
  type TelnyxWebhookInput,
} from '../src/telnyx-webhook';

// Node's independent Ed25519 signer checks interoperability with Web Crypto.
// These throwaway test keys are unrelated to any Telnyx account.
const keys = generateKeyPairSync('ed25519');
const publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
const now = 1_789_171_200;
const options = { publicKey, nowSeconds: now };
const fixture = () => ({
  data: {
    record_type: 'event', event_type: 'call.initiated',
    id: '0ccc7b54-4df3-4bca-a65a-3da1ecc777f0',
    occurred_at: '2026-09-12T00:00:00.521992Z',
    payload: {
      call_control_id: 'v3:synthetic-call-control-token', connection_id: '726700000000000001',
      call_leg_id: '428c31b6-7af4-4bcb-b7f5-5013ef9657c1',
      call_session_id: '528c31b6-7af4-4bcb-b7f5-5013ef9657c2',
      from: '+12025550100', to: '+12025550101', direction: 'incoming',
    },
  },
});

function signed(raw: string | Uint8Array = JSON.stringify(fixture()), timestamp = String(now)): TelnyxWebhookInput {
  const body = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
  const message = Buffer.concat([Buffer.from(`${timestamp}|`), Buffer.from(body)]);
  return {
    body, timestamp, signature: sign(null, message, keys.privateKey).toString('base64'),
    contentType: 'application/json',
  };
}

async function rejected(input: TelnyxWebhookInput, code: string) {
  await expect(verifyTelnyxWebhook(input, options)).rejects.toMatchObject({ name: 'TelnyxWebhookError', code });
}

describe('Telnyx signature verification', () => {
  it('verifies independent signatures and retains exact raw UTF-8 formatting', async () => {
    const raw = JSON.stringify({ ...fixture(), note: 'Grüße ☎' }, null, 2) + '\n';
    const event = await verifyTelnyxWebhook(signed(raw), options);
    expect(event.rawBody).toBe(raw);
    expect(event.signedAtSeconds).toBe(now);
    expect(event.eventId).toBe(fixture().data.id);
    expect(event.call).toEqual({
      callControlId: fixture().data.payload.call_control_id,
      callLegId: fixture().data.payload.call_leg_id,
      callSessionId: fixture().data.payload.call_session_id,
      connectionId: fixture().data.payload.connection_id,
    });
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('rejects altered bytes, including semantically identical JSON whitespace', async () => {
    const original = signed();
    await rejected({ ...original, body: new TextEncoder().encode(JSON.stringify(fixture(), null, 2)) }, 'invalid_signature');
    await rejected({ ...original, body: new TextEncoder().encode(JSON.stringify(fixture()).replace('incoming', 'outgoing')) }, 'invalid_signature');
  });

  it('rejects signatures from a different account key', async () => {
    const other = generateKeyPairSync('ed25519');
    const wrongKey = Buffer.from(other.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
    await expect(verifyTelnyxWebhook(signed(), { ...options, publicKey: wrongKey })).rejects.toMatchObject({ code: 'invalid_signature' });
  });

  it.each([-301, 301])('rejects a timestamp outside the past/future window (%i seconds)', async skew => {
    await rejected(signed(undefined, String(now + skew)), 'timestamp_out_of_range');
  });

  it.each([-300, 0, 300])('accepts the inclusive replay window boundary (%i seconds)', async skew => {
    await expect(verifyTelnyxWebhook(signed(undefined, String(now + skew)), options)).resolves.toMatchObject({ signedAtSeconds: now + skew });
  });

  it('authenticates the timestamp itself and uses signing time rather than event time', async () => {
    const input = signed();
    await rejected({ ...input, timestamp: String(now + 1) }, 'invalid_signature');
    const event = fixture(); event.data.occurred_at = '2018-02-02T22:25:27.521992Z';
    await expect(verifyTelnyxWebhook(signed(JSON.stringify(event)), options)).resolves.toMatchObject({ occurredAt: event.data.occurred_at });
  });

  it.each([null, '', ' 1789171200', '+1789171200', '01789171200', '1e9', '12.5', '9999999999999999', '1789171200,1789171200'])('rejects malformed timestamp %j', async timestamp => {
    await rejected({ ...signed(), timestamp }, 'invalid_headers');
  });

  it.each([null, '', 'not-base64!', 'A'.repeat(88), ' A'.repeat(44)])('rejects malformed signature without leaking it (%j)', async signature => {
    const promise = verifyTelnyxWebhook({ ...signed(), signature }, options);
    await expect(promise).rejects.toMatchObject({ code: 'invalid_headers' });
    await expect(promise).rejects.toThrow('Telnyx webhook rejected: invalid_headers');
  });

  it('accepts canonical unpadded standard Base64', async () => {
    const input = signed();
    await expect(verifyTelnyxWebhook({ ...input, signature: input.signature!.replace(/=+$/, '') }, {
      ...options, publicKey: publicKey.replace(/=+$/, ''),
    })).resolves.toMatchObject({ eventType: 'call.initiated' });
  });

  it.each(['', 'bad-key', 'A'.repeat(88)])('fails closed on missing or malformed configured public key', async key => {
    await expect(verifyTelnyxWebhook(signed(), { ...options, publicKey: key })).rejects.toMatchObject({ code: 'invalid_configuration' });
  });

  it.each([NaN, Infinity, -1, 0.5])('rejects invalid explicit clock %j', async time => {
    await expect(verifyTelnyxWebhook(signed(), { ...options, nowSeconds: time })).rejects.toMatchObject({ code: 'invalid_configuration' });
  });

  it.each([NaN, Infinity, -1, 3601])('does not allow replay validation to be disabled (%j)', async maxSkewSeconds => {
    await expect(verifyTelnyxWebhook(signed(), { ...options, maxSkewSeconds })).rejects.toMatchObject({ code: 'invalid_configuration' });
  });

  it('snapshots the body before asynchronous verification can observe caller mutation', async () => {
    const input = signed();
    const verified = verifyTelnyxWebhook(input, options);
    input.body.fill(0);
    await expect(verified).resolves.toMatchObject({ eventId: fixture().data.id });
  });

  it('leaves durable duplicate detection to the caller', async () => {
    const input = signed();
    expect((await verifyTelnyxWebhook(input, options)).eventId).toBe((await verifyTelnyxWebhook(input, options)).eventId);
  });
});

describe('Telnyx entity and event validation', () => {
  it('rejects excessive bytes even when their signature is valid', async () => {
    await rejected(signed(new Uint8Array(TELNYX_WEBHOOK_MAX_BYTES + 1)), 'body_too_large');
    expect(() => parseTelnyxWebhookBody(new Uint8Array(TELNYX_WEBHOOK_MAX_BYTES + 1))).toThrow('body_too_large');
  });

  it('measures bytes rather than JavaScript character count at the exact limit', async () => {
    const base = JSON.stringify({ ...fixture(), note: '☎' });
    const bytes = new TextEncoder().encode(base).byteLength;
    const raw = base + ' '.repeat(TELNYX_WEBHOOK_MAX_BYTES - bytes);
    await expect(verifyTelnyxWebhook(signed(raw), options)).resolves.toMatchObject({ rawBody: raw });
    await rejected(signed(raw + ' '), 'body_too_large');
  });

  it.each([null, '', 'text/plain', 'application/json; charset=latin1', 'application/json, text/plain'])('rejects content type %j', async contentType => {
    await rejected({ ...signed(), contentType }, 'invalid_content_type');
  });

  it.each(['application/json', 'Application/JSON; charset=UTF-8', 'application/json; charset="utf-8"'])('accepts JSON UTF-8 content type %j', async contentType => {
    await expect(verifyTelnyxWebhook({ ...signed(), contentType }, options)).resolves.toMatchObject({ eventType: 'call.initiated' });
  });

  it('rejects correctly signed invalid UTF-8 rather than normalizing it', async () => {
    await rejected(signed(new Uint8Array([0x7b, 0xff, 0x7d])), 'invalid_payload');
  });

  it.each(['', '{', 'null', '[]', '{}', '{"data":[]}', '{"data":{"record_type":"event"}}'])('rejects invalid JSON/envelope %j', async raw => {
    await rejected(signed(raw), 'invalid_payload');
  });

  it.each(['2026-02-30T00:00:00Z', '2026-09-12', '2026-09-12T00:00:00', '2026-09-12T24:00:00Z', '2026-09-12T00:00:00+25:00'])('rejects malformed event timestamp %j', async occurred_at => {
    const body = fixture(); body.data.occurred_at = occurred_at;
    await rejected(signed(JSON.stringify(body)), 'invalid_payload');
  });

  it.each(['call_control_id', 'connection_id', 'call_leg_id', 'call_session_id'])('requires a valid call correlation field %s', async field => {
    for (const invalid of [undefined, null, '', '  ', 123, ['id'], { id: 'value' }]) {
      const body = fixture(); (body.data.payload as Record<string, unknown>)[field] = invalid;
      await rejected(signed(JSON.stringify(body)), 'invalid_payload');
    }
  });

  it.each(['call.answered', 'call.hangup', 'streaming.started', 'streaming.stopped', 'streaming.failed'])('retains call correlation for %s', async eventType => {
    const body = fixture(); body.data.event_type = eventType;
    await expect(verifyTelnyxWebhook(signed(JSON.stringify(body)), options)).resolves.toMatchObject({ eventType, call: { connectionId: body.data.payload.connection_id } });
  });

  it('parses unknown authenticated events without inventing a call correlation', async () => {
    const body = { data: { ...fixture().data, event_type: 'message.received', payload: { message_id: 'synthetic' } } };
    await expect(verifyTelnyxWebhook(signed(JSON.stringify(body)), options)).resolves.toMatchObject({ eventType: 'message.received', call: null });
  });

  it('treats event IDs as bounded opaque identifiers', async () => {
    for (const id of ['', 'line\nbreak', 'x'.repeat(257)]) {
      const body = fixture(); body.data.id = id;
      await rejected(signed(JSON.stringify(body)), 'invalid_payload');
    }
  });
});
