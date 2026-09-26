import { fetchProviderJson } from './provider-response';
import { OPENAI_REALTIME_VOICES } from './provider-settings';
import { RETIRED_KATALEPTIC_CHAT_MODELS } from './providers';
import { GPT_LIVE_MODEL, isGptLiveModel } from './realtime-providers';

type Option = { id: string; label: string };
type Model = Option & { kind: 'text' | 'transcription' | 'realtime' };
const options = (ids: string[]): Option[] => ids.map(id => ({ id, label: id }));
const fallbackModels: Model[] = [
  ...['kataleptic-realtime-hd', 'gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini', GPT_LIVE_MODEL].map(id => ({ id, label: id, kind: 'realtime' as const })),
  ...['llama-3.3-70b', 'gpt-5.4-mini'].map(id => ({ id, label: id, kind: 'text' as const })),
  ...['gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-transcribe-diarize'].map(id => ({ id, label: id, kind: 'transcription' as const })),
];
// Kataleptic retired its self-hosted models; until the gateway stops listing
// them they would still be offered here, and every call to them fails.
const RETIRED = new Set(['kataleptic-realtime', 'piper-tts', 'whisper-large-v3-turbo', 'whisper-large-v3-turbo-stream',
  'parakeet-tdt-0-6b-stream', 'nomic-embed', ...RETIRED_KATALEPTIC_CHAT_MODELS]);
const fallback = () => ({ models: fallbackModels, live: false, voices: {
  native: options(OPENAI_REALTIME_VOICES),
  azure: options(['en-US-AvaMultilingualNeural', 'de-DE-SeraphinaMultilingualNeural', 'es-ES-ArabellaMultilingualNeural', 'fr-FR-VivienneMultilingualNeural', 'it-IT-AlessioMultilingualNeural']),
  hdDefault: 'en-US-AvaMultilingualNeural',
} });
type Catalog = ReturnType<typeof fallback>;
let cached: { until: number; data: Catalog } | undefined;
let pending: Promise<Catalog> | undefined;
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && /^[a-zA-Z0-9_.:/-]+$/.test(v);
// Only the public Kataleptic catalogs are contacted. No workspace keys, custom
// hosts, redirects or provider-controlled links participate in discovery.
export function providerCatalog(): Promise<Catalog> {
  if (cached && Date.now() < cached.until) return Promise.resolve(cached.data);
  if (pending) return pending;
  pending = (async () => {
    const result = fallback();
    try {
      const [models, voices] = await Promise.all([
        fetchProviderJson('https://api.kataleptic.com/v1/models', { redirect: 'manual' }, 4000, 512 * 1024),
        fetchProviderJson('https://api.kataleptic.com/v1/realtime/voices', { redirect: 'manual' }, 4000),
      ]);
      const items = (models.data as { data?: unknown[] })?.data;
      if (!models.response.ok || !Array.isArray(items) || items.length > 512) throw Error('catalog unavailable');
      const seen = new Set<string>(); const parsed: Model[] = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const m = item as { id?: unknown; name?: unknown; architecture?: { input_modalities?: string[]; output_modalities?: string[] } };
        if (!validId(m.id) || m.id.includes('/') || seen.has(m.id) || RETIRED.has(m.id)) continue;
        const inputs = m.architecture?.input_modalities, outputs = m.architecture?.output_modalities;
        if (!Array.isArray(inputs) || !Array.isArray(outputs)) continue;
        const kind = m.id.includes('realtime') || isGptLiveModel(m.id) ? 'realtime' : inputs.includes('audio') && outputs.includes('text') && !m.id.endsWith('-stream')
          ? 'transcription' : inputs.includes('text') && outputs.includes('text') && !outputs.includes('audio') ? 'text' : null;
        if (!kind) continue;
        seen.add(m.id); parsed.push({ id: m.id, label: typeof m.name === 'string' && m.name.length <= 256 ? m.name : m.id, kind });
      }
      if (parsed.length) { result.models = parsed; result.live = true; }
      if (voices.response.ok && voices.data && typeof voices.data === 'object') {
        const v = voices.data as Record<string, { voices?: unknown[] }>;
        const native = v['gpt-realtime-2']?.voices;
        if (Array.isArray(native) && native.length <= 64) result.voices.native = options(native.filter(validId));
      }
    } catch { /* a useful, explicitly labelled offline catalog remains available */ }
    cached = { data: result, until: Date.now() + (result.live ? 3600000 : 60000) };
    return result;
  })().finally(() => { pending = undefined; });
  return pending;
}
