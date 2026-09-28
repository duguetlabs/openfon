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
  await page.locator('.of-workspace-button, #providers').first().waitFor();
  if (await page.locator('.of-workspace-button').count() && !(await page.locator('.of-brand-connections').count())) {
    await page.locator('.of-workspace-button').click();
    await page.getByRole('button', { name: 'Connections & portability', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save connections', exact: true })).toBeVisible();
  }
  if (await page.locator('.of-brand-connections').count()) {
    // The screen shell mounts before provider data and its disclosures arrive.
    await expect(page.getByRole('button', { name: 'Save connections', exact: true })).toBeVisible();
    for (const disclosure of await page.locator('.of-brand-connections details').all()) {
      if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').first().click();
    }
    return;
  }
  if (new URL(page.url()).pathname !== '/settings') return;
  await expect(page.locator('#providers')).toBeVisible();
  for (const disclosure of await page.locator('#providers details, #saved-voice-setups').all()) {
    if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').first().click();
  }
}

export async function openAssistantAdvanced(page: import('@playwright/test').Page) {
  if (!/^\/assistants\/[^/]+$/.test(new URL(page.url()).pathname)) return;
  const summary = page.locator('summary').filter({ hasText: 'Advanced: AI model & connection' });
  await expect(summary).toBeVisible();
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
}
