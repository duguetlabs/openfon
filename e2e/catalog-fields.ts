import { expect, type Page } from '@playwright/test';

export async function fillCatalog(page: Page, label: string, value: string) {
  await page.getByLabel(label, { exact: true }).selectOption('__custom');
  await page.getByLabel(`Custom ${label.toLowerCase()}`, { exact: true }).fill(value);
}
export async function expectCatalog(page: Page, label: string, value: string) {
  await expect.poll(async () => {
    const custom = page.getByLabel(`Custom ${label.toLowerCase()}`, { exact: true });
    const select = page.getByLabel(label, { exact: true });
    if (await custom.count()) return custom.inputValue();
    return await select.count() ? select.inputValue() : undefined;
  }).toBe(value);
}
