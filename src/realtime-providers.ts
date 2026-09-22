import type { AgentSettings, Env } from './types';
import { LlmConfigError, validateLlmBaseUrl } from './providers';

export type RealtimeProvider = 'kataleptic' | 'openai' | 'custom';
export interface RealtimeSettings {
  realtime_provider?: 'instance' | RealtimeProvider;
  realtime_base_url?: string;
  realtime_api_key?: string;
}
export interface RealtimeConfig {
  provider: RealtimeProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: 'gateway' | 'openai';
  /** The retired selection replaced by `model`; its voice belonged to that tier. */
  retiredModel?: string;
}
export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';
export const KATALEPTIC_HD_MODEL = 'kataleptic-realtime-hd';

// Kataleptic retired its cascade tier (`kataleptic-realtime`, or a chat model
// id on /v1/realtime) with its self-hosted models: those return `model_retired`.
// Only Azure Voice Live (HD) and the native speech-to-speech tiers remain there.
// Another gateway speaking the same protocol keeps its own models.
const KATALEPTIC_HOST = 'api.kataleptic.com';
export function gatewayRealtimeModel(model: string): boolean {
  return model === KATALEPTIC_HD_MODEL || model.startsWith('gpt-realtime');
}
function katalepticGateway(config: Pick<RealtimeConfig, 'protocol' | 'baseUrl'>): boolean {
  return config.protocol === 'gateway' && new URL(config.baseUrl).hostname === KATALEPTIC_HOST;
}

// Explicit workspace providers never borrow an operator credential. The instance
// option alone preserves the legacy gateway URL/key/model defaults.
export function resolveRealtime(env: Env & { REALTIME_PROVIDER?: RealtimeProvider }, settings: (AgentSettings & RealtimeSettings) | null): RealtimeConfig {
  const selection = settings?.realtime_provider || 'instance';
  const instance = selection === 'instance';
  const provider = instance ? env.REALTIME_PROVIDER || 'kataleptic' : selection;
  if (!['kataleptic', 'openai', 'custom'].includes(provider)) throw new LlmConfigError('Unsupported realtime provider.');
  const protocol = provider === 'kataleptic' ? 'gateway' : 'openai';
  const baseUrl = instance ? env.REALTIME_BASE_URL : settings?.realtime_base_url?.trim() ||
    (provider === 'openai' ? OPENAI_REALTIME_URL : provider === 'kataleptic' ? 'wss://api.kataleptic.com/v1/realtime' : '');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new LlmConfigError('Realtime endpoint must be an absolute WebSocket URL.'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new LlmConfigError('Realtime endpoint must use ws(s) without embedded credentials or fragments.');
  }
  if (!instance) {
    const rejected = validateLlmBaseUrl(baseUrl.replace(/^ws/, 'http'), env.ALLOW_INSECURE_LLM_URL === 'true');
    if (rejected) throw new LlmConfigError(`Realtime endpoint ${rejected}`);
  }
  if (provider === 'openai' && url.href !== OPENAI_REALTIME_URL) {
    throw new LlmConfigError('OpenAI realtime requires wss://api.openai.com/v1/realtime.');
  }
  if (!instance && url.search) throw new LlmConfigError('Realtime endpoint must not include query parameters.');
  const apiKey = instance ? env.REALTIME_API_KEY || (protocol === 'gateway' ? env.DEFAULT_LLM_API_KEY : '') || '' : settings?.realtime_api_key || '';
  if (!instance && !apiKey) throw new LlmConfigError('This realtime provider needs its own API key.');
  if (protocol === 'openai' && !apiKey) throw new LlmConfigError('OpenAI realtime requires a realtime API key.');
  const model = settings?.realtime_model || (instance ? env.REALTIME_MODEL : protocol === 'openai' ? 'gpt-realtime' : KATALEPTIC_HD_MODEL);
  // A stored cascade selection would fail every call. Serve the HD tier instead;
  // migration 0024 rewrites the stored rows, this covers anything it missed.
  if (katalepticGateway({ protocol, baseUrl }) && !gatewayRealtimeModel(model)) {
    return { provider, baseUrl, apiKey, model: KATALEPTIC_HD_MODEL, protocol, retiredModel: model };
  }
  if (provider === 'openai' && !/^gpt-(realtime|4o.*realtime)/.test(model)) {
    throw new LlmConfigError('Choose an OpenAI realtime model for the OpenAI provider.');
  }
  return { provider, baseUrl, apiKey, model, protocol };
}

// Piper voice ids (`de_DE-thorsten-medium`) belonged to the retired cascade; no
// Kataleptic tier accepts them now. Azure names use a hyphen (`de-DE-…`).
const PIPER_VOICE = /^[a-z]{2}_[A-Z]{2}-/;
/** The explicit voice to request, or '' when it belongs to a retired tier. */
export function liveRealtimeVoice(config: RealtimeConfig, voice: string): string {
  return config.retiredModel || (katalepticGateway(config) && PIPER_VOICE.test(voice)) ? '' : voice;
}

export function realtimeConnection(config: RealtimeConfig): { url: string; headers?: Record<string, string> } {
  const url = new URL(config.baseUrl);
  url.searchParams.set('model', config.model);
  if (config.protocol === 'gateway') {
    // Instance endpoints may contain legacy credential query aliases.
    url.searchParams.delete('token');
    url.searchParams.delete('api_key');
  }
  // Workers fetch Upgrade supports server-side Authorization; never put a
  // durable configured API key in URL query parameters or browser subprotocols.
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return { url: url.href, headers: { Upgrade: 'websocket', Authorization: `Bearer ${config.apiKey}` } };
}

export function realtimeCapabilities(config: RealtimeConfig) {
  const native = config.protocol === 'openai';
  return {
    engineGreeting: native || config.model.startsWith('gpt-realtime'),
    managedVoice: !native && config.model === KATALEPTIC_HD_MODEL,
    transcriptionModel: native || config.model.startsWith('gpt-realtime') ? 'whisper-1' : null,
  };
}

/** Eligibility only; CallSession revalidates the selected configuration at pickup. */
export function telephoneRealtimeAvailable(env: Env, settings: (AgentSettings & RealtimeSettings) | null): boolean {
  try {
    if (settings?.engine !== 'realtime') return false;
    const config = resolveRealtime(env, settings);
    return Boolean(config.apiKey && (realtimeCapabilities(config).engineGreeting ||
      (env.DEFAULT_TTS_PROVIDER === 'azure' && env.AZURE_SPEECH_KEY)));
  } catch { return false; }
}
