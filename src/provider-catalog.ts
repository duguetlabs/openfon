import { fetchProviderJson } from './provider-response';
import { OPENAI_REALTIME_VOICES } from './provider-settings';

type Option = { id: string; label: string };
type Model = Option & { kind: 'text' | 'transcription' | 'realtime' };
const options = (ids: string[]): Option[] => ids.map(id => ({ id, label: id }));
const fallbackModels: Model[] = [
  ...['kataleptic-realtime', 'kataleptic-realtime-hd', 'gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini'].map(id => ({ id, label: id, kind: 'realtime' as const })),
  ...['llama-3.3-70b', 'mistral-nemo-12b'].map(id => ({ id, label: id, kind: 'text' as const })),
  ...['whisper-large-v3-turbo', 'gpt-4o-transcribe', 'gpt-transcribe', 'gpt-4o-transcribe-diarize'].map(id => ({ id, label: id, kind: 'transcription' as const })),
];
const fallback = () => ({ models: fallbackModels, live: false, voices: {
  native: options(OPENAI_REALTIME_VOICES),
  cascade: options(['en_US-lessac-medium', 'de_DE-thorsten-medium', 'fr_FR-siwis-medium', 'es_ES-sharvard-medium', 'it_IT-paola-medium', 'nl_NL-mls-medium', 'sv_SE-nst-medium', 'da_DK-talesyntese-medium', 'fi_FI-harri-medium', 'ru_RU-irina-medium']),
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
        if (!validId(m.id) || m.id.includes('/') || seen.has(m.id)) continue;
        const inputs = m.architecture?.input_modalities, outputs = m.architecture?.output_modalities;
        if (!Array.isArray(inputs) || !Array.isArray(outputs)) continue;
        const kind = m.id.includes('realtime') ? 'realtime' : inputs.includes('audio') && outputs.includes('text') && !m.id.endsWith('-stream')
          ? 'transcription' : inputs.includes('text') && outputs.includes('text') && !outputs.includes('audio') ? 'text' : null;
        if (!kind) continue;
        seen.add(m.id); parsed.push({ id: m.id, label: typeof m.name === 'string' && m.name.length <= 256 ? m.name : m.id, kind });
      }
      if (parsed.length) { result.models = parsed; result.live = true; }
      if (voices.response.ok && voices.data && typeof voices.data === 'object') {
        const v = voices.data as Record<string, { voices?: unknown[]; voices_by_language?: Record<string, unknown> }>;
        const native = v['gpt-realtime-2']?.voices;
        const cascade = v['kataleptic-realtime']?.voices_by_language;
        if (Array.isArray(native) && native.length <= 64) result.voices.native = options(native.filter(validId));
        if (cascade && typeof cascade === 'object' && Object.keys(cascade).length <= 64) result.voices.cascade = options(Object.values(cascade).filter(validId));
      }
    } catch { /* a useful, explicitly labelled offline catalog remains available */ }
    cached = { data: result, until: Date.now() + (result.live ? 3600000 : 60000) };
    return result;
  })().finally(() => { pending = undefined; });
  return pending;
}
