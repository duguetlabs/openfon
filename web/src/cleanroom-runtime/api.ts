import type { Account, Assistant, AssistantFields, AssistantSummary, Bootstrap, Call, CallDetail, CallFilters, Collection, CollectionDetail, KnowledgeFields, KnowledgeItem, Page, Preset, Provider, ProviderCatalog, ProviderPatch, SummaryPatch, SummarySettings, TestTicket, Workspace } from './types';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfter: string | null = null) { super(message); this.name = 'ApiError'; }
}

type UnauthorizedBoundary = { notify: () => void };
let unauthorizedBoundary: UnauthorizedBoundary | null = null;
/** A new boundary invalidates callbacks from requests started by an earlier session. */
export function onPrivateUnauthorized(notify: () => void): () => void {
  const boundary = { notify };
  unauthorizedBoundary = boundary;
  return () => { if (unauthorizedBoundary === boundary) unauthorizedBoundary = null; };
}

function expireUnauthorized(path: string, status: number, boundary: UnauthorizedBoundary | null) {
  if (status !== 401 || !/^\/api\/me(?:\/|$)/.test(path) || !boundary || boundary !== unauthorizedBoundary) return;
  unauthorizedBoundary = null;
  boundary.notify();
}

/** Same-origin cookies only. No retries of uncertain writes and no credential persistence. */
export async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const boundary = unauthorizedBoundary;
  const response = await fetch(path, {
    method, credentials: 'same-origin', signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `Request failed (${response.status}). Please try again.`;
    expireUnauthorized(path, response.status, boundary);
    throw new ApiError(message, response.status, response.headers.get('Retry-After'));
  }
  return data as T;
}
const id = encodeURIComponent;
const query = (values: object) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value));
  return params.size ? `?${params}` : '';
};
type Ok = { ok: true };
async function confirmedMutation(path: string, method: string, body?: unknown): Promise<Ok> {
  const data = await request<Ok | null>(path, method, body);
  if (!data || data.ok !== true) throw new Error('The server did not confirm the request. Please check its status before trying again.');
  return data;
}
export const api = {
  publicAssistant: (slug: string) => request<{ assistantId: string; businessName: string; agentName: string; language: string }>(`/api/public/agent/${id(slug)}`),
  me: () => request<Account>('/api/me'),
  bootstrap: () => request<Bootstrap>('/api/me/bootstrap'),
  login: (email: string, password: string) => request<{ id: string }>('/api/auth/login', 'POST', { email, password }),
  signup: (email: string, password: string) => request<Account>('/api/auth/signup', 'POST', { email, password }),
  logout: () => confirmedMutation('/api/auth/logout', 'POST'),
  exportAccount: () => request<unknown>('/api/me/account/export'),
  deleteAccount: (body: { currentPassword: string; confirmation: 'DELETE' }) => confirmedMutation('/api/me/account', 'DELETE', body),
  createWorkspace: (patch: Partial<Workspace>) => request<Workspace>('/api/me/business', 'POST', patch),
  updateWorkspace: (key: string, patch: Partial<Workspace>) => request<Ok>(`/api/me/business/${id(key)}`, 'PUT', patch),
  assistants: (offset = 0) => request<AssistantSummary[]>(`/api/me/assistants?offset=${offset}`),
  assistant: (key: string) => request<Assistant>(`/api/me/assistants/${id(key)}`),
  createAssistant: (patch: Partial<AssistantFields>) => request<Assistant>('/api/me/assistants', 'POST', patch),
  saveAssistant: (key: string, patch: Partial<AssistantFields>) => request<Assistant>(`/api/me/assistants/${id(key)}`, 'PUT', patch),
  deleteAssistant: (key: string) => request<Ok>(`/api/me/assistants/${id(key)}`, 'DELETE'),
  activateAssistant: (key: string) => request<Ok>(`/api/me/assistants/${id(key)}/activate`, 'POST'),
  pauseAssistant: (key: string) => request<Ok>(`/api/me/assistants/${id(key)}/pause`, 'POST'),
  reserveTest: (key: string) => request<TestTicket>(`/api/me/assistants/${id(key)}/test-calls`, 'POST'),
  cancelTest: (key: string) => request<Ok>(`/api/me/test-calls/${id(key)}`, 'DELETE'),
  collections: () => request<Collection[]>('/api/me/knowledge/collections'),
  collection: (key: string, cursor?: string) => request<CollectionDetail>(`/api/me/knowledge/collections/${id(key)}${query({ cursor })}`),
  createCollection: (patch: { name: string; description?: string }) => request<Collection>('/api/me/knowledge/collections', 'POST', patch),
  saveCollection: (key: string, patch: { name?: string; description?: string }) => request<Ok>(`/api/me/knowledge/collections/${id(key)}`, 'PUT', patch),
  deleteCollection: (key: string) => request<Ok>(`/api/me/knowledge/collections/${id(key)}`, 'DELETE'),
  createKnowledge: (key: string, patch: Partial<KnowledgeFields>) => request<KnowledgeItem>(`/api/me/knowledge/collections/${id(key)}/items`, 'POST', patch),
  saveKnowledge: (key: string, patch: Partial<KnowledgeFields> & { collection_id?: string }) => request<KnowledgeItem>(`/api/me/knowledge/items/${id(key)}`, 'PUT', patch),
  removeKnowledge: (key: string) => request<Ok>(`/api/me/knowledge/items/${id(key)}`, 'DELETE'),
  knowledgeFromTurn: (callId: string, turnId: number, collectionId?: string) => request<KnowledgeItem>('/api/me/knowledge/drafts/from-turn', 'POST', { callId, turnId, collectionId }),
  attachKnowledge: (assistant: string, collection: string) => request<Ok>(`/api/me/assistants/${id(assistant)}/knowledge-collections/${id(collection)}`, 'POST'),
  detachKnowledge: (assistant: string, collection: string) => request<Ok>(`/api/me/assistants/${id(assistant)}/knowledge-collections/${id(collection)}`, 'DELETE'),
  calls: (filters: CallFilters = {}) => request<Page<Call>>(`/api/me/calls${query(filters)}`),
  call: (key: string) => request<CallDetail>(`/api/me/calls/${id(key)}`),
  provider: () => request<Provider>('/api/me/provider'),
  saveProvider: (patch: ProviderPatch) => request<Ok>('/api/me/provider', 'PUT', patch),
  providerCatalog: () => request<ProviderCatalog>('/api/me/provider/catalog'),
  checkProvider: (assistantId: string) => request<Ok & { model: string }>('/api/me/provider/check', 'POST', { assistantId }),
  voicePreview: async (assistantId: string, voice: Partial<Pick<AssistantFields, 'engine' | 'language' | 'voice' | 'realtime_model' | 'realtime_voice'>>, signal?: AbortSignal): Promise<Blob> => {
    const boundary = unauthorizedBoundary;
    const path = `/api/me/assistants/${id(assistantId)}/voice-preview`;
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: voice.engine, language: voice.language, voice: voice.voice, realtime_model: voice.realtime_model, realtime_voice: voice.realtime_voice }),
    });
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : 'Voice preview failed. Check the saved speech provider and try again.';
      expireUnauthorized(path, response.status, boundary);
      throw new ApiError(message, response.status, response.headers.get('Retry-After'));
    }
    return response.blob();
  },
  summaries: () => request<SummarySettings>('/api/me/call-summaries'),
  saveSummaries: (patch: SummaryPatch) => request<SummarySettings>('/api/me/call-summaries', 'PUT', patch),
  presets: () => request<Preset[]>('/api/me/engine-presets'),
  createPreset: (patch: Omit<Preset, 'id' | 'business_id' | 'updated_at'>) => request<Preset>('/api/me/engine-presets', 'POST', patch),
  applyPreset: (key: string, assistantId: string) => request<Ok>(`/api/me/engine-presets/${id(key)}/apply`, 'POST', { assistantId }),
  renamePreset: (key: string, name: string) => request<Ok>(`/api/me/engine-presets/${id(key)}`, "PUT", { name }),
  deletePreset: (key: string) => request<Ok>(`/api/me/engine-presets/${id(key)}`, 'DELETE'),
  changePassword: (currentPassword: string, newPassword: string) => request<Ok>('/api/me/account/password', 'POST', { currentPassword, newPassword }),
};
