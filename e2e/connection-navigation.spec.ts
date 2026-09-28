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
  await expect(page.getByText('Recipe imported into this receptionist.',{exact:true})).toBeVisible();expect(writes).toBe(1);
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
