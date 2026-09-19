import { test, expect } from './fixtures';

test('business examples preview without mutation and replace only instructions after confirmation and Save', async ({ page }) => {
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`examples-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Examples-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByLabel('Business name', { exact: true })).toHaveAttribute('placeholder', 'Zahnarztpraxis Dr. Gruber');
  await page.getByLabel('Business name', { exact: true }).fill('Example workshop');
  await page.getByLabel('What do you do?').fill('Synthetic prompt example validation');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page).toHaveURL('/overview');
  const { assistants } = await (await page.request.get('/api/me/bootstrap')).json();
  const id = assistants[0].id;
  const saved = await page.request.put(`/api/me/assistants/${id}`, { data: { name: 'Example assistant', persona: 'Friendly receptionist', language: 'de', greeting: 'My existing greeting.', custom_instructions: 'Keep my existing instructions.' } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const before = await (await page.request.get(`/api/me/assistants/${id}`)).json();
  await page.goto(`/assistants/${id}`);
  await page.getByText('Example prompts · Deutsch & English', { exact: true }).click();
  const picker = page.getByLabel('Business example', { exact: true });
  await expect(picker.locator('option')).toHaveCount(4);
  for (const id of ['dental-de', 'salon-de', 'cafe-en', 'repair-en']) {
    await picker.selectOption(id);
    await expect(page.getByLabel('Example instructions')).toHaveAttribute('lang', id.endsWith('-de') ? 'de' : 'en');
    await expect(page.getByLabel('Additional instructions', { exact: true })).toHaveValue('Keep my existing instructions.');
  }
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Use this prompt', exact: true }).click();
  await expect(page.getByLabel('Additional instructions', { exact: true })).toHaveValue('Keep my existing instructions.');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Use this prompt', exact: true }).click();
  const expected = await page.getByLabel('Example instructions').inputValue();
  await expect(page.getByLabel('Additional instructions', { exact: true })).toHaveValue(expected);
  expect((await (await page.request.get(`/api/me/assistants/${id}`)).json()).custom_instructions).toBe(before.custom_instructions);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Assistant saved.', { exact: true })).toBeVisible();
  const after = await (await page.request.get(`/api/me/assistants/${id}`)).json();
  expect(after.custom_instructions).toBe(expected);
  for (const key of ['name', 'persona', 'greeting', 'language', 'engine', 'voice', 'realtime_voice', 'realtime_model', 'llm_model', 'take_messages', 'state']) {
    expect(after[key]).toEqual(before[key]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
