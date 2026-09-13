import { test, expect } from './fixtures';

for (const operation of ['create item', 'approve item', 'delete item', 'collection details', 'attach assistant', 'create collection', 'delete collection', 'missing collection', 'held read'] as const) {
  test(`confirmed knowledge ${operation} survives failed refresh with read-only retry`, async ({ page }) => {
    await page.goto('/auth');
    await page.getByLabel('Email').fill(`knowledge-refresh-${operation.replaceAll(' ', '-')}-${Date.now()}@example.invalid`);
    await page.getByLabel('Password', { exact: true }).fill('Synthetic-Knowledge-Password-1234');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByLabel('Business name', { exact: true }).fill('Knowledge refresh workshop');
    await page.getByLabel('What do you do?').fill('Synthetic knowledge recovery');
    await page.getByRole('button', { name: 'Continue →' }).click();
    await page.getByRole('button', { name: 'Continue →' }).click();
    await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const collections = await (await page.request.get('/api/me/knowledge/collections')).json();
    let collection = collections[0];
    if (operation === 'delete collection' || operation === 'missing collection') collection = await (await page.request.post('/api/me/knowledge/collections', { data: { name: 'Disposable collection', description: '' } })).json();
    if (operation === 'approve item' || operation === 'delete item') {
      expect((await page.request.post(`/api/me/knowledge/collections/${collection.id}/items`, { data: { kind: 'faq', status: 'draft', question: 'Stored question?', answer: 'Stored answer.' } })).ok()).toBe(true);
    }
    let releaseOldRead = () => {};
    let oldReadHeld = false;
    if (operation === 'held read') {
      const held = new Promise<void>(resolve => { releaseOldRead = resolve; });
      await page.route(url => url.pathname === '/api/me/knowledge/collections', async route => {
        if (route.request().method() === 'GET' && !oldReadHeld) {
          oldReadHeld = true;
          const response = await route.fetch();
          await held;
          await route.fulfill({ response });
        } else await route.continue();
      });
    }
    await page.goto('/knowledge');
    if (operation !== 'held read') await expect(page.getByLabel('Collection name', { exact: true })).toBeVisible();
    else await expect.poll(() => oldReadHeld).toBe(true);
    if (operation === 'delete collection' || operation === 'missing collection') {
      await page.getByRole('combobox').first().selectOption(collection.id);
      await expect(page.getByLabel('Collection name', { exact: true })).toHaveValue('Disposable collection');
    }
    let mutations = 0;
    let failRead = false;
    await page.route(url => url.pathname.startsWith('/api/me/knowledge/') || /\/api\/me\/assistants\/[^/]+\/knowledge-collections\//.test(url.pathname), async route => {
      if (route.request().method() === 'GET') {
        // Exercise detail failure separately from collection-list failure.
        if (failRead && (operation !== 'approve item' || route.request().url().includes(`/collections/${collection.id}`))) {
          failRead = false;
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic refresh unavailable' }) });
        }
        return route.fallback();
      }
      mutations++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      failRead = true;
      await route.fulfill({ response });
    });
    page.on('dialog', dialog => dialog.accept());
    if (operation === 'create item' || operation === 'missing collection') {
      await page.getByRole('button', { name: 'Add knowledge', exact: true }).click();
      await page.getByLabel('Question', { exact: true }).fill('New saved question?');
      await page.getByLabel('Answer', { exact: true }).fill('New saved answer.');
      await page.getByRole('button', { name: 'Save knowledge', exact: true }).click();
    } else if (operation === 'approve item') await page.getByRole('button', { name: 'Approve', exact: true }).click();
    else if (operation === 'delete item') await page.getByRole('button', { name: 'Delete', exact: true }).click();
    else if (operation === 'collection details') {
      await page.getByLabel('Collection name', { exact: true }).fill('Accepted collection name');
      await page.getByRole('button', { name: 'Save collection details', exact: true }).click();
    } else if (operation === 'attach assistant') {
      const check = page.getByRole('checkbox').first();
      const initial = await check.isChecked();
      await check.click();
      await expect(check).toBeChecked({ checked: !initial });
    } else if (operation === 'create collection' || operation === 'held read') {
      await page.getByLabel('New collection', { exact: true }).fill('Accepted new collection');
      await page.getByRole('button', { name: 'Create collection', exact: true }).click();
    } else await page.getByRole('button', { name: 'Delete collection', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Your changes were saved, but knowledge could not be refreshed.' })).toBeVisible();
    expect(mutations).toBe(1);
    if (operation === 'held read') {
      const acceptedId = await page.getByRole('combobox').first().inputValue();
      await expect(page.getByLabel('Collection name', { exact: true })).toHaveValue('Accepted new collection');
      releaseOldRead();
      // The initial load's finally runs only after the held response is consumed.
      await expect(page.getByText('Loading workspace data…', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('combobox').first()).toHaveValue(acceptedId);
      await expect(page.getByLabel('Collection name', { exact: true })).toHaveValue('Accepted new collection');
    }
    if (operation === 'create item' || operation === 'missing collection') {
      await expect(page.getByRole('heading', { name: 'New saved question?', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save knowledge', exact: true })).toHaveCount(0);
      await expect(page.getByRole('combobox').first().locator('option:checked')).toContainText('(1 item)');
      await page.getByRole('button', { name: 'Add knowledge', exact: true }).click();
      await page.getByLabel('Question', { exact: true }).fill('Newer unsaved question?');
    } else if (operation === 'approve item') await expect(page.getByRole('button', { name: 'Unpublish', exact: true })).toBeVisible();
    else if (operation === 'delete item') await expect(page.getByRole('heading', { name: 'Stored question?', exact: true })).toHaveCount(0);
    else if (operation === 'collection details') {
      await expect(page.getByRole('button', { name: 'Save collection details', exact: true })).toBeDisabled();
      await page.getByLabel('Collection name', { exact: true }).fill('Newer collection draft');
    } else if (operation === 'create collection') await expect(page.getByLabel('Collection name', { exact: true })).toHaveValue('Accepted new collection');
    else if (operation === 'delete collection') await expect(page.getByRole('button', { name: 'Delete collection', exact: true })).toHaveCount(0);
    if (operation === 'missing collection') {
      expect((await page.request.delete(`/api/me/knowledge/collections/${collection.id}`)).ok()).toBe(true);
      await page.getByRole('button', { name: 'Retry knowledge refresh', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'The selected collection is no longer available' })).toBeVisible();
      await expect(page.getByRole('combobox').first()).toHaveValue(collection.id);
      await expect(page.getByLabel('Question', { exact: true })).toHaveValue('Newer unsaved question?');
      expect(mutations).toBe(1);
      return;
    }
    await page.getByRole('button', { name: 'Retry knowledge refresh', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry knowledge refresh', exact: true })).toHaveCount(0);
    expect(mutations).toBe(1);
    if (operation === 'create item' || operation === 'missing collection') {
      await expect(page.getByLabel('Question', { exact: true })).toHaveValue('Newer unsaved question?');
      const stored = await (await page.request.get(`/api/me/knowledge/collections/${collection.id}`)).json();
      expect(stored.items.filter((item: { question: string }) => item.question === 'New saved question?')).toHaveLength(1);
    } else if (operation === 'collection details') {
      await expect(page.getByLabel('Collection name', { exact: true })).toHaveValue('Newer collection draft');
      await expect(page.getByRole('button', { name: 'Save collection details', exact: true })).toBeEnabled();
      expect((await (await page.request.get(`/api/me/knowledge/collections/${collection.id}`)).json()).name).toBe('Accepted collection name');
    }
  });
}
