import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/** Navigate through the mounted Brand Identity app rather than retired routes. */
export async function openAuth(page: Page, mode: 'signup' | 'login' = 'signup') {
  await page.goto('/');
  await page.getByRole('button', { name: mode === 'signup' ? 'Create your receptionist' : 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Email address')).toBeVisible();
}

export async function signup(page: Page, label = 'browser', password = 'Synthetic-Confirmation-Password-1234') {
  const email = `${label}-${randomUUID()}@example.invalid`;
  await openAuth(page);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByLabel('Business name', { exact: true })).toBeVisible();
  return { email, password };
}

export async function createWorkspace(page: Page, name = 'Browser validation workshop') {
  await page.getByLabel('Business name', { exact: true }).fill(name);
  await page.getByLabel('What do you do?').fill('Synthetic local browser validation.');
  await page.getByRole('button', { name: 'Meet your receptionist', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeVisible();
  const boot = await (await page.request.get('/api/me/bootstrap')).json();
  return { business: boot.workspace, assistant: boot.assistants[0] };
}

export async function workspaceMenu(page: Page, action: string) {
  if(action === 'Connections & portability') { await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Call logs',exact:true}).click(); return; }
  const menu = page.getByRole('banner').locator('.of-workspace-menu');
  if (!(await menu.getByRole('button', { name: action, exact: true }).isVisible())) {
    await page.locator('.of-workspace-button').click();
  }
  await menu.getByRole('button', { name: action, exact: true }).click();
}

export async function signOut(page: Page) { await workspaceMenu(page, 'Sign out'); }
export async function connections(page: Page) {
  await workspaceMenu(page, 'Connections & portability');
  await expect(page.getByRole('heading', { name: 'Call logs', exact: true })).toBeVisible();
}
export async function whoAnswers(page: Page) {
  const trigger = page.getByRole('button', { name: /Who answers/ });
  await trigger.waitFor({state:'visible'});
  if (!(await page.getByLabel('Receptionist name', { exact: true }).isVisible())) await trigger.click();
  await expect(page.getByLabel('Receptionist name', {exact:true})).toBeVisible();
}
