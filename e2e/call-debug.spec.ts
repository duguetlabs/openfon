import { openAuth, workspaceMenu } from './cleanroom-helpers';
import { test, expect } from './fixtures';

test('test debug notice, continuous Pipeline microphone, saved evidence and owner deletion', async ({ page }) => {
  test.skip(process.env.OPENFON_E2E_DEBUG === 'false', 'Run with OPENFON_E2E_DEBUG=true');
  test.setTimeout(60000);
  await openAuth(page);
  await page.getByLabel('Email').fill(`debug-${Date.now()}@example.invalid`);
  await page.getByLabel(/^Password/).fill('Synthetic-Debug-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Debug workshop');
  await page.getByLabel('What do you do?').fill('Synthetic diagnostics');
  await page.getByRole('button', { name: 'Meet your receptionist', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start browser conversation' })).toBeVisible();
  const { assistants } = await (await page.request.get('/api/me/bootstrap')).json();
  const id=assistants[0].id;
  expect((await page.request.put(`/api/me/assistants/${id}`, {data:{name:'Debug receptionist',persona:'Helpful',language:'en',engine:'pipeline',greeting:'Hello from the synthetic debug test.'}})).status()).toBe(200);
  await page.goto(`/test?assistant=${id}`);
  await expect(page.getByText('Recording is on for private tests.',{exact:true})).toBeVisible();
  await page.evaluate(()=>{
    // Quiet generated microphone keeps the unchanged VAD idle while the extra
    // diagnostic track records. No physical microphone or paid provider is used.
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
      const ctx=new AudioContext();const oscillator=ctx.createOscillator(), gain=ctx.createGain(), output=ctx.createMediaStreamDestination();
      gain.gain.value=0.00001;oscillator.connect(gain);gain.connect(output);oscillator.start();await ctx.resume();
      output.stream.getTracks()[0].addEventListener('ended',()=>void ctx.close());return output.stream;
    }});
    Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>[],cancel:()=>{},speak:(u:SpeechSynthesisUtterance)=>{
      u.onstart?.({} as SpeechSynthesisEvent);setTimeout(()=>u.onend?.({} as SpeechSynthesisEvent),30);
    }}});
  });
  const created=page.waitForResponse(r=>r.url().endsWith('/test-calls')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Start browser conversation',exact:true}).click();
  const {callId}=await (await created).json();
  await expect(page.getByText('Microphone and text',{exact:true})).toBeVisible();
  await page.waitForTimeout(1200); // Exercise the real continuous audio callback and timed flush.
  await page.getByLabel('Type your message').fill('Can you repair a bicycle?');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByText('Yes, we repair bicycles during opening hours.')).toBeVisible();
  await page.getByRole('button',{name:'End conversation',exact:true}).click();
  const path=`/api/me/calls/${callId}/debug`;
  await expect.poll(async()=> (await (await page.request.get(path)).json()).finishedAt).toBeTruthy();
  const download=await page.request.get(path+'/download');expect(download.status()).toBe(200);
  const rows=(await download.text()).trim().split('\n').map(s=>JSON.parse(s));
  expect(rows[0]).toMatchObject({kind:'manifest',partial:false,callId});
  expect(rows.some(r=>r.track==='microphone'&&r.format==='pcm_s16le_24000')).toBe(true);
  expect(rows.some(r=>r.kind==='browser'&&r.name==='speech_end')).toBe(true);
  expect(rows.some(r=>r.kind==='caller_event'&&r.text?.includes('bicycles'))).toBe(true);
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Call logs',exact:true}).click();
  await page.locator('.of-call-list button').first().click();
  await page.locator('summary').filter({hasText:'Call recording'}).click();
  await expect(page.getByRole('link',{name:'Download recording'})).toBeVisible();
  await page.getByRole('button',{name:'Delete recording',exact:true}).click();
  await expect(page.getByText(/No recording is available/)).toBeVisible();
  expect(await (await page.request.get(path)).json()).toEqual({available:false});
});

