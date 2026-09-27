import { test, expect } from './fixtures';
import { signup, createWorkspace } from './cleanroom-helpers';
import type { Page, Route } from '@playwright/test';
async function openKnowledge(page: Page) {
  await page.getByRole('button', { name: /What they know/ }).click();
  await page.locator('summary').filter({ hasText: 'Manage collections' }).click();
}
const picker = (page: Page) => page.getByRole('combobox', { name: 'Information collection', exact: true });

for (const operation of [
  'create item',
  'approve item',
  'delete item',
  'collection details',
  'attach assistant',
  'create collection',
  'delete collection',
  'missing collection',
] as const) {
  test(`confirmed knowledge ${operation} survives failed refresh with read-only retry`, async ({ page }) => {
    await signup(page, 'knowledge-refresh');
    const { assistant } = await createWorkspace(page, 'Knowledge refresh workshop');
    const collections = await (await page.request.get('/api/me/knowledge/collections')).json();
    let collection = collections[0];
    if (operation === 'delete collection' || operation === 'missing collection') {
      collection = await (
        await page.request.post('/api/me/knowledge/collections', {
          data: { name: 'Disposable collection', description: '' },
        })
      ).json();
      expect(
        (
          await page.request.post(`/api/me/assistants/${assistant.id}/knowledge-collections/${collection.id}`)
        ).ok(),
      ).toBe(true);
      await page.reload();
    }
    if (operation === 'approve item' || operation === 'delete item')
      expect(
        (
          await page.request.post(`/api/me/knowledge/collections/${collection.id}/items`, {
            data: { kind: 'faq', status: 'draft', question: 'Stored question?', answer: 'Stored answer.' },
          })
        ).ok(),
      ).toBe(true);
    if (operation === 'approve item' || operation === 'delete item') await page.reload();
    await openKnowledge(page);
    await expect(page.getByLabel('Collection name', { exact: true })).toBeVisible();
    if (operation === 'delete collection' || operation === 'missing collection') {
      await picker(page).selectOption(collection.id);
      await expect(page.getByLabel('Collection name', { exact: true })).toHaveValue('Disposable collection');
    }
    let mutations = 0,
      failRead = false;
    await page.route(
      (url) =>
        url.pathname.startsWith('/api/me/knowledge/') ||
        /\/api\/me\/assistants\/[^/]+\/knowledge-collections\//.test(url.pathname),
      async (route) => {
        if (route.request().method() === 'GET') {
          if (failRead) {
            failRead = false;
            return route.fulfill({ status: 503, json: { error: 'Synthetic knowledge refresh unavailable' } });
          }
          return route.continue();
        }
        mutations++;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        failRead = true;
        await route.fulfill({ response });
      },
    );
    page.on('dialog', (d) => d.accept());
    if (operation === 'create item' || operation === 'missing collection') {
      await page.getByRole('button', { name: 'Add business information', exact: true }).click();
      await page.getByLabel('What might a customer ask?').fill('New saved question?');
      await page.getByLabel('The answer', { exact: true }).fill('New saved answer.');
      await page.getByRole('button', { name: 'Save answer', exact: true }).click();
    } else if (operation === 'approve item' || operation === 'delete item') {
      await page.getByRole('button', { name: /Stored question/ }).click();
      if (operation === 'approve item') {
        await page.getByLabel('Use this answer in conversations').check();
        await page.getByRole('button', { name: 'Save answer', exact: true }).click();
      } else await page.getByRole('button', { name: 'Delete', exact: true }).click();
    } else if (operation === 'collection details') {
      await page.getByLabel('Collection name', { exact: true }).fill('Accepted collection name');
      await page.getByRole('button', { name: 'Save collection details', exact: true }).click();
    } else if (operation === 'attach assistant') {
      await page.getByRole('button', { name: 'Remove from receptionist', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Use this collection', exact: true })).toBeVisible();
    } else if (operation === 'create collection') {
      await page.getByLabel('New collection', { exact: true }).fill('Accepted new collection');
      await page.getByRole('button', { name: 'Create collection', exact: true }).click();
    } else await page.getByRole('button', { name: 'Delete collection', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic knowledge refresh unavailable');
    await expect(page.getByRole('button', { name: 'Retry knowledge refresh', exact: true })).toBeVisible();
    expect(mutations).toBe(1);
    if (operation === 'create item' || operation === 'missing collection') {
      await expect(page.getByRole('button', { name: /New saved question/ })).toBeVisible();
      await page.getByRole('button', { name: 'Add business information', exact: true }).click();
      await page.getByLabel('What might a customer ask?').fill('Newer unsaved question?');
    } else if (operation === 'approve item')
      await expect(page.getByRole('button', { name: /Stored question/ })).toContainText('Active');
    else if (operation === 'delete item')
      await expect(page.getByRole('button', { name: /Stored question/ })).toHaveCount(0);
    else if (operation === 'collection details') {
      await expect(page.getByRole('button', { name: 'Save collection details', exact: true })).toBeDisabled();
      await page.getByLabel('Collection name', { exact: true }).fill('Newer collection draft');
    } else if (operation === 'create collection')
      await expect(page.getByLabel('Collection name', { exact: true })).toHaveValue(
        'Accepted new collection',
      );
    if (operation === 'missing collection') {
      expect((await page.request.delete(`/api/me/knowledge/collections/${collection.id}`)).ok()).toBe(true);
      await page.getByRole('button', { name: 'Retry knowledge refresh', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('no longer available');
      await expect(picker(page)).toHaveValue(collection.id);
      await expect(page.getByLabel('What might a customer ask?')).toHaveValue('Newer unsaved question?');
      expect(mutations).toBe(1);
      return;
    }
    await page.getByRole('button', { name: 'Retry knowledge refresh', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry knowledge refresh', exact: true })).toHaveCount(0);
    expect(mutations).toBe(1);
    if (operation === 'create item') {
      await expect(page.getByLabel('What might a customer ask?')).toHaveValue('Newer unsaved question?');
      const detail = await (await page.request.get(`/api/me/knowledge/collections/${collection.id}`)).json();
      expect(
        detail.items.filter((x: { question: string }) => x.question === 'New saved question?'),
      ).toHaveLength(1);
    } else if (operation === 'collection details') {
      await expect(page.getByLabel('Collection name', { exact: true })).toHaveValue('Newer collection draft');
      expect(
        (await (await page.request.get(`/api/me/knowledge/collections/${collection.id}`)).json()).name,
      ).toBe('Accepted collection name');
    }
  });
}

test('initial knowledge list admission prevents creating against an unresolved collection snapshot', async ({
  page,
}) => {
  await signup(page, 'knowledge-initial');
  await createWorkspace(page);
  let held: Route | undefined;
  let creates = 0;
  await page.route('**/api/me/knowledge/collections', (route) => {
    if (route.request().method() === 'GET' && !held) {
      held = route;
      return;
    }
    if (route.request().method() === 'POST') creates++;
    return route.continue();
  });
  try {
    await page.reload();
    await openKnowledge(page);
    await expect.poll(() => !!held).toBe(true);
    await page.getByLabel('New collection', { exact: true }).fill('Accepted new collection');
    await expect(page.getByRole('button', { name: 'Create collection', exact: true })).toBeDisabled();
    expect(creates).toBe(0);
    const route = held!;
    await route.continue();
    await page.unroute('**/api/me/knowledge/collections');
    held = undefined;
    await expect(page.getByRole('button', { name: 'Create collection', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Create collection', exact: true }).click();
    await expect(page.getByLabel('Collection name', { exact: true })).toHaveValue('Accepted new collection');
    expect(
      (await (await page.request.get('/api/me/knowledge/collections')).json()).filter(
        (x: { name: string }) => x.name === 'Accepted new collection',
      ),
    ).toHaveLength(1);
  } finally {
    if (held) await held.abort();
  }
});
