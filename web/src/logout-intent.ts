// UI recovery state only: never store a cookie, account identity or credential.
export const LOGOUT_INTENT_KEY = 'openfon.logout-intent.v1';
export interface LogoutIntentStorage {
  read(): string | null;
  write(value: string): void;
  remove(): void;
}
export interface LogoutIntent {
  version: 1;
  id: string;
  phase: 'unconfirmed' | 'confirmed';
}
export type IntentRead = { kind: 'absent' } | { kind: 'unknown' } | { kind: 'intent'; value: LogoutIntent };

export const browserLogoutIntentStorage: LogoutIntentStorage = {
  read: () => window.sessionStorage.getItem(LOGOUT_INTENT_KEY),
  write: value => window.sessionStorage.setItem(LOGOUT_INTENT_KEY, value),
  remove: () => window.sessionStorage.removeItem(LOGOUT_INTENT_KEY),
};

export function readLogoutIntent(storage: LogoutIntentStorage): IntentRead {
  try {
    const raw = storage.read();
    if (raw === null) return { kind: 'absent' };
    if (raw.length > 160) return { kind: 'unknown' };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unknown' };
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length !== 3 || item.version !== 1 || typeof item.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id) ||
        (item.phase !== 'unconfirmed' && item.phase !== 'confirmed')) return { kind: 'unknown' };
    return { kind: 'intent', value: item as unknown as LogoutIntent };
  } catch {
    return { kind: 'unknown' };
  }
}
