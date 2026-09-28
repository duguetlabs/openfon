import { signup, createWorkspace, connections, whoAnswers } from './cleanroom-helpers';
import { test, expect } from './fixtures';

test('simple navigation keeps dated model evidence in connection settings', async ({ page }) => {
  await signup(page,'remake'); const {assistant} = await createWorkspace(page,'Remake workshop');
  await expect(page.getByRole('button',{name:'Start browser conversation'})).toBeVisible();
  await expect(page.getByText('Realtime model routing',{exact:true})).toHaveCount(0);
  const route = { requestedModel:'gpt-realtime-2.1', upstreamModel:'gpt-realtime-2.1', upstreamVersion:'2026-07-07',upstreamDeployment:'gpt-realtime-2.1',upstreamService:'Azure OpenAI Realtime',voiceRenderer:'native-model',evidence:'deployment-snapshot',checkedAt:'2026-09-26T22:54:10Z',liveSessionVerified:false,distinctness:'verified-at-check' };
  await page.route('**/api/me/provider',async intercepted=>{
    const response=await intercepted.fetch(),data=await response.json();
    await intercepted.fulfill({json:{...data,realtime_provider:'kataleptic',effective_realtime_provider:'kataleptic',effective_realtime_model:route.requestedModel,realtimeRoute:route}});
  });
  expect((await page.request.put(`/api/me/assistants/${assistant.id}`,{data:{name:'Ada',persona:'Helpful',greeting:'Hello',engine:'realtime',realtime_model:route.requestedModel}})).ok()).toBe(true);
  await page.goto(`/assistants/${assistant.id}`); await whoAnswers(page);
  await expect(page.getByLabel(/^Their first words/)).toBeVisible();
  await expect(page.getByRole('combobox',{name:'Voice',exact:true})).toBeVisible();
  await expect(page.getByRole('combobox',{name:'Conversation engine',exact:true})).toHaveCount(0);
  await connections(page);
  await expect(page.getByRole('combobox',{name:'Conversation engine',exact:true})).toBeVisible();
  await expect(page.locator('.of-route-evidence')).toContainText('not verification of a new call');
  await expect(page.locator('.of-route-evidence')).toContainText('2026-09-26T22:54:10Z');
  await expect(page.getByLabel('Realtime model',{exact:true})).toHaveValue('gpt-realtime-2.1');
  await expect(page.getByRole('button',{name:'Save connections',exact:true})).toBeDisabled();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('a saved unavailable model stays visible and can be explicitly repaired',async({page})=>{
  await signup(page,'remake-repair'); const {assistant}=await createWorkspace(page);
  const id=assistant.id; let initial=true;
  await page.route(`**/api/me/assistants/${id}`,async intercepted=>{
    const response=await intercepted.fetch();
    if(initial&&intercepted.request().method()==='GET') { initial=false; await intercepted.fulfill({json:{...await response.json(),engine:'realtime',realtime_model:'kataleptic-realtime',realtime_voice:'de_DE-thorsten-medium'}}); }
    else await intercepted.fulfill({response});
  });
  await page.goto(`/assistants/${id}`); await connections(page);
  await expect(page.getByLabel('Realtime model',{exact:true})).toHaveValue('kataleptic-realtime');
  await expect(page.getByLabel('Realtime voice',{exact:true})).toHaveValue('de_DE-thorsten-medium');
  await expect(page.locator('.of-route-evidence')).toContainText('No dated routing evidence');
  await page.getByLabel('Realtime model',{exact:true}).fill('kataleptic-realtime-hd');
  await page.getByLabel('Realtime voice',{exact:true}).fill('de-DE-SeraphinaMultilingualNeural');
  await page.getByRole('button',{name:'Save connections',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Connections saved'})).toBeVisible();
  expect(await (await page.request.get(`/api/me/assistants/${id}`)).json()).toMatchObject({realtime_model:'kataleptic-realtime-hd',realtime_voice:'de-DE-SeraphinaMultilingualNeural'});
});
