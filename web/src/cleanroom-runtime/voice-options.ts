import { GPT_LIVE_VOICES } from '../../../src/realtime-voices';
import { PREVIEW_TEXT } from '../../../src/voice-preview-text';
import type { AssistantFields, Option, Provider, ProviderCatalog } from './types';

const languageNames: Record<string, string> = { en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano', nl: 'Nederlands', sv: 'Svenska', da: 'Dansk', fi: 'Suomi', ru: 'Русский' };
/** Keep available choices within the server's actual sample/language contract. */
export const supportedLanguages: Option[] = Object.keys(PREVIEW_TEXT).map(id => ({ id, label: languageNames[id] || id }));
const options = (ids: readonly string[]): Option[] => ids.map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
const directRealtime = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const legacySpeech = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const modernSpeech = [...legacySpeech, 'ash', 'ballad', 'coral', 'sage', 'verse', 'marin', 'cedar'];
type VoiceProvider = Pick<Provider, 'managed_browser_voice' | 'effective_realtime_provider' | 'effective_realtime_model' | 'effective_tts_provider' | 'tts_model'>;

/** Suggestions are scoped to the transport and model; custom providers keep their own namespaces. */
export function voiceChoicesFor(assistant: Pick<AssistantFields, 'engine' | 'realtime_model'>, provider: VoiceProvider, catalog: ProviderCatalog | null): Option[] {
  if (provider.managed_browser_voice) return options(GPT_LIVE_VOICES);
  if (assistant.engine === 'realtime') {
    const model = assistant.realtime_model || provider.effective_realtime_model;
    if (provider.effective_realtime_provider === 'openai') return options(directRealtime);
    if (provider.effective_realtime_provider !== 'kataleptic') return [];
    if (model === 'kataleptic-realtime-hd') return catalog?.voices?.azure || options(['en-US-AvaMultilingualNeural', 'de-DE-SeraphinaMultilingualNeural']);
    return catalog?.voices?.realtime?.[model] || (model === 'gpt-live-1' ? options(GPT_LIVE_VOICES) : ['gpt-realtime-2','gpt-realtime-2.1','gpt-realtime-2.1-mini'].includes(model) ? options(directRealtime) : []);
  }
  if (provider.effective_tts_provider === 'azure') return catalog?.voices?.azure || options(['en-US-AvaMultilingualNeural', 'de-DE-SeraphinaMultilingualNeural']);
  if (provider.effective_tts_provider === 'openai') {
    return options(provider.tts_model === 'gpt-4o-mini-tts' ? modernSpeech : legacySpeech);
  }
  return [];
}
