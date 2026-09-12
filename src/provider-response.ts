// Chat/STT responses are small JSON documents. Bound the decoded HTTP body,
// regardless of absent, compressed or dishonest Content-Length headers.
export const MAX_PROVIDER_JSON_BYTES = 64 * 1024;
export const PROVIDER_RESPONSE_TIMEOUT_MS = 15_000;

export class ProviderResponseError extends Error {
  constructor() { super('Provider response unavailable, invalid, too large, or timed out'); }
}

export async function fetchProviderJson(url: string, init: RequestInit): Promise<{ response: Response; data: unknown }> {
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  const cancel = (body = response?.body) => {
    // A malicious stream's cancellation promise may never settle. Initiate
    // cancellation, but never await it as part of enforcing the deadline.
    try { void (reader ? reader.cancel() : body?.cancel())?.catch(() => {}); } catch { /* already closed */ }
  };
  const expiresAt = Date.now() + PROVIDER_RESPONSE_TIMEOUT_MS;
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(); cancel(); reject(new ProviderResponseError());
    }, PROVIDER_RESPONSE_TIMEOUT_MS);
  });
  try {
    const pending = fetch(url, { ...init, signal: controller.signal });
    // Dispose even a non-cooperative fetch that delivers headers after timeout.
    void pending.then(late => { if (finished) cancel(late.body); }, () => {});
    response = await Promise.race([pending, deadline]);
    // Status handling belongs to the caller; preserve its actionable hints.
    // Never consume an error/redirect body, which may reflect credentials.
    if (!response.ok) { cancel(); return { response, data: undefined }; }
    if (!response.body || Number(response.headers.get('content-length')) > MAX_PROVIDER_JSON_BYTES) throw new ProviderResponseError();
    reader = response.body.getReader();
    const bytes = new Uint8Array(MAX_PROVIDER_JSON_BYTES);
    let size = 0;
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (Date.now() >= expiresAt) throw new ProviderResponseError();
      if (done) break;
      if (value.byteLength > MAX_PROVIDER_JSON_BYTES - size) throw new ProviderResponseError();
      bytes.set(value, size); size += value.byteLength;
    }
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
    return { response, data };
  } catch {
    cancel();
    // JSON syntax, network and stream errors can contain provider-controlled
    // text, URLs or secrets. Expose only a locally composed fixed message.
    throw new ProviderResponseError();
  } finally {
    finished = true; clearTimeout(timer); controller.abort();
    try { reader?.releaseLock(); } catch { /* cancelled read */ }
  }
}
