import { test, expect } from './fixtures';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const screenshots = '/tmp/openfon-engagement-qa';

test('guest story links the business brief to an answer and callback without starting a call', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', request => {
    if (!['GET', 'HEAD'].includes(request.method()) && request.url().includes('/api/')) writes.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A warm welcome. A clear next step.', level: 1 })).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(1);
  const story = page.getByRole('region', { name: 'How OpenFon works' });
  await expect(story.getByText('Illustrative example', { exact: true })).toBeVisible();
  await expect(story.getByText('The business brief', { exact: true })).toBeVisible();
  const image = story.getByRole('img', { name: /A bicycle mechanic keeps working/ });
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/welcome-desktop.png`, fullPage: true, animations: 'disabled' });
  const next = story.getByRole('button', { name: 'See how it answers' });
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(story.getByRole('button', { name: /The conversation OpenFon handles the hello/ })).toBeFocused();
  await expect(story.getByText('Saturday, 9am–1pm', { exact: true })).toBeVisible();
  await expect(story.getByText(/we’re open Saturday from 9am to 1pm/)).toBeVisible();
  await story.getByRole('button', { name: 'See the message' }).focus();
  await page.keyboard.press('Space');
  await expect(story.getByRole('button', { name: /Your follow-up You get the next step/ })).toBeFocused();
  await expect(story.getByRole('heading', { name: 'Alex would like a call back.' })).toBeVisible();
  await expect(story.getByText('Example message · no real call was made')).toBeVisible();
  await page.screenshot({ path: `${screenshots}/welcome-message.png`, fullPage: true, animations: 'disabled' });
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Create your receptionist', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
  await page.getByRole('button', { name: 'About OpenFon' }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  expect(writes).toEqual([]);
});

test('mobile story remains readable and controllable with reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const story = page.getByRole('region', { name: 'How OpenFon works' });
  const work = story.getByRole('button', { name: /Your work You keep doing your thing/ });
  await expect(work).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('video, audio').count()).toBe(0);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/welcome-mobile.png`, fullPage: true, animations: 'disabled' });
  for (const [index, name] of ['Your work You keep doing your thing', 'The conversation OpenFon handles the hello', 'Your follow-up You get the next step'].entries()) {
    const step = story.getByRole('button', { name: new RegExp(name) });
    await step.focus();
    await page.keyboard.press('Enter');
    await expect(step).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.of-story-scene').evaluate(element => [...element.querySelectorAll('*')].every(child => getComputedStyle(child).animationName === 'none' && getComputedStyle(child).transitionDuration === '0s'))).toBe(true);
    await page.screenshot({ path: `${screenshots}/mobile-step-${index + 1}.png`, fullPage: true, animations: 'disabled' });
  }
  await expect(story.getByText('Example message · no real call was made')).toBeVisible();
  await page.getByRole('button', { name: 'Create your receptionist', exact: true }).click();
  await expect(page.getByLabel('Email address')).toBeVisible();
});

test('returning owner can dismiss the introduction and revisit the story without losing an unsaved brief', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  expect((await page.request.post('/api/auth/signup', { data: { email: `story-${randomUUID()}@example.test`, password: 'Local-only-fixture-2026' } })).ok()).toBeTruthy();
  expect((await page.request.post('/api/me/business', { data: { name: 'Harbour Bicycle Workshop', description: 'Bicycle repairs.' } })).ok()).toBeTruthy();
  const boot = await (await page.request.get('/api/me/bootstrap')).json();
  expect((await page.request.put(`/api/me/assistants/${boot.assistants[0].id}`, { data: { name: 'Ada', greeting: 'Hello from Harbour.', engine: 'pipeline' } })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'More time for your business.' })).toBeVisible();
  const start = page.getByRole('button', { name: 'Start browser conversation' });
  await expect(start).toBeEnabled();
  const bounds = await start.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800);
  await expect(page.getByRole('button', { name: 'Messages', exact: true })).toBeVisible();
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/desk-desktop.png`, fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Hide introduction' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'A good first hello.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide introduction' })).toHaveCount(0);
  await page.getByRole('button', { name: /Who answers/ }).click();
  await page.getByLabel('Their first words').fill('Unsaved welcome retained while declining navigation.');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'How it works', exact: true }).click();
  await expect(page.getByLabel('Their first words')).toHaveValue('Unsaved welcome retained while declining navigation.');
  await page.getByLabel('Their first words').fill('Hello from Harbour.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /Harbour Bicycle Workshop/ }).click();
  await page.getByRole('button', { name: 'How OpenFon works', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A warm welcome. A clear next step.', level: 1 })).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(1);
  await page.getByRole('button', { name: 'Back to your desk', exact: true }).click();
  await expect(start).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
