export * from './types';
export * from './api';
export { RehearsalController } from './rehearsal';
export { supportedLanguages, voiceChoicesFor } from './voice-options';
// These audited modules implement protocols only and have no React/CSS imports.
export { VoiceCall } from '../voice';
export type { VoiceEvent } from '../voice';
export { parseAssistantRecipe, exportAssistantRecipe, assistantRecipePatch, ASSISTANT_RECIPE_MAX_BYTES } from '../assistant-config';
export type { AssistantRecipe } from '../assistant-config';

export interface CallbackMessage { caller_name: string | null; caller_phone: string | null; message: string | null }
export function callbackMessage(raw: string | null): CallbackMessage | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const text = (key: string) => typeof record[key] === 'string' && (record[key] as string).trim() ? (record[key] as string).trim() : null;
    return { caller_name: text('caller_name'), caller_phone: text('caller_phone'), message: text('message') };
  } catch { return null; }
}
/** SQLite timestamps are UTC even though they omit an offset. */
export function callDate(raw: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw);
}
