// Public gateway voice catalogs have endpoint-scoped identity. No credentials or
// tenant-specific request headers participate in this unauthenticated lookup.
const TTL_MS = 3_600_000;
const MAX_ENDPOINTS = 32;
const MAX_BODY_BYTES = 65_536;
const MAX_VOICES = 64;
const catalogs = new Map<string, { voices: Record<string, string>; fetchedAt: number }>();

function catalogUrl(base: string): string {
  const url = new URL(base);
  if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid catalog endpoint');
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/+$/, '') + '/voices';
  // URL normalizes host casing/default ports. Keep path and query routing in
  // the identity; endpoints differing in those must never share a voice map.
  if (url.href.length > 4096) throw new Error('Catalog endpoint too long');
  return url.href;
}

async function readVoices(response: Response): Promise<Record<string, string>> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Catalog unavailable');
  }
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_BODY_BYTES) {
    await response.body.cancel();
    throw new Error('Catalog too large');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('Catalog too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const data = JSON.parse(new TextDecoder().decode(bytes));
  const voices = data?.['kataleptic-realtime']?.voices_by_language;
  if (!voices || typeof voices !== 'object' || Array.isArray(voices)) throw new Error('Invalid voice map');
  const entries = Object.entries(voices);
  if (entries.length > MAX_VOICES) throw new Error('Too many voices');
  const valid: Record<string, string> = Object.create(null);
  for (const [lang, voice] of entries) {
    // Voice IDs are identifiers, not arbitrary prompt text, URLs, or objects.
    if (/^[a-z]{2}$/.test(lang) && typeof voice === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(voice)) valid[lang] = voice;
  }
  return valid;
}

export async function piperVoiceFromCatalog(base: string, lang: string, fallback: string): Promise<string> {
  try {
    const endpoint = catalogUrl(base);
    const cached = catalogs.get(endpoint);
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
      // LRU bounds isolate memory even when many workspaces use unique hosts.
      catalogs.delete(endpoint); catalogs.set(endpoint, cached);
      return cached.voices[lang] ?? fallback;
    }
    catalogs.delete(endpoint);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
    const voices = await readVoices(response);
    if (catalogs.size >= MAX_ENDPOINTS) catalogs.delete(catalogs.keys().next().value!);
    catalogs.set(endpoint, { voices, fetchedAt: Date.now() });
    return voices[lang] ?? fallback;
  } catch {
    // Never use another endpoint's entry or expired data after a failed lookup.
    return fallback;
  }
}