test('recording disclosure remains visible when debug-config cannot be read',async({page})=>{
  await page.route('**/api/me/debug-config',r=>r.fulfill({status:503,json:{error:'synthetic'}}));
  // This state is covered with the real signed-in flow above; keep the isolated
  // config failure assertion on the source component in a normal authenticated tab.
  await openAuth(page);
  await page.getByLabel('Email').fill(`debug-notice-${Date.now()}@example.invalid`);
  await page.getByLabel(/^Password/).fill('Synthetic-Debug-Password-1234');
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByLabel('Business name',{exact:true}).fill('Notice test');
  await page.getByLabel('What do you do?').fill('Synthetic diagnostics');
  await page.getByRole('button',{name:'Meet your receptionist', exact:true}).click();
  await expect(page.getByRole('button',{name:'Start browser conversation',exact:true})).toBeVisible();
  await page.goto('/test');
  await expect(page.getByText(/Test calls may retain audio and transcripts/)).toBeVisible();
});

for (const outcome of ['success', 'failure'] as const) test(`recording deletion ${outcome} survives call completion and stale recording reads`, async ({page}) => {
  await openAuth(page);
  await page.getByLabel('Email address').fill(`debug-delete-${outcome}-${Date.now()}@example.invalid`);
  await page.getByLabel(/^Password/).fill('Synthetic-Debug-Password-1234');
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByLabel('Business name',{exact:true}).fill('Recording race workshop');
  await page.getByLabel('What do you do?').fill('Synthetic diagnostics race');
  await page.getByRole('button',{name:'Meet your receptionist',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start browser conversation'})).toBeVisible();
  await page.clock.install();
  const callId=`recording-race-${outcome}`;
  let callReads=0, debugReads=0, deletes=0, pendingDelete=false, pendingRead=false, staleDelivered=false, deleted=false;
  let releaseDelete!:()=>void,releaseRead!:()=>void;
  const deletion=new Promise<void>(resolve=>{releaseDelete=resolve});
  const read=new Promise<void>(resolve=>{releaseRead=resolve});
  await page.route(`**/api/me/calls/${callId}`, route=>route.fulfill({json:{
    id:callId,status:++callReads===1?'active':'completed',environment:'test',channel:'web',
    started_at:'2026-09-27T09:00:00Z',duration_s:3,summary:'Synthetic recording race.',turns:[],
  }}));
  await page.route(`**/api/me/calls/${callId}/debug`,async route=>{
    if(route.request().method()==='DELETE'){
      deletes++;
      if(deletes===1){pendingDelete=true;await deletion;if(outcome==='failure')return route.fulfill({status:503,json:{error:'Synthetic recording deletion refusal'}});}
      deleted=true;return route.fulfill({json:{available:false}});
    }
    debugReads++;
    if(debugReads===2){pendingRead=true;await read;await route.fulfill({json:{available:true}});staleDelivered=true;return;}
    return route.fulfill({json:deleted?{available:false}:{available:true,...(callReads>1?{finishedAt:Date.now()}: {})}});
  });
  try{
    await page.goto(`/conversations?call=${callId}`);
    await page.locator('summary').filter({hasText:'Call recording'}).click();
    await expect(page.getByRole('button',{name:'Delete recording',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Refresh recording',exact:true}).click();
    await expect.poll(()=>pendingRead).toBe(true);
    await page.getByRole('button',{name:'Delete recording',exact:true}).click();
    await expect.poll(()=>pendingDelete).toBe(true);
    await page.clock.runFor(3001);
    await expect(page.getByText('completed',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Deleting…',exact:true})).toBeDisabled();
    expect(debugReads).toBe(2);expect(deletes).toBe(1);
    releaseDelete();
    if(outcome==='success')await expect(page.getByText(/No recording is available/)).toBeVisible();
    else await expect(page.getByRole('alert')).toContainText('Synthetic recording deletion refusal');
    await expect(page.getByRole('button',{name:'Refresh recording',exact:true})).toBeEnabled();
    releaseRead();
    await expect.poll(()=>staleDelivered).toBe(true);
    await page.clock.runFor(1);
    if(outcome==='success'){
      await expect(page.getByRole('button',{name:'Delete recording',exact:true})).toHaveCount(0);
      await expect(page.getByText(/No recording is available/)).toBeVisible();
    }else{
      await expect(page.getByRole('button',{name:'Delete recording',exact:true})).toBeEnabled();
      await page.getByRole('button',{name:'Refresh recording',exact:true}).click();
      await expect(page.getByRole('link',{name:'Download recording'})).toBeVisible();
      await expect(page.getByRole('alert')).toContainText('Synthetic recording deletion refusal');
      expect(deletes).toBe(1);
      await page.getByRole('button',{name:'Delete recording',exact:true}).click();
      await expect(page.getByText(/No recording is available/)).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);expect(deletes).toBe(2);
    }
  }finally{releaseDelete();releaseRead();}
});
