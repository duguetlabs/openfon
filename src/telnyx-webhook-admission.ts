/** Isolate-local admission, not a distributed limit or a transport guarantee.
 * Only this scalar crosses request contexts; promises/readers remain local.
 */
export const TELNYX_WEBHOOK_MAX_PENDING = 16;

export class TelnyxWebhookAdmission {
  private pending = 0;

  acquire(): TelnyxWebhookLease | null {
    if (this.pending >= TELNYX_WEBHOOK_MAX_PENDING) return null;
    const lease = new TelnyxWebhookLease(() => { this.pending--; });
    this.pending++;
    return lease;
  }
}

/** A lost context or failed cleanup can strand capacity until isolate recreation.
 * There is deliberately no TTL, abort shortcut, or cleanup-success assumption.
 */
export class TelnyxWebhookLease {
  private routeDone = false;
  private bodyDone = false;
  private consumeDone = true; // No operation has been started yet.
  private lockReleased = true; // No reader has been acquired yet.
  private cancelFulfilled = true; // Cancellation has not been requested.
  private quarantined = false;
  private released = false;

  constructor(private readonly release: () => void) {}

  readerAcquired(): void { this.lockReleased = false; }
  consumeStarted(): void { this.consumeDone = false; }
  cancellationStarted(): void { this.cancelFulfilled = false; }
  quarantine(): void { this.quarantined = true; }
  readerReleased(): void { this.lockReleased = true; this.maybeRelease(); }
  consumeSettled(): void { this.consumeDone = true; this.maybeRelease(); }
  cancellationFulfilled(): void { this.cancelFulfilled = true; this.maybeRelease(); }
  bodySettled(): void { this.bodyDone = true; this.maybeRelease(); }
  routeSettled(): void { this.routeDone = true; this.maybeRelease(); }

  private maybeRelease(): void {
    if (!this.released && !this.quarantined && this.routeDone && this.bodyDone &&
        this.consumeDone && this.lockReleased && this.cancelFulfilled) {
      this.released = true;
      this.release();
    }
  }
}
