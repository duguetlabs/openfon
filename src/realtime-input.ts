// WebSocket delivery already materializes the transport message. Bound further
// parsing/decoding allocations here, including the pre-ack handshake path.
export const MAX_REALTIME_JSON_BYTES = 1024 * 1024;
export const MAX_REALTIME_AUDIO_BYTES = 480000;
export const MAX_TRANSCRIPT_FIELD_BYTES = 8 * 1024;
export const MAX_CALL_TRANSCRIPT_BYTES = 256 * 1024;
export const MAX_REALTIME_AUDIO_BASE64 = MAX_REALTIME_AUDIO_BYTES / 3 * 4;

export class RealtimeInputError extends Error {
  constructor() { super('Invalid or oversized realtime provider message'); }
}
function invalid(): never { throw new RealtimeInputError(); }

function boundedUtf8(text: string, limit: number): number {
  if (text.length > limit) return -1;
  let bytes = 0;
  // Count UTF-8 without allocating a second encoded copy of untrusted input.
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes++;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3; // BMP or replacement encoding of an unpaired surrogate
    if (bytes > limit) return -1;
  }
  return bytes;
}

export function parseRealtimeMessage(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || boundedUtf8(raw, MAX_REALTIME_JSON_BYTES) < 0) invalid();
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { invalid(); }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) invalid();
  const event = msg as Record<string, unknown>;
  if (event.type === 'response.output_audio.delta' &&
    (typeof event.delta !== 'string' || event.delta.length > MAX_REALTIME_AUDIO_BASE64)) invalid();
  if ((event.type === 'conversation.item.input_audio_transcription.completed' ||
    event.type === 'response.output_audio_transcript.done') && event.transcript !== undefined) {
    transcriptBytes(event.transcript);
  }
  return event;
}

export function transcriptBytes(text: unknown): number {
  if (typeof text !== 'string') invalid();
  const bytes = boundedUtf8(text, MAX_TRANSCRIPT_FIELD_BYTES);
  if (bytes < 0) invalid();
  return bytes;
}

export function decodeRealtimeAudio(encoded: string): ArrayBuffer {
  // Bound before atob's binary string AND before allocating its output buffer.
  // Whitespace/padding only reduce decoded size; unpadded base64 still fits.
  if (typeof encoded !== 'string' || encoded.length > MAX_REALTIME_AUDIO_BASE64) invalid();
  let binary: string;
  try { binary = atob(encoded); } catch { invalid(); }
  if (binary.length > MAX_REALTIME_AUDIO_BYTES) invalid();
  const output = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) output[i] = binary.charCodeAt(i);
  return output.buffer;
}
