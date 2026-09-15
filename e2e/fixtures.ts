import { test as base, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Local workerd accepts this edge header. Isolate every test/retry limiter
// bucket while preserving the production limits and real signup endpoint.
export const test = base.extend<{ limiterIsolation: void }>({
  limiterIsolation: [async ({ context }, use) => {
    await context.setExtraHTTPHeaders({ 'CF-Connecting-IP': `e2e-${randomUUID()}` });
    await use();
  }, { auto: true }],
});
export { expect };
