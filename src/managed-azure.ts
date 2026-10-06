import type { AgentSettings, Env } from './types';
/** Operator-only connection. Customer profiles never determine destinations or credentials. */
export function managedWeb(env: Pick<Env, 'OPENFON_MANAGED_WEB'>): boolean {
  return env.OPENFON_MANAGED_WEB === 'true';
}
export const MANAGED_VOICES = Object.freeze([
  'alloy',
  'arbor',
  'ash',
  'ballad',
  'breeze',
  'cedar',
  'coral',
  'cove',
  'echo',
  'ember',
  'juniper',
  'maple',
  'marin',
  'sage',
  'shimmer',
  'sol',
  'spruce',
  'vale',
  'verse',
]);
export const MINI_VOICES=Object.freeze(['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar']);
export const managedMini=(env?:Pick<Env,'AZURE_OPENAI_LIVE_DEPLOYMENT'>)=>env?.AZURE_OPENAI_LIVE_DEPLOYMENT==='gpt-realtime-2.1-mini';
export function managedVoiceCatalog(env?: Env) {
  return {
    voices: (managedMini(env)?MINI_VOICES:MANAGED_VOICES).map((id) => ({
      id,
      label: id[0]!.toUpperCase() + id.slice(1),
    })),
    defaultVoice: 'marin',
  };
}
export function managedVoice(value: string,env?:Env): string {
  const selected = value;
  if (!(managedMini(env)?MINI_VOICES:MANAGED_VOICES).includes(selected))
    throw new Error('Choose an available voice before calling.');
  return selected;
}
/** Preserve the released saved default without accepting blank customer input. */
export function savedManagedVoice(
  settings: Pick<AgentSettings, 'realtime_voice' | 'voice'>, env?:Env
): string {
  return managedVoice(settings.realtime_voice || settings.voice || 'marin',env);
}
export function azureConfig(
  env: Pick<
    Env,
    | 'AZURE_OPENAI_ENDPOINT'
    | 'AZURE_OPENAI_API_KEY'
    | 'AZURE_OPENAI_LIVE_DEPLOYMENT'
    | 'AZURE_OPENAI_TEXT_DEPLOYMENT'
  >
) {
  let endpoint: URL;
  try {
    endpoint = new URL(env.AZURE_OPENAI_ENDPOINT || '');
  } catch {
    throw new Error('Calling is not available yet. Please try again later.');
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.port ||
    !/^([a-z0-9-]+)\.(cognitiveservices\.azure\.com|openai\.azure\.com)$/.test(
      endpoint.hostname
    ) ||
    endpoint.pathname !== '/' ||
    !env.AZURE_OPENAI_API_KEY
  )
    throw new Error('Calling is not available yet. Please try again later.');
  const live = env.AZURE_OPENAI_LIVE_DEPLOYMENT || 'gpt-live-1',
    text = env.AZURE_OPENAI_TEXT_DEPLOYMENT || 'gpt-5.4-mini';
  if (!['gpt-live-1','gpt-realtime-2.1-mini'].includes(live) || text !== 'gpt-5.4-mini')
    throw new Error('Calling is not available yet. Please try again later.');
  return {
    baseURL: endpoint.origin + '/openai/v1',
    apiKey: env.AZURE_OPENAI_API_KEY,
    liveModel: live,
    textModel: text,
  };
}
