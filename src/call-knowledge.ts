import type { PromptKnowledgeItem } from './prompt';

export const KNOWLEDGE_ITEM_BYTES = 8 * 1024;
export const KNOWLEDGE_ROW_LIMIT = 32;
export const KNOWLEDGE_PROMPT_BYTES = 32 * 1024;
// Covers all three section headings, empty-section placeholders and separators.
const SECTION_ALLOWANCE = 256;
// Current prompt rendering adds at most 8 UTF-8 bytes per item. Reserve 32
// so separators/punctuation fit even when all three knowledge kinds are mixed.
const ITEM_ALLOWANCE = 32;
const fields = ['kind', 'title', 'question', 'answer', 'content'] as const;

// CAST AS BLOB measures UTF-8 bytes (including embedded NULs), not characters.
// Both bounds run inside SQLite, BEFORE .all() materializes a D1 response.
// The selected field payload is at most 256 KiB, plus bounded row/JSON overhead.
export const CALL_KNOWLEDGE_SQL = `SELECT knowledge_items.kind, knowledge_items.title,
  knowledge_items.question, knowledge_items.answer, knowledge_items.content
 FROM knowledge_items
 JOIN assistant_knowledge_collections
   ON assistant_knowledge_collections.collection_id = knowledge_items.collection_id
 JOIN assistants ON assistants.id = assistant_knowledge_collections.assistant_id
   AND assistants.business_id = knowledge_items.business_id
 JOIN knowledge_collections ON knowledge_collections.id = knowledge_items.collection_id
   AND knowledge_collections.business_id = knowledge_items.business_id
 WHERE assistant_knowledge_collections.assistant_id = ?
   AND knowledge_items.business_id = ?
   AND knowledge_items.status = 'active'
   AND (${fields.map((field) => `length(CAST(knowledge_items.${field} AS BLOB))`).join(' + ')}) <= ${KNOWLEDGE_ITEM_BYTES}
 ORDER BY knowledge_items.created_at, knowledge_items.id
 LIMIT ${KNOWLEDGE_ROW_LIMIT}`;

export async function loadCallKnowledge(
  db: D1Database, assistantId: string, businessId: string,
): Promise<PromptKnowledgeItem[]> {
  const { results } = await db.prepare(CALL_KNOWLEDGE_SQL)
    .bind(assistantId, businessId).all<PromptKnowledgeItem>();
  const encoder = new TextEncoder();
  let remaining = KNOWLEDGE_PROMPT_BYTES - SECTION_ALLOWANCE;
  const selected: PromptKnowledgeItem[] = [];
  for (const item of results) {
    const bytes = fields.reduce((sum, field) => sum + encoder.encode(item[field]).byteLength, 0)
      + ITEM_ALLOWANCE;
    // Keep an oldest-first prefix; never cut a FAQ or skip ahead to newer facts.
    if (bytes > remaining) break;
    selected.push(item);
    remaining -= bytes;
  }
  return selected;
}
