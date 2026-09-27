/** Public, credential-free adapter contracts. Endpoints and credentials remain
 * workspace/operator-owned; selecting an adapter never copies another key. */
export type RealtimeBackendId = 'kataleptic' | 'openai' | 'custom';
export interface BackendDescriptor {
  id: string;
  label: string;
  capabilities: ('conversation' | 'text' | 'transcription' | 'speech')[];
  protocol: string;
  configurableEndpoint: boolean;
}

export const BACKENDS: BackendDescriptor[] = [
  { id: 'kataleptic', label: 'Kataleptic', capabilities: ['conversation', 'text', 'transcription'], protocol: 'Kataleptic gateway', configurableEndpoint: true },
  { id: 'openai', label: 'OpenAI', capabilities: ['conversation', 'text', 'transcription', 'speech'], protocol: 'OpenAI', configurableEndpoint: false },
  { id: 'custom', label: 'Compatible backend', capabilities: ['conversation', 'text', 'transcription', 'speech'], protocol: 'OpenAI-compatible', configurableEndpoint: true },
  { id: 'azure', label: 'Azure Speech', capabilities: ['speech'], protocol: 'Azure Speech REST', configurableEndpoint: true },
  { id: 'browser', label: 'Device voice', capabilities: ['speech'], protocol: 'Browser speech synthesis', configurableEndpoint: false },
];

/** The runtime resolver consumes this registry too, keeping UI and transport
 * defaults together. New transports need an adapter, not a misleading preset. */
export const REALTIME_BACKENDS: Record<RealtimeBackendId, {
  protocol: 'gateway' | 'openai'; defaultUrl: string; defaultModel: string;
}> = {
  kataleptic: { protocol: 'gateway', defaultUrl: 'wss://api.kataleptic.com/v1/realtime', defaultModel: 'kataleptic-realtime-hd' },
  openai: { protocol: 'openai', defaultUrl: 'wss://api.openai.com/v1/realtime', defaultModel: 'gpt-realtime' },
  custom: { protocol: 'openai', defaultUrl: '', defaultModel: 'gpt-realtime' },
};

export interface ModelRoute {
  requestedModel: string;
  upstreamModel: string;
  upstreamVersion: string | null;
  upstreamDeployment: string | null;
  upstreamService: 'Azure OpenAI Realtime' | 'Azure GPT-Live' | 'Azure Voice Live';
  voiceRenderer: 'native-model' | 'azure-speech';
  evidence: 'deployment-snapshot' | 'configuration-snapshot';
  checkedAt: string;
  /** Snapshot evidence is never proof of the model serving a new session. */
  liveSessionVerified: false;
  distinctness: 'verified-at-check' | 'unverified';
}

const checkedAt = '2026-09-26T22:54:10Z';
const nativeRoute = (requestedModel: string, upstreamVersion: string): ModelRoute => ({
  requestedModel, upstreamModel: requestedModel, upstreamVersion, upstreamDeployment: requestedModel,
  upstreamService: requestedModel === 'gpt-live-1' ? 'Azure GPT-Live' : 'Azure OpenAI Realtime',
  voiceRenderer: 'native-model', evidence: 'deployment-snapshot', checkedAt,
  liveSessionVerified: false, distinctness: 'verified-at-check',
});

/** Dated control-plane evidence, scoped ONLY to this public gateway. See
 * docs/kataleptic-routing.md for hashes, commands, limitations and rechecking. */
export const KATALEPTIC_ROUTING = {
  provider: 'kataleptic' as const,
  endpoint: REALTIME_BACKENDS.kataleptic.defaultUrl,
  source: 'docs/kataleptic-routing.md',
  routes: [
    { requestedModel: 'kataleptic-realtime-hd', upstreamModel: 'gpt-4.1-mini', upstreamVersion: null,
      upstreamDeployment: null, upstreamService: 'Azure Voice Live', voiceRenderer: 'azure-speech',
      evidence: 'configuration-snapshot', checkedAt, liveSessionVerified: false, distinctness: 'unverified' } as ModelRoute,
    nativeRoute('gpt-realtime-2', '2026-05-06'),
    nativeRoute('gpt-realtime-2.1', '2026-07-07'),
    nativeRoute('gpt-realtime-2.1-mini', '2026-07-07'),
    nativeRoute('gpt-live-1', '2026-09-10'),
  ],
};

/** Compare actual model identities, never deployment names or public aliases.
 * Unverified routes do not enter the verified comparison set. */
export function distinctModelRoutes(routes: ModelRoute[]): { distinct: boolean; collisions: string[][]; unverified: string[] } {
  const identities = new Map<string, string[]>();
  const unverified: string[] = [];
  for (const route of routes) {
    if (route.evidence !== 'deployment-snapshot' || !route.upstreamModel || !route.upstreamVersion) {
      unverified.push(route.requestedModel); continue;
    }
    // Different deployment names, versions, or services of the same model do
    // not satisfy the user's requirement for *different models*.
    const id = route.upstreamModel.toLowerCase();
    identities.set(id, [...(identities.get(id) || []), route.requestedModel]);
  }
  const collisions = [...identities.values()].filter(group => group.length > 1);
  return { distinct: routes.length > 1 && !collisions.length && !unverified.length, collisions, unverified };
}

export function knownKatalepticConversationModel(model: string): boolean {
  return KATALEPTIC_ROUTING.routes.some(route => route.requestedModel === model);
}

/** Query routing, custom hosts, alternate ports, and alternate paths are outside
 * the evidence boundary even when their adapter is named Kataleptic. */
export function katalepticRoute(baseUrl: string, model: string): ModelRoute | null {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return null; }
  if (url.href !== KATALEPTIC_ROUTING.endpoint) return null;
  return KATALEPTIC_ROUTING.routes.find(route => route.requestedModel === model) || null;
}
