export interface Me {
  id: string;
  email: string;
}

export interface Agent {
  agent_name: string;
  greeting: string;
  persona: string;
  language: string;
  voice: string;
  take_messages: number;
  custom_instructions: string;
  llm_base_url: string;
  llm_api_key: string;
  apiKeyConfigured?: boolean;
  workspaceApiKeyConfigured?: boolean;
  llm_model: string;
  engine: string;
  realtime_model: string;
  realtime_voice: string;
}

export type AssistantState = 'draft' | 'active' | 'paused';
export type CallEnvironment = 'test' | 'live';
export type CallDirection = 'inbound' | 'outbound';

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
  last_live_call_at?: string | null;
  last_test_at?: string | null;
  collectionIds?: string[];
}

export interface Business {
  id: string;
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
  agent: Agent | null;
}

export interface CallRow {
  id: string;
  channel: string;
  caller_id: string;
  status: string;
  started_at: string;
  connected_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  summary: string | null;
  intent: string | null;
  message_json: string | null;
  assistant_id?: string | null;
  assistant_name?: string | null;
  assistant_slug?: string | null;
  environment?: CallEnvironment;
  direction?: CallDirection;
  outcome?: string | null;
  unanswered_json?: string | null;
  failure_code?: string | null;
  failure_message?: string | null;
}

export interface CallDetail extends CallRow {
  turns: { id: number; role: 'caller' | 'agent'; text: string; ts: string }[];
}

export interface Bootstrap {
  account: Me;
  workspace: Business | null;
  assistants: Assistant[];
  setup: { account: boolean; workspace: boolean; firstAssistant: boolean; firstTest: boolean };
  readiness: { providerConfigured: boolean; liveAssistantCount: number };
}

export interface CallsPage {
  items: CallRow[];
  nextCursor: string | null;
}

export interface OverviewResponse {
  days: 7 | 30 | 90;
  metrics: {
    total: number;
    completed?: number;
    failed?: number;
    messages?: number;
    booking_requests?: number;
    talk_time_s?: number;
    average_duration_s?: number;
  };
  recentCalls: CallRow[];
}

