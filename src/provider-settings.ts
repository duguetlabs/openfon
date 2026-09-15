import { resolveRealtime } from './realtime-providers';
import type { AgentSettings, Env, ProviderSettings } from './types';
import { LlmConfigError, sameLlmEndpoint, validateLlmBaseUrl } from './providers';

export const TEXT_PRESETS = [
  { id: 'instance', label: 'Instance default (Kataleptic by default)', baseUrl: '', model: '' },
  { id: 'kataleptic', label: 'Kataleptic', baseUrl: 'https://api.kataleptic.com/v1', model: 'llama-3.3-70b' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' },
  { id: 'huggingface', label: 'Hugging Face Inference Providers', baseUrl: 'https://router.huggingface.co/v1', model: 'openai/gpt-oss-120b' },
  { id: 'openai', label: 'OpenAI (direct)', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  { id: 'custom', label: 'Custom OpenAI-compatible', baseUrl: '', model: '' },
];
export const OPENAI_REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

export class ProviderInputError extends Error {}

// A retained write-only secret remains bound to the old endpoint. Explicit
// replacement is the owner's authorization to send a key to the new endpoint.
export function retainedProviderKey(oldUrl: string, newUrl: string, oldKey: string, replacement: string, clear: boolean): string {
  if (clear && replacement) throw new ProviderInputError('Choose either a replacement API key or clearApiKey');
  if (oldKey && !replacement && !clear && !sameLlmEndpoint(oldUrl, newUrl)) {
    throw new ProviderInputError('Endpoint changed. Enter a key for the new endpoint or explicitly remove the saved key.');
  }
  return clear ? '' : replacement || oldKey;
}

export function providerUpdate(env: Env, current: ProviderSettings | null, body: Record<string, unknown>): ProviderSettings {
  const str = (key: string, fallback: string, max = 2048): string => {
    if (body[key] === undefined) return fallback;
    if (typeof body[key] !== 'string' || (body[key] as string).length > max) throw new ProviderInputError(`${key} must be a string of at most ${max} characters`);
    return (body[key] as string).trim();
  };
  const key = (name: string, clearName: string, old: string, oldUrl: string, newUrl: string): string => {
    if (body[clearName] !== undefined && typeof body[clearName] !== 'boolean') throw new ProviderInputError(`${clearName} must be a boolean`);
    const replacement = body[name] === null ? '' : str(name, '', 4096);
    return retainedProviderKey(oldUrl, newUrl, old, replacement, body[clearName] === true || body[name] === null);
  };
  const result = { ...current } as ProviderSettings;
  result.llm_base_url = str('baseUrl', current?.llm_base_url ?? '');
  result.llm_model = str('model', current?.llm_model ?? '', 256);
  result.llm_api_key = key('apiKey', 'clearApiKey', current?.llm_api_key ?? '', current?.llm_base_url || env.DEFAULT_LLM_BASE_URL, result.llm_base_url || env.DEFAULT_LLM_BASE_URL);
  if (result.llm_base_url && !sameLlmEndpoint(result.llm_base_url, env.DEFAULT_LLM_BASE_URL)) {
    const bad = validateLlmBaseUrl(result.llm_base_url, env.ALLOW_INSECURE_LLM_URL === 'true');
    if (bad) throw new ProviderInputError(`LLM base URL ${bad}`);
    if (!result.llm_api_key) throw new ProviderInputError('A custom LLM base URL needs its own API key.');
  }
  for (const capability of ['realtime', 'stt'] as const) {
    const providerField = `${capability}_provider` as const;
    const urlField = `${capability}_base_url` as const;
    const keyField = `${capability}_api_key` as const;
    const provider = str(providerField, current?.[providerField] ?? 'instance');
    const allowed = capability === 'realtime' ? ['instance', 'kataleptic', 'openai', 'custom'] : ['instance', 'openai', 'custom'];
    if (!allowed.includes(provider)) throw new ProviderInputError(`Unsupported ${capability} provider`);
    const pinned = provider === 'openai' ? (capability === 'realtime' ? OPENAI_REALTIME_URL : 'https://api.openai.com/v1') : '';
    const url = str(urlField, pinned || current?.[urlField] || '');
    if (pinned && url !== pinned) throw new ProviderInputError(`${capability} OpenAI endpoint must be ${pinned}`);
    const oldIdentity = `${current?.[providerField] ?? 'instance'}:${current?.[urlField] ?? ''}`;
    const newIdentity = `${provider}:${url}`;
    // Instance mode uses only operator credentials. Never retain an ignored
    // workspace secret or resurrect one when later selecting an explicit provider.
    const oldKey = current?.[providerField] && current[providerField] !== 'instance' ? current[keyField] ?? '' : '';
    const credential = key(keyField, `${capability}_clear_api_key`, provider === 'instance' ? '' : oldKey, oldIdentity, newIdentity);
    if (provider === 'instance' && credential) {
      throw new ProviderInputError(`${capability} instance mode uses the operator key. Select an explicit provider to save a workspace API key.`);
    }
    if (provider !== 'instance') {
      const localRealtime = capability === 'realtime' && env.ALLOW_INSECURE_LLM_URL === 'true';
      if (capability === 'realtime' && !url.startsWith('wss://') && !(localRealtime && url.startsWith('ws://'))) {
        throw new ProviderInputError('Realtime URL must use wss:// (ws:// requires the operator insecure-local opt-in).');
      }
      const bad = validateLlmBaseUrl(capability === 'realtime' ? url.replace(/^ws/, 'http') : url, localRealtime);
      if (bad) throw new ProviderInputError(`${capability} URL ${bad}`);
      if (capability === 'realtime') {
        const endpoint = new URL(url);
        if (endpoint.search || endpoint.hash) {
          throw new ProviderInputError('Realtime URL must not include query parameters or fragments.');
        }
      }
      if (!credential) throw new ProviderInputError(`${capability} provider needs its own API key; instance keys are never inherited.`);
    }
    Object.assign(result, { [providerField]: provider, [urlField]: url, [keyField]: credential });
  }
  result.stt_model = str('stt_model', current?.stt_model ?? '', 256);
  if (result.stt_provider !== 'instance' && !result.stt_model) throw new ProviderInputError('STT model is required (for OpenAI, use whisper-1).');
  return result;
}

// Presets select engine fields, never provider credentials. Validate against the
// current workspace at application time; saved presets may predate a switch.
export function presetCompatibilityError(env: Env, provider: ProviderSettings | null,
  preset: { engine?: string; realtime_model?: string; realtime_voice?: string }): string | null {
  if (preset.engine !== 'realtime') return null;
  try {
    const config = resolveRealtime(env, { ...provider, ...preset } as AgentSettings);
    if (config.provider === 'openai') {
      if (config.model === 'gpt-realtime-2') return 'Preset uses a Kataleptic gateway model. Choose a direct OpenAI realtime model before applying it.';
      if (preset.realtime_voice && !OPENAI_REALTIME_VOICES.includes(preset.realtime_voice)) {
        return 'Preset voice is not supported by direct OpenAI. Choose an OpenAI voice or leave it blank before applying it.';
      }
    }
    return null;
  } catch (error) {
    if (error instanceof LlmConfigError) return `Cannot apply preset: ${error.message}`;
    throw error;
  }
}

// Draft configuration checks deliberately do not resolve endpoints or require keys.
// Custom adapters retain their own model/voice namespace; blanks use runtime defaults.
export function assistantCompatibilityError(env: Env, provider: ProviderSettings | null,
  settings: { engine?: string; realtime_model?: string; realtime_voice?: string }): string | null {
  if (settings.engine !== 'realtime') return null;
  const selection = provider?.realtime_provider || 'instance';
  const effectiveProvider = selection === 'instance' ? env.REALTIME_PROVIDER || 'kataleptic' : selection;
  if (effectiveProvider !== 'openai') return null;
  const model = settings.realtime_model;
  if (model && (model === 'gpt-realtime-2' || !/^gpt-(realtime|4o.*realtime)/.test(model))) {
    return 'Choose an OpenAI realtime model for the OpenAI provider, or leave it blank for the default.';
  }
  if (settings.realtime_voice && !OPENAI_REALTIME_VOICES.includes(settings.realtime_voice)) {
    return 'Choose a supported OpenAI realtime voice, or leave it blank for the default.';
  }
  return null;
}

// A provider switch and its cleanup are atomic. Pin the realtime configuration
// used by validation so a later batch cannot restore fields that switch removed.
export const CHECKED_REALTIME_PROVIDER_SQL = `
  EXISTS(SELECT 1 FROM provider_settings WHERE business_id=assistants.business_id)=?
  AND (SELECT realtime_provider FROM provider_settings WHERE business_id=assistants.business_id) IS ?
  AND (SELECT realtime_base_url FROM provider_settings WHERE business_id=assistants.business_id) IS ?
  AND (SELECT realtime_api_key FROM provider_settings WHERE business_id=assistants.business_id) IS ?`;
export function checkedRealtimeProvider(provider: ProviderSettings | null) {
  return [provider ? 1 : 0, provider?.realtime_provider ?? null,
    provider?.realtime_base_url ?? null, provider?.realtime_api_key ?? null];
}
