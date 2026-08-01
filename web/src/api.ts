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
  llm_model: string;
  engine: string;
  realtime_model: string;
  realtime_voice: string;
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
}

export interface CallDetail extends CallRow {
  turns: { role: 'caller' | 'agent'; text: string; ts: string }[];
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
  createBusiness: (b: Partial<Business>) => req<Business>('POST', '/api/me/business', b),
  updateBusiness: (id: string, b: Partial<Business>) => req<{ ok: true }>('PUT', `/api/me/business/${id}`, b),
  updateAgent: (id: string, a: Partial<Agent>) => req<{ ok: true }>('PUT', `/api/me/business/${id}/agent`, a),
  calls: (id: string) => req<CallRow[]>('GET', `/api/me/business/${id}/calls`),
  call: (callId: string) => req<CallDetail>('GET', `/api/me/calls/${callId}`),
  profiles: (bizId: string) => req<EngineProfile[]>('GET', `/api/me/business/${bizId}/profiles`),
  createProfile: (bizId: string, p: Partial<EngineProfile>) => req<EngineProfile>('POST', `/api/me/business/${bizId}/profiles`, p),
  updateProfile: (pid: string, p: Partial<EngineProfile>) => req<{ ok: true }>('PUT', `/api/me/profiles/${pid}`, p),
  deleteProfile: (pid: string) => req<{ ok: true }>('DELETE', `/api/me/profiles/${pid}`),
  applyProfile: (pid: string) => req<{ ok: true }>('POST', `/api/me/profiles/${pid}/apply`),
  voices: () => req<VoiceCatalog>('GET', '/api/me/voices'),
};
