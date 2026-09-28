import { signup, createWorkspace, connections, workspaceMenu } from './cleanroom-helpers';
import { test, expect, openSettingsSections } from './fixtures';
import { exportAssistantRecipe } from '../web/src/assistant-config';
import type { Page } from '@playwright/test';

async function cancelLeave(page: Page, action: () => Promise<unknown>) {
  const prompted=page.waitForEvent('dialog'); const navigation=action().catch(()=>undefined);
  await (await prompted).dismiss(); await navigation;
  if(await page.getByRole('button',{name:'Close menu',exact:true}).isVisible()) await page.getByRole('button',{name:'Close menu',exact:true}).click();
}

test('an unsaved reusable setup name guards navigation and sign-out, then clears after save or discard',async({page})=>{
  await signup(page,'setup-navigation');await createWorkspace(page,'Setup draft workshop');await connections(page);await openSettingsSections(page);
  const name=page.getByLabel('Name a reusable setup',{exact:true});let writes=0;
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/me/engine-presets'))writes++;});
  await name.fill('Unsaved reusable setup');
  await cancelLeave(page,()=>workspaceMenu(page,'Messages & conversations'));
  await expect(name).toHaveValue('Unsaved reusable setup');expect(writes).toBe(0);
  await cancelLeave(page,()=>workspaceMenu(page,'Sign out'));
  await expect(name).toHaveValue('Unsaved reusable setup');expect((await page.request.get('/api/me')).status()).toBe(200);
  const prompt=page.waitForEvent('dialog');const leave=workspaceMenu(page,'Messages & conversations');await(await prompt).accept();await leave;
  await connections(page);await openSettingsSections(page);await expect(name).toHaveValue('');expect(writes).toBe(0);
  await name.fill('Saved reusable setup');await page.getByRole('button',{name:'Save current voice setup',exact:true}).click();
  await expect(page.getByText('Reusable voice setup saved.',{exact:true})).toBeVisible();await expect(name).toHaveValue('');expect(writes).toBe(1);
  const unexpected:string[]=[];page.on('dialog',async dialog=>{unexpected.push(dialog.type());await dialog.dismiss();});
  await workspaceMenu(page,'Messages & conversations');await expect(page).toHaveURL('/conversations');expect(unexpected).toEqual([]);
});

test('a staged recipe guards navigation, reload and sign-out until explicitly cancelled or saved',async({page})=>{
  await signup(page,'recipe-navigation');const {assistant}=await createWorkspace(page,'Recipe draft workshop');
  const initial=await(await page.request.get(`/api/me/assistants/${assistant.id}`)).json();
  const recipe=exportAssistantRecipe({...initial,name:'Imported receptionist',persona:'Friendly and concise',greeting:'Portable greeting',language:'en'});
  const file={name:'receptionist.json',mimeType:'application/json',buffer:Buffer.from(recipe)};
  await connections(page);let writes=0;
  page.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith(`/api/me/assistants/${assistant.id}`))writes++;});
  await page.getByLabel('Import recipe').setInputFiles(file);await expect(page.getByRole('button',{name:'Save this recipe',exact:true})).toBeVisible();
  await cancelLeave(page,()=>workspaceMenu(page,'Messages & conversations'));
  await cancelLeave(page,()=>page.reload({timeout:1500}));
  await cancelLeave(page,()=>workspaceMenu(page,'Sign out'));
  await expect(page.locator('.of-import-review')).toContainText('Portable greeting');expect(writes).toBe(0);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  const unexpected:string[]=[];const dismiss=async(dialog:import('@playwright/test').Dialog)=>{unexpected.push(dialog.type());await dialog.dismiss();};page.on('dialog',dismiss);
  await workspaceMenu(page,'Messages & conversations');await expect(page).toHaveURL('/conversations');await connections(page);
  await page.getByLabel('Import recipe').setInputFiles(file);await page.getByRole('button',{name:'Save this recipe',exact:true}).click();
  await expect(page.getByText('Recipe imported into this receptionist.',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Import recipe')).toBeEnabled();expect(writes).toBe(1);
  await workspaceMenu(page,'Messages & conversations');await expect(page).toHaveURL('/conversations');expect(unexpected).toEqual([]);page.off('dialog',dismiss);
});

test('reverting each stored-key removal checkbox returns to a clean connection baseline',async({page})=>{
  await signup(page,'key-clear-revert');await createWorkspace(page,'Key revert workshop');
  const saved=await page.request.put('/api/me/provider',{data:{apiKey:'synthetic-text-key',realtime_provider:'openai',realtime_base_url:'wss://api.openai.com/v1/realtime',realtime_api_key:'synthetic-realtime-key',stt_provider:'openai',stt_base_url:'https://api.openai.com/v1',stt_model:'whisper-1',stt_api_key:'synthetic-stt-key',tts_provider:'openai',tts_base_url:'https://api.openai.com/v1',tts_model:'gpt-4o-mini-tts',tts_api_key:'synthetic-speech-key'}});
  expect(saved.ok(),await saved.text()).toBe(true);
  await connections(page);await openSettingsSections(page);
  const save=page.getByRole('button',{name:'Save connections',exact:true});
  const clears=page.getByRole('checkbox',{name:'Remove the saved key',exact:true});await expect(clears).toHaveCount(4);
  for(let i=0;i<4;i++){
    await clears.nth(i).check();await expect(save).toBeEnabled();await clears.nth(i).uncheck();await expect(save).toBeDisabled();
  }
  const unexpected:string[]=[];let writes=0;page.on('dialog',async dialog=>{unexpected.push(dialog.type());await dialog.dismiss();});
  page.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/api/me/provider'))writes++;});
  await workspaceMenu(page,'Messages & conversations');await expect(page).toHaveURL('/conversations');
  await workspaceMenu(page,'Sign out');await expect(page.getByLabel('Email address')).toBeVisible();expect(unexpected).toEqual([]);expect(writes).toBe(0);
});

