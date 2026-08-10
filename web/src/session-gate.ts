import type { Assistant, Business } from './api';

// The compatibility dashboard and its public-link card are both scoped to the
// assistant whose slug matches the workspace's legacy public URL. A secondary
// active assistant must not make that primary link look live.
export function compatibilityAssistant(
  business: Pick<Business, 'slug'> | null,
  assistants: Assistant[]
): Assistant | null {
  if (!business) return null;
  return assistants.find((assistant) => assistant.public_slug === business.slug) ?? null;
}

export function compatibilitySetupPending(
  business: Pick<Business, 'slug'> | null,
  workspaceReady: boolean,
  firstAssistantReady: boolean,
  assistant: Pick<Assistant, 'state'> | null
): boolean {
  return (
    !business ||
    !workspaceReady ||
    !firstAssistantReady ||
    assistant?.state !== 'active'
  );
}
