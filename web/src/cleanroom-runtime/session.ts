// Reuse the audited, presentation-independent logout/deletion state machine.
// Its generic snapshot lets the new UI load its own bootstrap contract.
export {
  CompatibilitySessionCoordinator as SessionCoordinator,
  SIGN_OUT_PENDING_MESSAGE,
  SIGN_OUT_UNCONFIRMED_MESSAGE,
  SIGN_OUT_STORAGE_UNKNOWN_MESSAGE,
  SIGN_OUT_LOCAL_CLEANUP_MESSAGE,
  SignOutRecoveryError,
} from '../session-load';
export type { SignOutRecovery } from '../session-load';
export { browserLogoutIntentStorage } from '../logout-intent';
