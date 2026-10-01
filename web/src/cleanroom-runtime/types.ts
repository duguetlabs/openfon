/** Transport types extracted from Worker routes; no presentation dependencies. */
export interface Account { id: string; email: string; created_at?: string }
export interface Workspace {
  id: string; user_id: string; slug: string; name: string; description: string;
  address: string; phone: string; website: string; timezone: string;
  hours_json: string; services_json: string; faqs_json: string; closures_json: string;
  max_concurrent_calls: number; max_calls_per_day: number;
}
export type Engine = 'pipeline' | 'realtime';
export type AssistantState = 'draft' | 'active' | 'paused';
export interface AssistantFields {
  name: string; greeting: string; persona: string; language: string; voice: string;
  take_messages: number; custom_instructions: string; engine: Engine;
  realtime_model: string; realtime_voice: string; llm_model: string;
}
export interface Assistant extends AssistantFields {
  id: string; business_id: string; public_slug: string; state: AssistantState;
  created_at: string; updated_at: string; activated_at: string | null; collectionIds?: string[];
}
export type AssistantSummary = Pick<Assistant, 'id' | 'business_id' | 'public_slug' | 'state' | 'name' | 'persona' | 'language'> & {
  engine?: Engine; created_at?: string; updated_at?: string; essentials_ready?: number;
  last_live_call_at?: string | null; last_test_at?: string | null;
};
export interface Bootstrap {
  account: Account; workspace: Workspace | null; assistants: AssistantSummary[];
  setup: { account: boolean; workspace: boolean; firstAssistant: boolean; firstTest: boolean };
  readiness: { providerConfigured: boolean; liveAssistantCount: number };
}
export interface KnowledgeFields {
  kind: 'faq' | 'service' | 'note'; status: 'draft' | 'active';
  title: string; question: string; answer: string; content: string;
}
export interface KnowledgeItem extends KnowledgeFields {
  id: string; business_id: string; collection_id: string; source_call_id: string | null;
  source_turn_id: number | null; created_at: string; updated_at: string; activated_at: string | null;
}
export interface Collection {
  id: string; business_id: string; name: string; description: string; is_default: number;
  created_at: string; updated_at: string; item_count?: number; active_item_count?: number; assistant_ids?: string | null;
}
export interface Page<T> { items: T[]; nextCursor: string | null }
export type CollectionDetail = Collection & Page<KnowledgeItem> & { assistants: Pick<Assistant, 'id' | 'name' | 'state'>[] };
export interface Call {
  id: string; business_id: string; assistant_id: string | null; assistant_name?: string; assistant_slug?: string;
  channel: string; caller_id: string | null; environment: 'test' | 'live'; direction: 'inbound' | 'outbound';
  status: string; started_at: string; ended_at: string | null; connected_at: string | null;
  duration_s: number | null; summary: string | null; intent: string | null; message_json: string | null;
  outcome: string | null; unanswered_json: string | null; failure_code: string | null; failure_message: string | null;
}
export interface Turn { id: number; role: 'caller' | 'agent'; text: string; ts: string }
export interface CallDetail extends Call { turns: Turn[] }
export interface CallFilters {
  environment?: 'test' | 'live' | 'all'; assistantId?: string; status?: string; intent?: string;
  direction?: 'inbound' | 'outbound'; from?: string; to?: string; search?: string; cursor?: string; limit?: number;
}
export interface Option { id: string; label: string }
export interface TextPreset extends Option { baseUrl: string; model: string }
export interface Provider {
  managed_browser_voice?:boolean;
  baseUrl: string; model: string; usesInstanceDefault: boolean; apiKeyConfigured: boolean; workspaceApiKeyConfigured: boolean;
  presets: TextPreset[]; instance_text_preset: string; instance_text_model: string;
  realtime_provider: 'instance' | 'kataleptic' | 'openai' | 'custom'; realtime_base_url: string; realtime_api_key_configured: boolean;
  stt_provider: 'instance' | 'openai' | 'custom'; stt_base_url: string; stt_model: string; stt_api_key_configured: boolean;
  tts_provider: 'instance' | 'browser' | 'azure' | 'openai' | 'custom'; tts_base_url: string; tts_model: string; tts_api_key_configured: boolean;
  effective_tts_provider: string; effective_text_model: string; effective_stt_model: string; effective_realtime_provider: string;
  effective_realtime_model: string; updatedAt: string | null; realtimeRoute: Record<string, unknown> | null;
}
export type ProviderPatch = Partial<Pick<Provider, 'baseUrl' | 'model' | 'realtime_provider' | 'realtime_base_url' | 'stt_provider' | 'stt_base_url' | 'stt_model' | 'tts_provider' | 'tts_base_url' | 'tts_model'>> & {
  apiKey?: string | null; clearApiKey?: boolean; realtime_api_key?: string | null; realtime_clear_api_key?: boolean;
  stt_api_key?: string | null; stt_clear_api_key?: boolean; tts_api_key?: string | null; tts_clear_api_key?: boolean;
};
export interface ProviderCatalog {
  models: (Option & { kind: 'text' | 'transcription' | 'realtime' })[]; live: boolean;
  voices: { native: Option[]; realtime: Record<string, Option[]>; cataloguedModels: string[]; azure: Option[]; hdDefault: string };
  backends: { id: string; label: string; capabilities: ('conversation' | 'text' | 'transcription' | 'speech')[]; protocol: string; configurableEndpoint: boolean }[];
  routing: Record<string, unknown>;
}
export interface SummarySettings {
  mode: 'legacy' | 'workspace' | 'custom'; baseUrl: string; model: string; apiKeyConfigured: boolean; revision: string | null;
}
export type SummaryPatch = Pick<SummarySettings, 'mode' | 'baseUrl' | 'model' | 'revision'> & { apiKey: string };
export interface Preset extends Pick<AssistantFields, 'name' | 'engine' | 'realtime_model' | 'realtime_voice' | 'language' | 'voice' | 'llm_model'> { id: string; business_id: string; updated_at: string; preview_only?: number }
export interface TestTicket { callId: string; assistantId: string; environment: 'test' }
