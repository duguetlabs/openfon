/** Per-isolate media lookup budget: 16-start burst, 2 starts/second, at most
 * 4 pending D1 lookups. Constant scalar state; no caller keys or persistence.
 * Restart creates a fresh budget. This is not a distributed/edge rate limit.
 */
export class TelnyxMediaAdmission {
  private tokens = 16;
  private updatedAt = Date.now();
  private pending = 0;

  acquire(): (() => void) | null {
    const now = Date.now();
    if (now > this.updatedAt) {
      this.tokens = Math.min(16, this.tokens + (now - this.updatedAt) / 500);
      this.updatedAt = now;
    }
    if (this.tokens < 1 || this.pending >= 4) return null;
    this.tokens--;
    this.pending++;
    let released = false;
    return () => { if (!released) { released = true; this.pending--; } };
  }
}
