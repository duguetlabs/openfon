import { signup, createWorkspace, workspaceMenu } from './cleanroom-helpers';
import { test, expect } from './fixtures';

test('a late private401 from a signed-out session cannot clear the newer login', async ({page})=>{
  const credentials=await signup(page,'expiry-generation');await createWorkspace(page,'Current session workshop');
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve});let captured=false,delivered=false;
  await page.route('**/api/me/provider/catalog',async route=>{
    if(captured) return route.continue();
    captured=true;await held;
    await route.fulfill({status:401,json:{error:'Prior session expired'}});delivered=true;
  });
  try{
    await workspaceMenu(page,'Connections & portability');await expect.poll(()=>captured).toBe(true);
    await workspaceMenu(page,'Sign out');await expect(page.getByLabel('Email address')).toBeVisible();
    await page.getByLabel('Email address').fill(credentials.email);
    await page.getByLabel('Password',{exact:true}).fill(credentials.password);
    await page.getByRole('button',{name:'Open your desk',exact:true}).click();
    await expect(page.getByRole('button',{name:'Start browser conversation'})).toBeVisible();
    release();await expect.poll(()=>delivered).toBe(true);
    await expect(page.getByRole('button',{name:'Start browser conversation'})).toBeVisible();
    await expect(page.getByLabel('Email address')).toHaveCount(0);
    expect((await page.request.get('/api/me')).status()).toBe(200);
  }finally{release();}
});
