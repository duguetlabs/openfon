// Chat/STT responses are small JSON documents. Bound the decoded HTTP body,
// regardless of absent, compressed or dishonest Content-Length headers.
export const MAX_PROVIDER_JSON_BYTES = 64 * 1024;
export const MAX_PROVIDER_READS = MAX_PROVIDER_JSON_BYTES + 1; // one-byte fragments plus EOF
export const PROVIDER_RESPONSE_TIMEOUT_MS = 15_000;

export class ProviderResponseError extends Error {
  constructor() { super('Provider response unavailable, invalid, too large, or timed out'); }
}

export async function fetchProviderJson(url: string, init: RequestInit, timeoutMs = PROVIDER_RESPONSE_TIMEOUT_MS): Promise<{ response: Response; data: unknown }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000 || init.signal?.aborted) throw new ProviderResponseError();
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  const cancel = (body = response?.body) => {
    // A malicious stream's cancellation promise may never settle. Initiate
    // cancellation, but never await it as part of enforcing the deadline.
    try { void (reader ? reader.cancel() : body?.cancel())?.catch(() => {}); } catch { /* already closed */ }
  };
  const expiresAt = Date.now() + timeoutMs;
  let abortRequest: () => void = () => {};
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    abortRequest = () => { controller.abort(); cancel(); reject(new ProviderResponseError()); };
    timer = setTimeout(abortRequest, timeoutMs);
    init.signal?.addEventListener('abort', abortRequest, { once: true });
  });
  const checkDeadline = () => {
    if (finished || controller.signal.aborted || Date.now() >= expiresAt) {
      cancel(); throw new ProviderResponseError();
    }
  };
  const operation = async () => {
    response = await fetch(url, { ...init, signal: controller.signal });
    // Also disposes headers delivered by a non-cooperative fetch after timeout.
    checkDeadline();
    // Status handling belongs to the caller; preserve its actionable hints.
    // Never consume an error/redirect body, which may reflect credentials.
    if (!response.ok) { cancel(); return { response, data: undefined }; }
    if (!response.body || Number(response.headers.get('content-length')) > MAX_PROVIDER_JSON_BYTES) throw new ProviderResponseError();
    reader = response.body.getReader();
    const bytes = new Uint8Array(MAX_PROVIDER_JSON_BYTES);
    let size = 0, reads = 0;
    for (;;) {
      // Empty chunks consume no byte budget. Bound read work too, including a
      // synchronous empty-chunk producer that could otherwise starve timers.
      if (++reads > MAX_PROVIDER_READS) throw new ProviderResponseError();
      const { value, done } = await reader.read();
      checkDeadline();
      if (done) break;
      if (value.byteLength > MAX_PROVIDER_JSON_BYTES - size) throw new ProviderResponseError();
      bytes.set(value, size); size += value.byteLength;
    }
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
    return { response, data };
  };
  try {
    // One deadline reaction for the whole operation, not one retained reaction
    // for every fragment read from an adversarial response stream.
    return await Promise.race([operation(), deadline]);
  } catch {
    cancel();
    // JSON syntax, network and stream errors can contain provider-controlled
    // text, URLs or secrets. Expose only a locally composed fixed message.
    throw new ProviderResponseError();
  } finally {
    finished = true; clearTimeout(timer); controller.abort();
    init.signal?.removeEventListener('abort', abortRequest);
    try { reader?.releaseLock(); } catch { /* cancelled read */ }
  }
}
