import { signup, createWorkspace, workspaceMenu } from './cleanroom-helpers';
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

async function openBusiness(page: Page, label: string) {
  await signup(page, `settings-${label}`);
  const context = await createWorkspace(page, 'Read order workshop');
  await workspaceMenu(page,'Business details');
  await expect(page.getByLabel('Business name',{exact:true})).toHaveValue('Read order workshop');
  return context;
}

test('failed business save retains the draft and retries only the business mutation', async ({page}) => {
  const {business} = await openBusiness(page,'write');
  let writes=0, assistantWrites=0;
  await page.route('**/api/me/**', async route => {
    const request=route.request(), path=new URL(request.url()).pathname;
    if (request.method()==='PUT' && (path.endsWith('/agent') || path.includes('/assistants/'))) assistantWrites++;
    if (path===`/api/me/business/${business.id}` && request.method()==='PUT' && ++writes===1) return route.fulfill({status:503,json:{error:'Synthetic business interruption'}});
    return route.continue();
  });
  await page.getByLabel('Business name',{exact:true}).fill('Confirmed business');
  await page.getByRole('button',{name:'Save business details',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic business interruption');
  await expect(page.getByLabel('Business name',{exact:true})).toHaveValue('Confirmed business');
  expect(writes).toBe(1); expect(assistantWrites).toBe(0);
  await page.getByRole('button',{name:'Save business details',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start browser conversation'})).toBeVisible();
  expect(writes).toBe(2); expect(assistantWrites).toBe(0);
  const persisted=await (await page.request.get('/api/me/business')).json();
  expect(persisted.name).toBe('Confirmed business');
});

test('acknowledged business save uses its confirmed baseline without a redundant failing read', async ({page}) => {
  const {business} = await openBusiness(page,'ack');
  let writes=0, reads=0;
  await page.route('**/api/me/business*', async route => {
    if (route.request().method()==='GET') { reads++; return route.fulfill({status:503,json:{error:'Unnecessary read unavailable'}}); }
    return route.continue();
  });
  await page.route(`**/api/me/business/${business.id}`,async route => { if(route.request().method()==='PUT') writes++; return route.continue(); });
  await page.getByLabel('Business name',{exact:true}).fill('Confirmed without refresh');
  await page.getByRole('button',{name:'Save business details',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start browser conversation'})).toBeVisible();
  await workspaceMenu(page,'Business details');
  await expect(page.getByLabel('Business name',{exact:true})).toHaveValue('Confirmed without refresh');
  await expect(page.getByRole('button',{name:'Save business details',exact:true})).toBeDisabled();
  expect(writes).toBe(1); expect(reads).toBe(0);
});

for (const outcome of ['success','failure'] as const) test(`pending business ${outcome} preserves edits typed after submission`, async ({page}) => {
  const {business}=await openBusiness(page,outcome);
  let release!:()=>void; const gate=new Promise<void>(r=>{release=r}); let pending=false,writes=0;
  await page.route(`**/api/me/business/${business.id}`,async route=>{
    if(route.request().method()!=='PUT') return route.continue();
    writes++; const response=outcome==='success'?await route.fetch():null; pending=true; await gate;
    return response?route.fulfill({response}):route.fulfill({status:503,json:{error:'Synthetic pending refusal'}});
  });
  try {
    await page.getByLabel('Business name',{exact:true}).fill('Submitted business');
    await page.getByRole('button',{name:'Save business details',exact:true}).click();
    await expect.poll(()=>pending).toBe(true);
    await page.getByRole('textbox',{name:'What you do',exact:true}).fill('Newer unsaved description');
    await expect(page.getByRole('button',{name:'Saving…',exact:true})).toBeDisabled();
    const dialog=page.waitForEvent('dialog'); const leave=workspaceMenu(page,'Connections & portability');
    await (await dialog).dismiss(); await leave;
    await page.getByRole('button',{name:'Close menu',exact:true}).click();
    release();
    if(outcome==='success') await expect(page.getByText('Business details saved.',{exact:true})).toBeVisible();
    else await expect(page.getByRole('alert')).toContainText('Synthetic pending refusal');
    await expect(page.getByLabel('Business name',{exact:true})).toHaveValue('Submitted business');
    await expect(page.getByRole('textbox',{name:'What you do',exact:true})).toHaveValue('Newer unsaved description');
    await expect(page.getByRole('button',{name:'Save business details',exact:true})).toBeEnabled();
    const saved=await(await page.request.get('/api/me/business')).json();
    expect(saved.name).toBe(outcome==='success'?'Submitted business':'Read order workshop');
    expect(saved.description).not.toBe('Newer unsaved description'); expect(writes).toBe(1);
  } finally {release();}
});

test('saving a contact edit preserves untouched historical business JSON and assistant configuration', async ({page})=>{
  await signup(page,'settings-rows'); const {business}=await createWorkspace(page,'Historical workshop');
  const rows={hours_json:'[{"day":"Monday","open":"09:00","close":"17:00","legacy":"keep"}]',services_json:'[{"name":"Repair","price":"€40","legacy":"keep"}]',faqs_json:'[{"q":"Parking?","a":"Outside","legacy":"keep"}]',closures_json:'[{"date":"2026-12-25","reason":"Holiday","legacy":"keep"}]'};
  expect((await page.request.put(`/api/me/business/${business.id}`,{data:rows})).ok()).toBe(true);
  const before=await(await page.request.get('/api/me/business')).json();
  await page.reload(); await workspaceMenu(page,'Business details');
  await page.getByLabel('Address',{exact:true}).fill('One Test Street');
  await page.getByRole('button',{name:'Save business details',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start browser conversation'})).toBeVisible();
  const after=await(await page.request.get('/api/me/business')).json();
  expect(after).toMatchObject({...rows,address:'One Test Street'}); expect(after.agent).toEqual(before.agent);
});
