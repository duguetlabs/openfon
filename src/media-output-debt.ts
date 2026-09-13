/** Sent media/control debt survives local flushes. A returned unpredictable mark
 * proves ordered transport progress; a post-flush barrier proves all earlier
 * writes were consumed/discarded, not that their audio was physically played. */
export class MediaOutputDebt {
  private pending = new Map<string, { sequence: number; barrier: boolean }>();
  private sequence = 0;

  sent(barrier = false, prefix = ''): string {
    // Each entry represents one fixed-size 160-byte media frame + small mark,
    // or a fixed clear/FLUSH_MEDIA + small mark. No variable payload is retained.
    if (this.pending.size >= 500) throw Error('carrier_transport_backpressure');
    const id = prefix + crypto.randomUUID();
    this.pending.set(id, { sequence: ++this.sequence, barrier });
    return id;
  }

  confirm(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return; // duplicate/unknown/old generation cannot free new debt
    if (entry.barrier) {
      for (const [key, value] of this.pending) if (value.sequence <= entry.sequence) this.pending.delete(key);
    } else this.pending.delete(id);
  }
}
