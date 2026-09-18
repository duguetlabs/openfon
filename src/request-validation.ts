import { HTTPException } from 'hono/http-exception';

// These routes persist scalar workspace fields. TypeScript request generics
// are not runtime validation: a JSON object in a text field otherwise reaches
// .trim() or D1.bind(), producing a 500 or corrupting later prompt reads.
const TEXT_FIELDS = new Set([
  'name', 'description', 'address', 'phone', 'website', 'timezone',
  'hours_json', 'services_json', 'faqs_json', 'closures_json',
  'agent_name', 'greeting', 'persona', 'language', 'voice', 'custom_instructions',
  'engine', 'realtime_model', 'realtime_voice', 'llm_model', 'llm_base_url', 'llm_api_key',
  'title', 'question', 'answer', 'content', 'kind', 'status', 'collection_id',
  'callId', 'collectionId', 'assistantId', 'baseUrl', 'slug',
]);

function invalid(message: string): never {
  throw new HTTPException(400, { res: Response.json({ error: message }, { status: 400 }) });
}

export async function readWorkspaceBody<T>(request: { text(): Promise<string> }, allowEmpty = false): Promise<T> {
  const raw = await request.text();
  let body: unknown;
  try {
    body = allowEmpty && !raw.trim() ? {} : JSON.parse(raw);
  } catch {
    return invalid('Request body must be valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('Request body must be a JSON object.');
  for (const [key, value] of Object.entries(body)) {
    if (TEXT_FIELDS.has(key) && typeof value !== 'string') return invalid(`${key} must be text.`);
    if (key === 'apiKey' && value !== null && typeof value !== 'string') return invalid('API key must be a string or null.');
    if (key === 'clearApiKey' && typeof value !== 'boolean') return invalid('clearApiKey must be a boolean.');
    if (key === 'take_messages' && value !== 0 && value !== 1 && typeof value !== 'boolean') return invalid('take_messages must be true, false, 0, or 1.');
    if ((key === 'max_concurrent_calls' || key === 'max_calls_per_day' || key === 'turnId') &&
        (typeof value !== 'number' || !Number.isFinite(value))) return invalid(`${key} must be a number.`);
  }
  return body as T;
}
