import type { Assistant, BootstrapAssistant, Business } from './api';

// The compatibility dashboard and its public-link card are both scoped to the
// assistant whose slug matches the workspace's legacy public URL. A secondary
// active assistant must not make that primary link look live.
export function compatibilityAssistant(
  business: Pick<Business, 'slug'> | null,
  assistants: BootstrapAssistant[]
): BootstrapAssistant | null {
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

// The studio can edit draft assistants and intentionally paused lines. Publication
// is a per-assistant action, never a prerequisite for entering the workspace.
export function studioSetupPending(
  business: Pick<Business, 'slug'> | null,
  workspaceReady: boolean,
  assistant: (Pick<Assistant, 'state' | 'name' | 'persona' | 'language'> & { essentials_ready?: number }) | null
): boolean {
  return !business || !workspaceReady || !assistant || (assistant.essentials_ready !== undefined
    ? !assistant.essentials_ready
    : !assistant.name.trim() || !assistant.persona.trim() || !assistant.language.trim());
}
