import { describe, expect, it } from 'vitest';
import { MediaOutputDebt } from '../src/media-output-debt';

describe('carrier transport progress across playback flushes', () => {
  it('fails closed after bounded writes without returned unpredictable markers', () => {
    const debt = new MediaOutputDebt();
    const ids = Array.from({ length: 500 }, (_, i) => debt.sent(i % 2 === 0));
    expect(new Set(ids).size).toBe(500);
    expect(() => debt.sent()).toThrow('carrier_transport_backpressure');
    debt.confirm('forged');
    expect(() => debt.sent()).toThrow('carrier_transport_backpressure');
    debt.confirm(ids[1]);
    expect(debt.sent()).toBeTypeOf('string');
  });
  it('a post-flush barrier frees only its preceding writes and cannot be replayed', () => {
    const debt = new MediaOutputDebt();
    const old = debt.sent(), barrier = debt.sent(true);
    for (let i = 0; i < 498; i++) debt.sent();
    debt.confirm(barrier);
    debt.sent(); debt.sent();
    debt.confirm(old); debt.confirm(barrier);
    expect(() => debt.sent()).toThrow('carrier_transport_backpressure');
  });
});
