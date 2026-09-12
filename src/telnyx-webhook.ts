/**
 * Isolated Telnyx V2 webhook validation; this module registers no carrier routes.
 * Official contracts checked 2026-09-12:
 * https://developers.telnyx.com/api-reference/callbacks/call-initiated
 * https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks
 * Signature: Ed25519 over the literal timestamp header, '|', and original bytes.
 */
export const TELNYX_WEBHOOK_MAX_BYTES = 128 * 1024;
export const TELNYX_WEBHOOK_MAX_SKEW_SECONDS = 300;

export type TelnyxWebhookErrorCode =
  | 'invalid_configuration' | 'body_too_large' | 'invalid_content_type'
  | 'invalid_headers' | 'timestamp_out_of_range' | 'invalid_signature' | 'invalid_payload';

export class TelnyxWebhookError extends Error {
  constructor(public readonly code: TelnyxWebhookErrorCode) {
    // Deliberately omit bodies, control tokens, headers, and provider key values.
    super(`Telnyx webhook rejected: ${code}`);
    this.name = 'TelnyxWebhookError';
  }
}

export interface TelnyxWebhookInput {
  /** Original HTTP entity bytes, before JSON parsing or any reserialization. */
  readonly body: Uint8Array;
  readonly contentType: string | null;
  readonly signature: string | null;
  readonly timestamp: string | null;
}

export interface TelnyxWebhookVerificationOptions {
  /** Base64-encoded, raw 32-byte account public key from Mission Control. */
  readonly publicKey: string;
  /** Explicit captured Unix time in seconds; keeps replay checks deterministic. */
  readonly nowSeconds: number;
  /** Inclusive past/future window; defaults to 300 seconds. Cannot disable checks. */
  readonly maxSkewSeconds?: number;
}

export interface TelnyxCallCorrelation {
  /** A sensitive carrier command capability. Never expose in public DTOs or logs. */
  readonly callControlId: string;
  readonly callLegId: string;
  readonly callSessionId: string;
  readonly connectionId: string;
}

export interface ParsedTelnyxEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  /** Null for non-call events; consumers must still allowlist supported event types. */
  readonly call: Readonly<TelnyxCallCorrelation> | null;
  /** Signed but otherwise untrusted event-specific data; never execute its URLs. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Exact UTF-8 text that was verified, preserving whitespace and key ordering. */
  readonly rawBody: string;
}

declare const verifiedTelnyxEvent: unique symbol;
export interface VerifiedTelnyxEvent extends ParsedTelnyxEvent {
  readonly signedAtSeconds: number;
  readonly [verifiedTelnyxEvent]: true;
}

function fail(code: TelnyxWebhookErrorCode): never {
  throw new TelnyxWebhookError(code);
}

function decodeBase64(value: string, length: number, code: TelnyxWebhookErrorCode): Uint8Array {
  // Accept canonical standard Base64 with or without padding, but no whitespace,
  // Base64URL translation, combined headers, or silently ignored invalid bytes.
  const encodedLength = Math.ceil(length / 3) * 4;
  if (typeof value !== 'string' || value.length > encodedLength || value.length < encodedLength - 2 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(code);
  let decoded: string;
  try { decoded = atob(value); } catch { fail(code); }
  if (decoded.length !== length || btoa(decoded).replace(/=+$/, '') !== value.replace(/=+$/, '')) fail(code);
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identifier(value: unknown, maxLength = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function validEventTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second, zone] = parts;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return m >= 1 && m <= 12 && d >= 1 && d <= monthDays[m - 1] &&
    Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 &&
    (zone === 'Z' || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59)) &&
    Number.isFinite(Date.parse(value));
}

