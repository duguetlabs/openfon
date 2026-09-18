/** Short-lived, constant-size CPU admission.
 * A successful rotation performs two sequential KDFs (verify and new hash).
 * No account/session/IP keys or persistence: a copied cookie cannot create a 15-minute revocation lockout.
 * Isolate saturation can briefly refuse requests; this is not distributed
 * protection or a guarantee of availability during a denial-of-service. */
export class AccountAuthBudget {
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
export const accountAuthBudget = new AccountAuthBudget();
