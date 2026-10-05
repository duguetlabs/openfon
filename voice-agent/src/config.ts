import type {CallContext} from './control.js';
export const INFERENCE = Object.freeze({model: 'gpt-live-1', delegationModel: 'gpt-5.4-mini', sampleRate: 24000, maxOutputTokens: 512});
const voices = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar', 'arbor', 'breeze', 'cove', 'ember', 'juniper', 'maple', 'sol', 'spruce', 'vale']);
export function operatorAzureConfig(env:NodeJS.ProcessEnv=process.env){
  const endpoint=new URL(env.AZURE_OPENAI_ENDPOINT||'');
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.port||endpoint.pathname!=='/'||
    !/^([a-z0-9-]+)\.(cognitiveservices\.azure\.com|openai\.azure\.com)$/.test(endpoint.hostname)||!env.AZURE_OPENAI_API_KEY)
    throw new Error('Invalid operator Azure configuration');
  if(env.AZURE_OPENAI_LIVE_DEPLOYMENT&&env.AZURE_OPENAI_LIVE_DEPLOYMENT!==INFERENCE.model)throw new Error('Unsupported operator voice deployment');
  if(env.AZURE_OPENAI_TEXT_DEPLOYMENT&&env.AZURE_OPENAI_TEXT_DEPLOYMENT!==INFERENCE.delegationModel)throw new Error('Unsupported operator reasoning deployment');
  return {baseURL:endpoint.origin+'/openai/v1',apiKey:env.AZURE_OPENAI_API_KEY,apiKeyHeader:'api-key' as const};
}
export function modelOptions(context: CallContext, connection:ReturnType<typeof operatorAzureConfig>) {
  const {apiKey}=connection;
  if (!apiKey || !voices.has(context.voice)) throw new Error('Incompatible call configuration');
  return {model: INFERENCE.model, ...connection, voice: context.voice,
    responsesOptions: {model: INFERENCE.delegationModel, maxOutputTokens: INFERENCE.maxOutputTokens,
      instructions: `Use only the admitted business facts and instructions below. Do not claim a booking is confirmed. When the caller clearly ends the conversation and no request needs clarification, call end_call. This tool schedules a brief spoken goodbye and waits for it to play before disconnecting; do not wait for an earlier goodbye or merely return goodbye text. Otherwise answer briefly.\n\n${context.instructions}`},
  };
}
export function acceptedEcho(value: unknown, voice: string): boolean {
  const echo = value as {model?: string; audio?: {format?: {type?: string; rate?: number}; output?: {voice?: unknown}}; delegation?: {responses?: {model?: string}}} | null;
  return echo?.model === INFERENCE.model && echo.audio?.format?.type === 'audio/pcm' && echo.audio.format.rate === INFERENCE.sampleRate &&
    echo.audio.output?.voice === voice && echo.delegation?.responses?.model === INFERENCE.delegationModel;
}
