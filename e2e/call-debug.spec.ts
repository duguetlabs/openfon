import { test, expect } from './fixtures';

test('test debug notice, continuous Pipeline microphone, saved evidence and owner deletion', async ({ page }) => {
  test.skip(process.env.OPENFON_E2E_DEBUG === 'false', 'Run with OPENFON_E2E_DEBUG=true');
  test.setTimeout(60000);
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`debug-${Date.now()}@example.invalid`);
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Debug-Password-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Debug workshop');
  await page.getByLabel('What do you do?').fill('Synthetic diagnostics');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const { assistants } = await (await page.request.get('/api/me/bootstrap')).json();
  const id=assistants[0].id;
  expect((await page.request.put(`/api/me/assistants/${id}`, {data:{engine:'pipeline',greeting:'Hello from the synthetic debug test.'}})).status()).toBe(200);
  await page.goto(`/test?assistant=${id}`);
  await expect(page.getByText('Debug mode on for test calls.',{exact:true})).toBeVisible();
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
  await page.getByRole('button',{name:'Start test call',exact:true}).click();
  const {callId}=await (await created).json();
  await expect(page.getByText('Microphone on',{exact:true})).toBeVisible();
  await page.waitForTimeout(1200); // Exercise the real continuous audio callback and timed flush.
  await page.getByLabel('Message to assistant').fill('Can you repair a bicycle?');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await expect(page.getByText('Yes, we repair bicycles during opening hours.')).toBeVisible();
  await page.getByRole('button',{name:'End test call',exact:true}).click();
  const path=`/api/me/calls/${callId}/debug`;
  await expect.poll(async()=> (await (await page.request.get(path)).json()).finishedAt).toBeTruthy();
  const download=await page.request.get(path+'/download');expect(download.status()).toBe(200);
  const rows=(await download.text()).trim().split('\n').map(s=>JSON.parse(s));
  expect(rows[0]).toMatchObject({kind:'manifest',partial:false,callId});
  expect(rows.some(r=>r.track==='microphone'&&r.format==='pcm_s16le_24000')).toBe(true);
  expect(rows.some(r=>r.kind==='browser'&&r.name==='speech_end')).toBe(true);
  expect(rows.some(r=>r.kind==='caller_event'&&r.text?.includes('bicycles'))).toBe(true);
  await page.getByRole('link',{name:'Review this call →'}).click();
  await expect(page.getByRole('link',{name:'Download debug bundle'})).toBeVisible();
  await page.getByRole('button',{name:'Delete recording',exact:true}).click();
  await expect(page.getByText(/No recording is available/)).toBeVisible();
  expect(await (await page.request.get(path)).json()).toEqual({available:false});
});

test('recording disclosure remains visible when debug-config cannot be read',async({page})=>{
  await page.route('**/api/me/debug-config',r=>r.fulfill({status:503,json:{error:'synthetic'}}));
  // This state is covered with the real signed-in flow above; keep the isolated
  // config failure assertion on the source component in a normal authenticated tab.
  await page.goto('/auth');
  await page.getByLabel('Email').fill(`debug-notice-${Date.now()}@example.invalid`);
  await page.getByLabel('Password',{exact:true}).fill('Synthetic-Debug-Password-1234');
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByLabel('Business name',{exact:true}).fill('Notice test');
  await page.getByLabel('What do you do?').fill('Synthetic diagnostics');
  await page.getByRole('button',{name:'Continue →'}).click();
  await page.getByRole('button',{name:'Continue →'}).click();
  await page.getByRole('button',{name:/Create.*assistant|Save.*assistant|Open.*studio/i}).click();
  await expect(page.getByRole('navigation',{name:'Workspace'})).toBeVisible();
  await page.goto('/test');
  await expect(page.getByText(/Test calls may record audio, transcripts and configuration/)).toBeVisible();
});
