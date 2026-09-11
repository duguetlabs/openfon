import { api, type Assistant, type Bootstrap, type Business, type Me } from './api';
import { compatibilityAssistant } from './session-gate';

type SessionApi = Pick<typeof api, 'me' | 'business' | 'bootstrap'>;

export interface CompatibilitySessionSnapshot {
  me: Me;
  business: Business | null;
  workspaceReady: boolean;
  firstAssistant: Assistant | null;
  firstAssistantReady: boolean;
}

export const SIGN_OUT_UNCONFIRMED_MESSAGE =
  'This screen was cleared, but server sign-out was not confirmed. Retry sign-out before leaving this device.';

export const SIGN_OUT_PENDING_MESSAGE =
  'Confirming server sign-out. Sign in and account creation are temporarily unavailable.';

export function authSubmissionBlocked(signOutPending: boolean, signOutUnconfirmed = false): boolean {
  return signOutPending || signOutUnconfirmed;
}

export interface CompatibilitySignOutCallbacks {
  clearLocal: () => void;
  confirmed: () => void;
  failed: (error: unknown) => void;
}

export class CompatibilitySessionCoordinator {
  private generation = 0;
  private signOutState: 'idle' | 'pending' | 'unconfirmed' = 'idle';

  async refresh(
    load: () => Promise<CompatibilitySessionSnapshot>,
    publish: (snapshot: CompatibilitySessionSnapshot) => void,
    clear: () => void
  ): Promise<void> {
    // A cookie-backed load started after local sign-out could still authenticate
    // until the server response clears that cookie. Do not even issue it: a
    // generation check can suppress an older load, but cannot make a newer load
    // safe while logout is unresolved.
    if (this.signOutState !== 'idle') return;
    const generation = ++this.generation;
    try {
      const snapshot = await load();
      if (generation === this.generation) publish(snapshot);
    } catch {
      // A superseded failure must not sign out a newer successful session.
      if (generation === this.generation) clear();
    }
  }

  async signOut(logout: () => Promise<unknown>, callbacks: CompatibilitySignOutCallbacks): Promise<void> {
    // Invalidate first, then clear local private data, and only then start the
    // request. A slow refresh or logout response can never repopulate the shell.
    const generation = ++this.generation;
    this.signOutState = 'pending';
    callbacks.clearLocal();
    try {
      await logout();
    } catch (error) {
      if (generation === this.generation) {
        // The HttpOnly cookie may still be valid. Keep background refreshes
        // latched off until a retry confirms that server sign-out completed.
        this.signOutState = 'unconfirmed';
        callbacks.failed(error);
      }
      throw error;
    }
    if (generation === this.generation) {
      this.signOutState = 'idle';
      callbacks.confirmed();
    }
  }
}

// Load the compatibility view as one snapshot. In particular, callers must not
// publish `me` while the workspace requests are still pending: doing so mounts
// onboarding with empty one-shot form state during sign-in recovery.
export async function loadCompatibilitySession(client: SessionApi = api): Promise<CompatibilitySessionSnapshot> {
  const me = await client.me();
  // Keep these ordered because both endpoints may run compatibility repairs for
  // a partially-created workspace.
  const business = await client.business();
  const bootstrap = await client.bootstrap();
  return {
    me,
    business,
    workspaceReady: bootstrap.setup.workspace,
    firstAssistant: compatibilityAssistant(business, bootstrap.assistants),
    firstAssistantReady: bootstrap.setup.firstAssistant,
  };
}
