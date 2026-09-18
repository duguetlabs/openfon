import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CALL_KNOWLEDGE_SQL, loadCallKnowledge } from '../src/call-knowledge';
import { buildSystemPrompt, type PromptKnowledgeItem } from '../src/prompt';
import type { Business, AgentSettings } from '../src/types';
import { applyMigrations, SqliteD1 } from './sqlite-d1';

const bytes = (item: PromptKnowledgeItem) => Object.values(item)
  .reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0);
let db: SqliteD1;
const load = (assistant = 'a', business = 'b') => loadCallKnowledge(db as unknown as D1Database, assistant, business);
function insert(id: string, patch: Partial<PromptKnowledgeItem> & {
  business_id?: string; collection_id?: string; status?: string; created_at?: string;
} = {}) {
  const item = { id, business_id: 'b', collection_id: 'c', kind: 'note', status: 'active',
    title: id, question: '', answer: '', content: '', created_at: '2026-01-01', ...patch };
  const keys = Object.keys(item);
  db.database.prepare(`INSERT INTO knowledge_items (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(item));
}
const raw = () => db.database.prepare(CALL_KNOWLEDGE_SQL).all('a', 'b') as unknown as PromptKnowledgeItem[];

beforeEach(() => {
  db = new SqliteD1();
  // Use the actual schema, not a fake D1 query matcher or a simplified table.
  applyMigrations(db, 1, 8);
  db.exec(`INSERT INTO users (id,email,password_hash) VALUES ('u','knowledge@test.invalid','hash'),('v','other@test.invalid','hash');
    INSERT INTO businesses (id,user_id,slug,name) VALUES ('b','u','b','Test'),('foreign','v','foreign','Other');
    INSERT INTO assistants (id,business_id,public_slug) VALUES ('a','b','a'),('other','b','other'),('foreign','foreign','foreign');
    INSERT INTO knowledge_collections (id,business_id,name) VALUES ('c','b','Attached'),('detached','b','Detached'),('foreign','foreign','Foreign');
    INSERT INTO assistant_knowledge_collections (assistant_id,collection_id) VALUES ('a','c'),('a','foreign'),('foreign','c');`);
});
afterEach(() => db.close());

describe('bounded call knowledge on actual SQLite', () => {
  it('limits D1 materialization to 32 rows and 256 KiB combined UTF-8 fields', async () => {
    for (let i = 39; i >= 0; i--) {
      const id = `item-${String(i).padStart(2, '0')}`;
      insert(id, { content: 'x'.repeat(8192 - 4 - id.length) });
    }
    const rows = raw();
    expect(rows).toHaveLength(32);
    expect(rows.map(row => row.title)).toEqual(Array.from({ length: 32 }, (_, i) => `item-${String(i).padStart(2, '0')}`));
    expect(rows.reduce((sum, row) => sum + bytes(row), 0)).toBe(256 * 1024);
    // Formatting allowance means four maximum-size entries cannot fit intact.
    expect((await load()).map(row => row.title)).toEqual(['item-00', 'item-01', 'item-02']);
  });

  it('prefilters oversized ASCII, multibyte, aggregate fields and NUL payloads before LIMIT', async () => {
    for (let i = 0; i < 40; i++) insert(`large-${i}`, { content: 'x'.repeat(128 * 1024), created_at: '2025' });
    insert('unicode', { content: '€'.repeat(3000), created_at: '2025' });
    insert('combined', { question: 'q'.repeat(5000), answer: 'a'.repeat(5000), created_at: '2025' });
    insert('nul', { content: '\0'.repeat(9000), created_at: '2025' });
    insert('fits', { title: '', content: '€'.repeat(2729) + 'x' }); // 4 + 8187 + 1 = 8192
    insert('over', { title: '', content: '€'.repeat(2729) + 'xx' });
    expect(raw()).toHaveLength(1);
    expect(bytes(raw()[0])).toBe(8192);
    expect(await load()).toEqual(raw());
  });

  it('retains active, attached, tenant, assistant and collection ownership filters', async () => {
    insert('allowed');
    insert('draft', { status: 'draft' });
    insert('detached', { collection_id: 'detached' });
    insert('foreign-item', { business_id: 'foreign', collection_id: 'foreign' });
    insert('foreign-in-local', { business_id: 'foreign' });
    insert('local-in-foreign', { collection_id: 'foreign' });
    expect((await load()).map(row => row.title)).toEqual(['allowed']);
    expect(await load('other')).toEqual([]);
    expect(await load('foreign', 'b')).toEqual([]);
    expect(await load('missing')).toEqual([]);
    expect(await load('a', 'foreign')).toEqual([]);
  });

  it('orders by creation then id, retaining whole FAQs and stopping at the first budget overflow', async () => {
    insert('z-old', { kind: 'faq', question: 'Q'.repeat(4000), answer: '€'.repeat(1300), created_at: '2024' });
    for (const id of ['c', 'b', 'a']) insert(id, { content: 'x'.repeat(8000) });
    insert('d-overflow', { content: 'y'.repeat(8000) });
    insert('e-small-newer', { content: 'small' });
    const items = await load();
    expect(items.map(row => row.title)).toEqual(['z-old', 'a', 'b', 'c']);
    expect(items[0].question).toBe('Q'.repeat(4000));
    expect(items[0].answer).toBe('€'.repeat(1300));
  });

  it('bounds the actual mixed-kind rendered knowledge section including headings and separators', async () => {
    for (let i = 0; i < 40; i++) {
      const kind = (['faq', 'service', 'note'] as const)[i % 3];
      insert(String(i).padStart(2, '0'), { kind, title: 'Name 😀', question: 'Why?', answer: '€'.repeat(650), content: '😀'.repeat(500) });
    }
    const items = await load();
    expect(items.length).toBeGreaterThan(3);
    expect(items.length).toBeLessThan(32);
    const prompt = buildSystemPrompt({ name: 'Test', timezone: 'UTC', hours_json: '{}', closures_json: '[]' } as Business,
      { agent_name: 'Alex', language: 'en' } as AgentSettings, new Date('2026-01-01'), items);
    const section = prompt.slice(prompt.indexOf('SERVICES:\n'), prompt.indexOf('\nBEHAVIOR:'));
    expect(section).toContain('Q: Why?');
    expect(section).toContain('OTHER APPROVED KNOWLEDGE:');
    expect(new TextEncoder().encode(section).length).toBeLessThanOrEqual(32768);
    expect(items.reduce((sum, item) => sum + bytes(item) + 32, 256)).toBeLessThanOrEqual(32768);
  });
});
