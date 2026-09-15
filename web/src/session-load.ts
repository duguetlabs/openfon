import { api, type BootstrapAssistant, type Bootstrap, type Business, type Me } from './api';
import { compatibilityAssistant } from './session-gate';
import { readLogoutIntent, type IntentRead, type LogoutIntentStorage } from './logout-intent';

type SessionApi = Pick<typeof api, 'me' | 'business' | 'bootstrap'>;

export interface CompatibilitySessionSnapshot {
  me: Me;
  business: Business | null;
  workspaceReady: boolean;
  firstAssistant: BootstrapAssistant | null;
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

export type SignOutRecovery = 'pending' | 'unconfirmed' | 'unknown' | 'local';
export const SIGN_OUT_STORAGE_UNKNOWN_MESSAGE =
  'This tab could not read its sign-out status. Retry sign-out before opening your workspace.';
export const SIGN_OUT_LOCAL_CLEANUP_MESSAGE =
  'Server sign-out succeeded, but this tab could not finish local cleanup. Retry cleanup; no server sign-out will be repeated.';
export class SignOutRecoveryError extends Error {
  constructor(public recovery: Exclude<SignOutRecovery, 'pending'>) {
    super(recovery === 'local' ? SIGN_OUT_LOCAL_CLEANUP_MESSAGE
      : recovery === 'unknown' ? SIGN_OUT_STORAGE_UNKNOWN_MESSAGE : SIGN_OUT_UNCONFIRMED_MESSAGE);
  }
}

export class CompatibilitySessionCoordinator {
  private generation = 0;
  private signOutState: 'idle' | SignOutRecovery = 'idle';
  private intentId: string | null = null;

  constructor(private readonly storage?: LogoutIntentStorage) {
    if (storage) this.adopt(readLogoutIntent(storage));
  }

  private adopt(read: IntentRead): void {
    if (read.kind === 'absent') return;
    this.intentId = read.kind === 'intent' ? read.value.id : null;
    this.signOutState = read.kind === 'unknown' ? 'unknown'
      : read.value.phase === 'confirmed' ? 'local' : 'unconfirmed';
  }

  private blocked(): SignOutRecovery | null {
    if (this.signOutState === 'idle' && this.storage) this.adopt(readLogoutIntent(this.storage));
    return this.signOutState === 'idle' ? null : this.signOutState;
  }

  async refresh(
    load: () => Promise<CompatibilitySessionSnapshot>,
    publish: (snapshot: CompatibilitySessionSnapshot) => void,
    failed: (error: unknown) => void,
    blocked?: (recovery: SignOutRecovery) => void
  ): Promise<void> {
    const initial = this.blocked();
    if (initial) { blocked?.(initial); return; }
    const generation = ++this.generation;
    try {
      const snapshot = await load();
      if (generation !== this.generation) return;
      const recovery = this.blocked();
      if (recovery) blocked?.(recovery);
      else publish(snapshot);
    } catch (error) {
      if (generation !== this.generation) return;
      const recovery = this.blocked();
      if (recovery) blocked?.(recovery);
      else failed(error);
    }
  }

  // This path never performs a server write. A confirmed marker survives a
  // reload if its removal fails; a recreated coordinator can retry only cleanup.
  private finishConfirmed(generation: number, id: string | null): void {
    this.signOutState = 'local';
    if (!this.storage) { this.signOutState = 'idle'; return; }
    const inspect = (): IntentRead => {
      if (generation !== this.generation) throw new SignOutRecoveryError('unconfirmed');
      const read = readLogoutIntent(this.storage!);
      if (read.kind === 'unknown') throw new SignOutRecoveryError('local');
      if (read.kind === 'intent' && read.value.id !== id) {
        // A conflict cannot discard this coordinator's known confirmation.
        // Leave the different owner untouched; live retries only inspect/clean
        // our own intent (or observe that the current owner has cleared it).
        throw new SignOutRecoveryError('local');
      }
      return read;
    };
    let read = inspect();
    if (read.kind === 'intent') {
      // Persist confirmation before removal. If both operations fail, only this
      // coordinator knows the server succeeded; do not pretend that fact was
      // durable. A reload will conservatively see the old unconfirmed marker.
      try { this.storage.write(JSON.stringify({ ...read.value, phase: 'confirmed' })); } catch { /* still attempt owned cleanup */ }
      read = inspect(); // A stale completion must not remove a newer intent.
      if (read.kind === 'intent') {
        try { this.storage.remove(); } catch { throw new SignOutRecoveryError('local'); }
      }
    }
    read = inspect();
    if (read.kind !== 'absent') throw new SignOutRecoveryError('local');
    this.intentId = null;
    this.signOutState = 'idle';
  }

  async signOut(logout: () => Promise<unknown>, callbacks: CompatibilitySignOutCallbacks): Promise<void> {
    const generation = ++this.generation;
    // A different coordinator may have persisted confirmation since this one
    // failed. Reconcile it before deciding whether another server write is needed.
    if (this.signOutState !== 'local' && this.storage) this.adopt(readLogoutIntent(this.storage));
    if (this.signOutState === 'local') {
      callbacks.clearLocal();
      try {
        this.finishConfirmed(generation, this.intentId);
        if (generation === this.generation) callbacks.confirmed();
      } catch (error) {
        if (generation === this.generation) callbacks.failed(error);
        throw error;
      }
      return;
    }
    this.signOutState = 'pending';
    // Keep the observed predecessor as cleanup ownership if atomic setItem
    // fails before replacing it. Never claim an ID that was not persisted.
    let id = this.intentId;
    try {
      if (this.storage) {
        const replacementId = crypto.randomUUID();
        this.storage.write(JSON.stringify({ version: 1, id: replacementId, phase: 'unconfirmed' }));
        id = replacementId;
        this.intentId = id;
      }
    } catch {
      // Memory guards and immediate clearing survive unavailable persistence.
      // No reload-persistence guarantee is possible when this write failed.
    }
    callbacks.clearLocal();
    try {
      await logout();
    } catch (error) {
      if (generation === this.generation) {
        this.signOutState = 'unconfirmed';
        callbacks.failed(error);
      }
      throw error;
    }
    if (generation !== this.generation) return;
    try {
      this.finishConfirmed(generation, id);
      if (generation === this.generation) callbacks.confirmed();
    } catch (error) {
      if (generation === this.generation) callbacks.failed(error);
      throw error;
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
