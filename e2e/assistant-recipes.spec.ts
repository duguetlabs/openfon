import { signup, createWorkspace, connections, whoAnswers } from './cleanroom-helpers';
import { test, expect } from './fixtures';
import { exportAssistantRecipe } from '../web/src/assistant-config';

test('assistant recipes review before applying, save through the normal API and preserve destination ownership', async ({ page }) => {
  await signup(page, 'recipe');
  await createWorkspace(page, 'Recipe destination');
  await whoAnswers(page);
  await page.getByLabel('Receptionist name', { exact: true }).fill('Recipe receptionist');
  await page.getByLabel('Tone and personality').fill('Warm and concise');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Saved. Your next conversation will use this brief.')).toBeVisible();
  const { assistants } = await (await page.request.get('/api/me/bootstrap')).json();
  const id = assistants[0].id;
  const initial = await (await page.request.get(`/api/me/assistants/${id}`)).json();
  const providers = await (await page.request.get('/api/me/provider')).json();
  await connections(page);
  const transfer = page;

  const downloadPromise = page.waitForEvent('download');
  await transfer.getByRole('button', { name: 'Export recipe' }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(exported.assistant.name).toBe(initial.name);
  expect(exported.assistant).not.toHaveProperty('id');
  expect(exported.assistant).not.toHaveProperty('collectionIds');
  expect(exported.assistant).not.toHaveProperty('realtime_api_key');

  const incoming = { ...initial, name: 'Imported receptionist', greeting: 'A portable greeting.',
    persona: 'Helpful imported receptionist', custom_instructions: 'Ask for callback details.',
    language: 'de', engine: 'pipeline', llm_model: 'different/model', realtime_model: 'gpt-live-1', realtime_voice: 'marin' };
  const recipe = exportAssistantRecipe(incoming);
  const file = (text: string) => ({ name: 'assistant.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await transfer.getByLabel('Import recipe').setInputFiles(file(JSON.stringify({ ...JSON.parse(recipe), apiKey: 'must-not-import' })));
  await expect(transfer.getByRole('alert')).toContainText('fields do not match');
  await expect(transfer.getByRole('button', { name: 'Save this recipe' })).toHaveCount(0);

  await transfer.getByLabel('Import recipe').setInputFiles(file(recipe));
  await expect(page.locator('.of-import-review')).toContainText('A portable greeting.');
  expect(await (await page.request.get(`/api/me/assistants/${id}`)).json()).toMatchObject({ name: initial.name, engine: initial.engine });
  await transfer.getByLabel('Also replace language, engine and voice settings').uncheck();
  await transfer.getByRole('button', { name: 'Save this recipe' }).click();
  await expect(page.getByText('Recipe imported into this receptionist.', { exact: true })).toBeVisible();
  const saved = await (await page.request.get(`/api/me/assistants/${id}`)).json();
  expect(saved).toMatchObject({
    id, business_id: initial.business_id, public_slug: initial.public_slug, state: initial.state,
    collectionIds: initial.collectionIds, name: incoming.name, greeting: incoming.greeting,
    language: initial.language, engine: initial.engine, realtime_model: initial.realtime_model,
    realtime_voice: initial.realtime_voice, llm_model: initial.llm_model,
  });
  expect(await (await page.request.get('/api/me/provider')).json()).toEqual(providers);
  await page.reload();
  await page.getByRole('button',{name:'Back to your desk'}).click();
  await whoAnswers(page);
  await expect(page.getByLabel('Receptionist name', { exact: true })).toHaveValue('Imported receptionist');
});
