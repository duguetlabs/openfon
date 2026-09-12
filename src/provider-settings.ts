import type { Env, ProviderSettings } from './types';
import { sameLlmEndpoint, validateLlmBaseUrl } from './providers';

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
    const credential = key(keyField, `${capability}_clear_api_key`, current?.[keyField] ?? '', oldIdentity, newIdentity);
    if (provider !== 'instance') {
      if (capability === 'realtime' && !url.startsWith('wss://')) throw new ProviderInputError('Realtime URL must use wss://');
      const bad = validateLlmBaseUrl(capability === 'realtime' ? url.replace(/^wss:/, 'https:') : url);
      if (bad) throw new ProviderInputError(`${capability} URL ${bad}`);
      if (!credential) throw new ProviderInputError(`${capability} provider needs its own API key; instance keys are never inherited.`);
    }
    Object.assign(result, { [providerField]: provider, [urlField]: url, [keyField]: credential });
  }
  result.stt_model = str('stt_model', current?.stt_model ?? '', 256);
  if (result.stt_provider !== 'instance' && !result.stt_model) throw new ProviderInputError('STT model is required (for OpenAI, use whisper-1).');
  return result;
}