for(const operation of ['apply','rename'] as const)test(`a held setup ${operation} guards leaving and settles without duplicate writes`,async({page})=>{
  await signup(page,`setup-pending-${operation}`);const {assistant}=await createWorkspace(page,'Pending setup workshop');
  const response=await page.request.post('/api/me/engine-presets',{data:{name:'Pending setup',engine:'pipeline',language:'fr',voice:'',llm_model:''}});expect(response.status()).toBe(201);const preset=await response.json();
  await connections(page);await openSettingsSections(page);
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve});let started=false,writes=0;
  await page.route(`**/api/me/engine-presets/${preset.id}${operation==='apply'?'/apply':''}`,async route=>{
    if(route.request().method()!==(operation==='apply'?'POST':'PUT'))return route.continue();
    writes++;const saved=await route.fetch();expect(saved.ok()).toBe(true);started=true;await held;return route.fulfill({response:saved});
  });
  try{
    if(operation==='apply')await page.getByRole('button',{name:'Use setup',exact:true}).click();
    else{await page.getByLabel('Setup name',{exact:true}).fill('Renamed pending setup');await page.getByRole('heading',{name:'Your connections'}).click();}
    await expect.poll(()=>started).toBe(true);
    await cancelLeave(page,()=>workspaceMenu(page,'Messages & conversations'));
    await expect(page.getByRole('heading',{name:'Your connections'})).toBeVisible();
    await cancelLeave(page,()=>workspaceMenu(page,'Sign out'));expect((await page.request.get('/api/me')).status()).toBe(200);
    expect(writes).toBe(1);release();
    await expect(page.getByRole('button',{name:'Use setup',exact:true})).toBeEnabled();
    if(operation==='apply')await expect(page.getByLabel('Language',{exact:true})).toHaveValue('fr');
    else await expect(page.getByLabel('Setup name',{exact:true})).toHaveValue('Renamed pending setup');
    const unexpected:string[]=[];page.on('dialog',async dialog=>{unexpected.push(dialog.type());await dialog.dismiss();});
    await workspaceMenu(page,'Messages & conversations');await expect(page).toHaveURL('/conversations');expect(unexpected).toEqual([]);expect(writes).toBe(1);
    expect((await(await page.request.get(`/api/me/assistants/${assistant.id}`)).json()).language).toBe(operation==='apply'?'fr':'en');
  }finally{release();}
});

test('confirmed setup recovery guards navigation but explicit leave never repeats the applied setup',async({page})=>{
  await signup(page,'setup-pending-recovery');const {assistant}=await createWorkspace(page,'Setup recovery workshop');
  const response=await page.request.post('/api/me/engine-presets',{data:{name:'Recovery setup',engine:'pipeline',language:'de',voice:'',llm_model:''}});expect(response.status()).toBe(201);const preset=await response.json();
  await connections(page);await openSettingsSections(page);let writes=0,failRead=false;
  await page.route(`**/api/me/engine-presets/${preset.id}/apply`,async route=>{writes++;const saved=await route.fetch();expect(saved.ok()).toBe(true);failRead=true;return route.fulfill({response:saved});});
  await page.route(`**/api/me/assistants/${assistant.id}`,route=>failRead&&route.request().method()==='GET'?route.fulfill({status:503,json:{error:'Synthetic applied setup display failure'}}):route.continue());
  await page.getByRole('button',{name:'Use setup',exact:true}).click();await expect(page.getByRole('button',{name:'Retry setup refresh',exact:true})).toBeEnabled();
  await cancelLeave(page,()=>workspaceMenu(page,'Messages & conversations'));
  await expect(page.getByRole('alert')).toContainText('The setup change was saved');expect(writes).toBe(1);
  const prompt=page.waitForEvent('dialog');const leave=workspaceMenu(page,'Messages & conversations');await(await prompt).accept();await leave;await expect(page).toHaveURL('/conversations');
  failRead=false;await connections(page);await openSettingsSections(page);
  // Reloading the page obtains the now-current saved assistant; no apply POST is repeated.
  await page.reload();await expect(page.getByLabel('Language',{exact:true})).toHaveValue('de');
  expect(writes).toBe(1);expect((await(await page.request.get(`/api/me/assistants/${assistant.id}`)).json()).language).toBe('de');
});
