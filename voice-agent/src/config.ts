import type {CallContext} from './control.js';
export const INFERENCE = Object.freeze({model: 'gpt-live-1', delegationModel: 'gpt-5.4-mini', baseURL: 'https://api.kataleptic.com/v1', sampleRate: 24000, maxOutputTokens: 512});
const voices = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar', 'arbor', 'breeze', 'cove', 'ember', 'juniper', 'maple', 'sol', 'spruce', 'vale']);
export function modelOptions(context: CallContext, apiKey: string) {
  if (!apiKey || !voices.has(context.voice)) throw new Error('Incompatible call configuration');
  return {model: INFERENCE.model, baseURL: INFERENCE.baseURL, apiKey, voice: context.voice,
    responsesOptions: {model: INFERENCE.delegationModel, maxOutputTokens: INFERENCE.maxOutputTokens,
      instructions: `Use only the admitted business facts and instructions below. Do not claim a booking is confirmed. When the caller clearly ends the conversation and no request needs clarification, call end_call. This tool schedules a brief spoken goodbye and waits for it to play before disconnecting; do not wait for an earlier goodbye or merely return goodbye text. Otherwise answer briefly.\n\n${context.instructions}`},
  };
}
export function acceptedEcho(value: unknown, voice: string): boolean {
  const echo = value as {model?: string; audio?: {format?: {type?: string; rate?: number}; output?: {voice?: unknown}}; delegation?: {responses?: {model?: string}}} | null;
  return echo?.model === INFERENCE.model && echo.audio?.format?.type === 'audio/pcm' && echo.audio.format.rate === INFERENCE.sampleRate &&
    echo.audio.output?.voice === voice && echo.delegation?.responses?.model === INFERENCE.delegationModel;
}
