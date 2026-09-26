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

// Tests of existing settings behavior explicitly reveal the new component
// disclosures. The information-architecture test verifies their closed defaults.
export async function openSettingsSections(page: import('@playwright/test').Page) {
  if (new URL(page.url()).pathname !== '/settings') return;
  await expect(page.locator('#providers')).toBeVisible();
  for (const disclosure of await page.locator('#providers details, #saved-voice-setups').all()) {
    if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').first().click();
  }
}