export interface KnowledgeCollection {
  id: string;
  business_id: string;
  name: string;
  description: string;
  is_default: number;
  item_count?: number;
  active_item_count?: number;
  assistant_ids?: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeItem {
  id: string;
  business_id: string;
  collection_id: string;
  kind: 'faq' | 'service' | 'note';
  status: 'draft' | 'active';
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

export interface ProviderView {
  baseUrl: string;
  usesInstanceDefault: boolean;
  apiKeyConfigured: boolean;
  workspaceApiKeyConfigured: boolean;
  updatedAt: string | null;
}

export interface EnginePreset {
  id: string;
  business_id: string;
  name: string;
  engine: string;
  realtime_model: string;
  realtime_voice: string;
  language: string;
  voice: string;
  llm_model: string;
  created_at: string;
  updated_at: string;
}

export interface EngineProfile {
  id: string;
  name: string;
  engine: string;
  realtime_model: string;
  realtime_voice: string;
  language: string;
  voice: string;
  llm_base_url: string;
  llm_api_key: string;
  apiKeyConfigured?: boolean;
  llm_model: string;
}

export interface VoiceOption {
  id: string;
  label: string;
}

export interface VoiceCatalog {
  cascade: VoiceOption[];
  native: VoiceOption[];
  azure: VoiceOption[];
  hdDefault: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const api = {
  me: () => req<Me>('GET', '/api/me'),
  signup: (email: string, password: string) => req<Me>('POST', '/api/auth/signup', { email, password }),
  login: (email: string, password: string) => req<Me>('POST', '/api/auth/login', { email, password }),
  logout: () => req<{ ok: true }>('POST', '/api/auth/logout'),
  business: () => req<Business | null>('GET', '/api/me/business'),
  bootstrap: () => req<Bootstrap>('GET', '/api/me/bootstrap'),
  createBusiness: (b: Partial<Business>) => req<Business>('POST', '/api/me/business', b),
  updateBusiness: (id: string, b: Partial<Business>) => req<{ ok: true }>('PUT', `/api/me/business/${id}`, b),
  updateAgent: (id: string, a: Partial<Agent> & { clearApiKey?: boolean }) =>
    req<{ ok: true }>('PUT', `/api/me/business/${id}/agent`, a),
  calls: (id: string) => req<CallRow[]>('GET', `/api/me/business/${id}/calls`),
  call: (callId: string) => req<CallDetail>('GET', `/api/me/calls/${callId}`),
  assistants: () => req<Assistant[]>('GET', '/api/me/assistants'),
  assistant: (id: string) => req<Assistant>('GET', `/api/me/assistants/${id}`),
  createAssistant: (assistant: Partial<Assistant>) => req<Assistant>('POST', '/api/me/assistants', assistant),
  updateAssistant: (id: string, assistant: Partial<Assistant>) => req<Assistant>('PUT', `/api/me/assistants/${id}`, assistant),
  activateAssistant: (id: string) => req<{ ok: true; state: 'active' }>('POST', `/api/me/assistants/${id}/activate`, {}),
  pauseAssistant: (id: string) => req<{ ok: true; state: 'paused' }>('POST', `/api/me/assistants/${id}/pause`, {}),
  startTestCall: (id: string) => req<{ callId: string; assistantId: string; environment: 'test' }>('POST', `/api/me/assistants/${id}/test-calls`, {}),
  callPage: (params: URLSearchParams) => req<CallsPage>('GET', `/api/me/calls?${params.toString()}`),
  overview: (days: 7 | 30 | 90 = 30) => req<OverviewResponse>('GET', `/api/me/overview?days=${days}`),
  knowledgeCollections: () => req<KnowledgeCollection[]>('GET', '/api/me/knowledge/collections'),
  knowledgeCollection: (id: string) => req<KnowledgeCollection & { items: KnowledgeItem[]; assistants: Assistant[] }>('GET', `/api/me/knowledge/collections/${id}`),
  createKnowledgeCollection: (body: Pick<KnowledgeCollection, 'name' | 'description'>) => req<KnowledgeCollection>('POST', '/api/me/knowledge/collections', body),
  updateKnowledgeCollection: (id: string, body: Partial<Pick<KnowledgeCollection, 'name' | 'description'>>) => req<{ ok: true }>('PUT', `/api/me/knowledge/collections/${id}`, body),
  deleteKnowledgeCollection: (id: string) => req<{ ok: true }>('DELETE', `/api/me/knowledge/collections/${id}`),
  createKnowledgeItem: (collectionId: string, body: Partial<KnowledgeItem>) => req<KnowledgeItem>('POST', `/api/me/knowledge/collections/${collectionId}/items`, body),
  updateKnowledgeItem: (id: string, body: Partial<KnowledgeItem>) => req<KnowledgeItem>('PUT', `/api/me/knowledge/items/${id}`, body),
  deleteKnowledgeItem: (id: string) => req<{ ok: true }>('DELETE', `/api/me/knowledge/items/${id}`),
  draftKnowledgeFromTurn: (body: { callId: string; turnId: number; collectionId?: string }) => req<KnowledgeItem>('POST', '/api/me/knowledge/drafts/from-turn', body),
  attachKnowledgeCollection: (assistantId: string, collectionId: string) => req<{ ok: true }>('POST', `/api/me/assistants/${assistantId}/knowledge-collections/${collectionId}`, {}),
  detachKnowledgeCollection: (assistantId: string, collectionId: string) => req<{ ok: true }>('DELETE', `/api/me/assistants/${assistantId}/knowledge-collections/${collectionId}`),
  provider: () => req<ProviderView>('GET', '/api/me/provider'),
  updateProvider: (body: { baseUrl?: string; apiKey?: string | null; clearApiKey?: boolean }) =>
    req<{ ok: true; apiKeyConfigured: boolean; workspaceApiKeyConfigured: boolean }>('PUT', '/api/me/provider', body),
  checkProvider: (assistantId?: string) => req<{ ok: true; model: string }>('POST', '/api/me/provider/check', assistantId ? { assistantId } : {}),
  enginePresets: () => req<EnginePreset[]>('GET', '/api/me/engine-presets'),
  createEnginePreset: (body: Partial<EnginePreset>) => req<EnginePreset>('POST', '/api/me/engine-presets', body),
  updateEnginePreset: (id: string, body: Partial<EnginePreset>) => req<{ ok: true }>('PUT', `/api/me/engine-presets/${id}`, body),
  deleteEnginePreset: (id: string) => req<{ ok: true }>('DELETE', `/api/me/engine-presets/${id}`),
  applyEnginePreset: (id: string, assistantId: string) => req<{ ok: true }>('POST', `/api/me/engine-presets/${id}/apply`, { assistantId }),
  profiles: (bizId: string) => req<EngineProfile[]>('GET', `/api/me/business/${bizId}/profiles`),
  createProfile: (bizId: string, p: Partial<EngineProfile>) => req<EngineProfile>('POST', `/api/me/business/${bizId}/profiles`, p),
  updateProfile: (pid: string, p: Partial<EngineProfile>) => req<{ ok: true }>('PUT', `/api/me/profiles/${pid}`, p),
  deleteProfile: (pid: string) => req<{ ok: true }>('DELETE', `/api/me/profiles/${pid}`),
  applyProfile: (pid: string) => req<{ ok: true }>('POST', `/api/me/profiles/${pid}/apply`),
  voices: () => req<VoiceCatalog>('GET', '/api/me/voices'),
};
