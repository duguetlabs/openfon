export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  CALL_SESSION: DurableObjectNamespace;
  // LLM (any OpenAI-compatible API)
  DEFAULT_LLM_BASE_URL: string;
  DEFAULT_LLM_MODEL: string;
  DEFAULT_LLM_API_KEY?: string;
  // "true" lets a business point its own LLM at a plain-http or loopback URL —
  // for a model running alongside the Worker. Single-tenant instances only.
  ALLOW_INSECURE_LLM_URL?: string;
  // STT (any OpenAI-compatible /audio/transcriptions)
  DEFAULT_STT_BASE_URL: string;
  DEFAULT_STT_MODEL: string;
  DEFAULT_STT_API_KEY?: string;
  // TTS: "azure" (server-side) or "browser" (client speechSynthesis, zero cost)
  DEFAULT_TTS_PROVIDER: string;
  AZURE_SPEECH_KEY?: string;
  AZURE_SPEECH_REGION: string;
  DEFAULT_TTS_VOICE: string;
  // Realtime engine (any OpenAI Realtime-compatible WebSocket endpoint)
  REALTIME_BASE_URL: string;
  REALTIME_MODEL: string;
  REALTIME_API_KEY?: string; // falls back to DEFAULT_LLM_API_KEY
}

export interface Business {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  description: string;
  address: string;
  phone: string;
  website: string;
  timezone: string;
  hours_json: string;
  services_json: string;
  faqs_json: string;
  closures_json: string;
  max_concurrent_calls: number;
  max_calls_per_day: number;
}

export interface AgentSettings {
  business_id: string;
  agent_name: string;
  greeting: string;
  persona: string;
  language: string;
  voice: string;
  take_messages: number;
  custom_instructions: string;
  llm_base_url: string;
  llm_api_key: string;
  llm_model: string;
  engine: string; // 'pipeline' | 'realtime'
  realtime_model: string; // empty = instance default (REALTIME_MODEL)
  realtime_voice: string; // tier-specific voice id, passed verbatim; empty = tier default
}

export type AssistantState = 'draft' | 'active' | 'paused';
export type CallEnvironment = 'test' | 'live';
export type CallDirection = 'inbound' | 'outbound';
export type KnowledgeKind = 'faq' | 'service' | 'note';
export type KnowledgeStatus = 'draft' | 'active';

export interface Assistant {
  id: string;
  business_id: string;
  public_slug: string;
  state: AssistantState;
  name: string;
  greeting: string;
  persona: string;
  language: string;
  voice: string;
  take_messages: number;
  custom_instructions: string;
  engine: string;
  realtime_model: string;
  realtime_voice: string;
  llm_model: string;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
}

export interface ProviderSettings {
  business_id: string;
  llm_base_url: string;
  llm_api_key: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeCollection {
  id: string;
  business_id: string;
  name: string;
  description: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeItem {
  id: string;
  business_id: string;
  collection_id: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  title: string;
  question: string;
  answer: string;
  content: string;
  source_call_id: string | null;
  source_turn_id: number | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
