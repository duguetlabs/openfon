export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  CALL_SESSION: DurableObjectNamespace;
  // LLM (any OpenAI-compatible API)
  DEFAULT_LLM_BASE_URL: string;
  DEFAULT_LLM_MODEL: string;
  DEFAULT_LLM_API_KEY?: string;
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
