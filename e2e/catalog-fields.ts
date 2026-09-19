import { expect, type Page } from '@playwright/test';

export async function fillCatalog(page: Page, label: string, value: string) {
  await page.getByLabel(label, { exact: true }).selectOption('__custom');
  await page.getByLabel(`Custom ${label.toLowerCase()}`, { exact: true }).fill(value);
}
export async function expectCatalog(page: Page, label: string, value: string) {
  await expect.poll(async () => {
    const custom = page.getByLabel(`Custom ${label.toLowerCase()}`, { exact: true });
    const select = page.getByLabel(label, { exact: true });
    // Read one current DOM snapshot; provider loading may replace a custom
    // input with a known select between polls. Do not wait on a removed input.
    const customValue = await custom.evaluateAll(nodes => (nodes[0] as HTMLInputElement | undefined)?.value);
    return customValue ?? await select.evaluateAll(nodes => (nodes[0] as HTMLSelectElement | undefined)?.value);
  }).toBe(value);
}
