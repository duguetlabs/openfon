import type { Assistant } from './types';

// Both assistant editors rebuild these fields from a captured row. Compare the
// original values at the write boundary rather than relying on timestamp precision.
// This covers handler-read-to-write races, not a client draft predating that read.
const ASSISTANT_WRITE_FIELDS = [
  'name', 'greeting', 'persona', 'language', 'voice', 'take_messages',
  'custom_instructions', 'engine', 'realtime_model', 'realtime_voice', 'llm_model', 'state',
] as const;

export const CHECKED_ASSISTANT_SNAPSHOT_SQL = ASSISTANT_WRITE_FIELDS
  .map(field => `assistants.${field} IS ?`).join(' AND ');

export function checkedAssistantSnapshot(assistant: Pick<Assistant, typeof ASSISTANT_WRITE_FIELDS[number]>) {
  return ASSISTANT_WRITE_FIELDS.map(field => assistant[field]);
}
