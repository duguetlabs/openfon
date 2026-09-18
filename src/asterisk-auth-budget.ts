/** Constant-size per-isolate guard: no caller keys, persistence, or wait queue.
 * This bounds local KDF starts, not aggregate traffic across isolates/restarts. */
export class AsteriskAuthBudget {
  private tokens = 16;
  private updated = Date.now();
  private active = 0;
  acquire(): (() => void) | null {
    const now = Math.max(this.updated, Date.now());
    this.tokens = Math.min(16, this.tokens + (now - this.updated) / 500);
    this.updated = now;
    if (this.active >= 4 || this.tokens < 1) return null;
    this.tokens--; this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
}
export const asteriskAuthBudget = new AsteriskAuthBudget();

// Separate from KDF starts: hold one scalar slot through the whole ingress
// request, including read-only policy checks and a pending owner fetch.
export const asteriskIngressBudget = new AsteriskAuthBudget();
