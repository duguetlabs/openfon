import { test, expect } from './fixtures';
import { signup, createWorkspace, whoAnswers } from './cleanroom-helpers';

for (const operation of ['save', 'publish', 'pause'] as const) {
  test(`acknowledged assistant ${operation} preserves state and never repeats a mutation during read recovery`, async ({
    page,
  }) => {
    await signup(page, `assistant-${operation}`);
    const { assistant } = await createWorkspace(page, 'Assistant refresh workshop');
    const path = `/api/me/assistants/${assistant.id}`;
    expect(
      (
        await page.request.put(path, {
          data: {
            name: 'Ada',
            persona: 'Warm and concise',
            greeting: 'Saved original greeting.',
            engine: 'pipeline',
          },
        })
      ).ok(),
    ).toBe(true);
    if (operation === 'pause') expect((await page.request.post(`${path}/activate`)).ok()).toBe(true);
    await page.reload();
    await whoAnswers(page);
    let mutations = 0,
      failReads = false;
    await page.route(
      (url) => url.pathname === path || url.pathname.startsWith(path + '/'),
      async (route) => {
        if (route.request().method() === 'GET') {
          if (failReads)
            return route.fulfill({ status: 503, json: { error: 'Synthetic assistant refresh unavailable' } });
          return route.continue();
        }
        mutations++;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        failReads = true;
        await route.fulfill({ response });
      },
    );
    if (operation === 'save') {
      await page.getByLabel('Their first words').fill('Saved changed greeting.');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(page.getByText('Saved. Your next conversation will use this brief.')).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
    } else {
      await page
        .getByRole('button', {
          name: operation === 'publish' ? 'Enable web calls' : 'Pause web calls',
          exact: true,
        })
        .click();
      await expect(page.getByRole('alert')).toContainText('Synthetic assistant refresh unavailable');
      await expect(
        page.getByRole('button', {
          name: operation === 'publish' ? 'Pause web calls' : 'Enable web calls',
          exact: true,
        }),
      ).toBeDisabled();
    }
    expect(mutations).toBe(1);
    await page.getByLabel('Their first words').fill('Newer unsaved greeting.');
    if (operation !== 'save') {
      failReads = false;
      await page.getByRole('button', { name: 'Retry assistant refresh', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Retry assistant refresh', exact: true })).toHaveCount(0);
    }
    await expect(page.getByLabel('Their first words')).toHaveValue('Newer unsaved greeting.');
    expect(mutations).toBe(1);
    const saved = await (await page.request.get(path)).json();
    expect(saved.state).toBe(operation === 'publish' ? 'active' : operation === 'pause' ? 'paused' : 'draft');
    expect(saved.greeting).toBe(
      operation === 'save' ? 'Saved changed greeting.' : 'Saved original greeting.',
    );
  });
}