/** Shape validation only. Its return type is intentionally not VerifiedTelnyxEvent. */
export function parseTelnyxWebhookBody(body: Uint8Array): ParsedTelnyxEvent {
  if (!(body instanceof Uint8Array) || body.byteLength === 0) fail('invalid_payload');
  if (body.byteLength > TELNYX_WEBHOOK_MAX_BYTES) fail('body_too_large');
  let rawBody: string;
  let envelope: unknown;
  try {
    // Fatal decoding rejects replacement-character normalization. Keeping BOMs
    // ensures we never silently alter the byte representation before parsing.
    rawBody = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    envelope = JSON.parse(rawBody);
  } catch { fail('invalid_payload'); }
  if (!object(envelope) || !object(envelope.data)) fail('invalid_payload');
  const data = envelope.data;
  if (data.record_type !== 'event' || !identifier(data.id) ||
      !identifier(data.event_type, 128) || !/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/.test(data.event_type) ||
      !validEventTime(data.occurred_at) || !object(data.payload)) fail('invalid_payload');
  const payload = data.payload;
  let call: TelnyxCallCorrelation | null = null;
  if (data.event_type.startsWith('call.') || data.event_type.startsWith('streaming.')) {
    if (!identifier(payload.call_control_id, 4096) || !identifier(payload.call_leg_id) ||
        !identifier(payload.call_session_id) || !identifier(payload.connection_id)) fail('invalid_payload');
    call = Object.freeze({
      callControlId: payload.call_control_id,
      callLegId: payload.call_leg_id,
      callSessionId: payload.call_session_id,
      connectionId: payload.connection_id,
    });
  }
  return Object.freeze({
    eventId: data.id, eventType: data.event_type, occurredAt: data.occurred_at,
    call, payload: Object.freeze(payload), rawBody,
  });
}

/**
 * Authenticates an already size-bounded HTTP entity, then parses its V2 envelope.
 * Integration must enforce the same limit while reading the request stream, not
 * trust Content-Length. No replay storage or durable deduplication happens here:
 * use eventId in a durable inbox, validate connectionId/routing, and allowlist
 * event types before any carrier action. Duplicates inside the time window pass.
 */
export async function verifyTelnyxWebhook(
  input: TelnyxWebhookInput,
  options: TelnyxWebhookVerificationOptions,
): Promise<VerifiedTelnyxEvent> {
  const maxSkew = options.maxSkewSeconds ?? TELNYX_WEBHOOK_MAX_SKEW_SECONDS;
  if (!Number.isSafeInteger(options.nowSeconds) || options.nowSeconds < 0 ||
      !Number.isSafeInteger(maxSkew) || maxSkew < 0 || maxSkew > 3600) fail('invalid_configuration');
  const publicKey = decodeBase64(options.publicKey, 32, 'invalid_configuration');
  if (!(input.body instanceof Uint8Array) || input.body.byteLength === 0) fail('invalid_payload');
  if (input.body.byteLength > TELNYX_WEBHOOK_MAX_BYTES) fail('body_too_large');
  if (typeof input.contentType !== 'string' ||
      !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(input.contentType)) {
    fail('invalid_content_type');
  }
  if (typeof input.timestamp !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(input.timestamp) ||
      typeof input.signature !== 'string') fail('invalid_headers');
  const signedAtSeconds = Number(input.timestamp);
  if (!Number.isSafeInteger(signedAtSeconds)) fail('invalid_headers');
  if (Math.abs(options.nowSeconds - signedAtSeconds) > maxSkew) fail('timestamp_out_of_range');
  const signature = decodeBase64(input.signature, 64, 'invalid_headers');

  // Snapshot all mutable bytes before the first await. Parsing cannot observe a
  // later caller mutation that was not covered by signature verification.
  const body = new Uint8Array(input.body);
  const prefix = new TextEncoder().encode(`${input.timestamp}|`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  let valid = false;
  try {
    const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, signed);
  } catch { fail('invalid_signature'); }
  if (!valid) fail('invalid_signature');
  return Object.freeze({ ...parseTelnyxWebhookBody(body), signedAtSeconds }) as VerifiedTelnyxEvent;
}
