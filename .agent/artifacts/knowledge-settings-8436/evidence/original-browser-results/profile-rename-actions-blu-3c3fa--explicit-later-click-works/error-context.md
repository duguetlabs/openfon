# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: profile-rename-actions.spec.ts >> blur then Delete profile sends no action while rename is pending; explicit later click works
- Location: e2e/profile-rename-actions.spec.ts:54:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 0
Received: 1
```

# Page snapshot

```yaml
- generic [ref=f1e3]:
  - link "Skip to workspace content" [ref=f1e4] [cursor=pointer]:
    - /url: "#workspace-content"
  - banner [ref=f1e5]:
    - generic [ref=f1e6]:
      - link "openfon" [ref=f1e7] [cursor=pointer]:
        - /url: /overview
      - navigation "Workspace" [ref=f1e13]:
        - link "Overview" [ref=f1e14] [cursor=pointer]:
          - /url: /overview
        - link "Assistants" [ref=f1e15] [cursor=pointer]:
          - /url: /assistants
        - link "Test Studio" [ref=f1e16] [cursor=pointer]:
          - /url: /test
        - link "Calls" [ref=f1e17] [cursor=pointer]:
          - /url: /calls
        - link "Knowledge" [ref=f1e18] [cursor=pointer]:
          - /url: /knowledge
        - link "Settings" [ref=f1e19] [cursor=pointer]:
          - /url: /settings
        - link "Account" [ref=f1e20] [cursor=pointer]:
          - /url: /account
        - button "Sign out" [ref=f1e21]
  - main [ref=f1e22]:
    - generic [ref=f1e23]:
      - generic [ref=f1e24]:
        - paragraph [ref=f1e25]: Configuration
        - heading "Settings" [level=1] [ref=f1e26]
      - region "Workspace AI providers" [ref=f1e28]:
        - heading "Workspace AI providers" [level=2] [ref=f1e29]
        - paragraph [ref=f1e30]: Kataleptic is operated by OpenFon’s maintainer and is an optional paid service. You can use your own provider accounts. Provider usage and hosting may cost money.
        - group [ref=f1e32]:
          - generic [ref=f1e33]:
            - heading "Text generation & call summaries" [level=3] [ref=f1e34]
            - generic [ref=f1e35]:
              - text: Text provider preset
              - combobox "Text provider preset" [ref=f1e36]:
                - option "Instance default (Kataleptic by default)" [selected]
                - option "Kataleptic"
                - option "OpenRouter"
                - option "Hugging Face Inference Providers"
                - option "OpenAI (direct)"
                - option "Custom OpenAI-compatible"
            - generic [ref=f1e37]:
              - generic [ref=f1e38]: Text base URL
              - textbox "Text base URL" [ref=f1e40]:
                - /placeholder: http://127.0.0.1:50423/v1
              - generic [ref=f1e41]: Base URL only; OpenFon appends /chat/completions. Changing endpoints requires a replacement key or explicit removal.
            - generic [ref=f1e42]:
              - generic [ref=f1e43]: Workspace text model
              - textbox "Workspace text model" [ref=f1e45]
              - generic [ref=f1e46]: Editable model ID. Assistants with their own model override this value. Clear that override in Assistants to use this default.
            - generic [ref=f1e47]:
              - generic [ref=f1e48]: Text API key
              - textbox "Text API key" [ref=f1e50]:
                - /placeholder: Enter your provider key
            - generic [ref=f1e51]:
              - checkbox "Remove saved text key" [ref=f1e52]
              - text: Remove saved text key
            - paragraph [ref=f1e53]: OpenRouter and Hugging Face presets configure text chat only. They do not configure speech recognition, speech synthesis, or realtime voice. Model availability and JSON support depend on the provider and your account.
          - generic [ref=f1e54]:
            - heading "Speech recognition (pipeline)" [level=3] [ref=f1e55]
            - generic [ref=f1e56]:
              - text: Transcription provider
              - combobox "Transcription provider" [ref=f1e57]:
                - option "Instance default" [selected]
                - option "OpenAI (direct)"
                - option "Custom OpenAI-compatible transcription"
            - paragraph [ref=f1e58]: Instance transcription uses the operator’s key. An operator key is configured; connection not verified.
          - generic [ref=f1e59]:
            - heading "Realtime voice" [level=3] [ref=f1e60]
            - generic [ref=f1e61]:
              - text: Realtime provider
              - combobox "Realtime provider" [ref=f1e62]:
                - option "Instance default" [selected]
                - option "Kataleptic gateway"
                - option "OpenAI (direct)"
                - option "Custom OpenAI GA protocol (experimental)"
            - paragraph [ref=f1e63]: Instance realtime uses the operator’s key. An operator key is configured; connection not verified.
            - paragraph [ref=f1e64]: OpenAI uses gpt-realtime when the assistant model is blank. Switching to OpenAI clears known Kataleptic model/voice presets; custom values stay editable in Assistants. For independence from Kataleptic, also select an independent text provider for summaries and transcription provider for pipeline calls.
          - generic [ref=f1e65]:
            - heading "Speech synthesis (pipeline)" [level=3] [ref=f1e66]
            - paragraph [ref=f1e67]: "Instance setting: Browser speech synthesis. Browser speech works in browser calls only. Realtime audio uses the selected realtime provider. Text presets do not change speech synthesis."
          - generic [ref=f1e68]:
            - button "Save provider settings" [ref=f1e69]
            - button "Check saved text connection" [ref=f1e70]
      - generic [ref=f1e71]:
        - generic [ref=f1e72]:
          - heading "Business" [level=2] [ref=f1e73]
          - paragraph [ref=f1e74]: The facts your agent answers from.
        - generic [ref=f1e75]:
          - generic [ref=f1e76]:
            - generic [ref=f1e77]: Name
            - textbox "Name" [ref=f1e79]: Rename action workshop
          - generic [ref=f1e80]:
            - generic [ref=f1e81]: Description
            - textbox "Description" [ref=f1e83]: Synthetic pending profile rename validation
          - generic [ref=f1e84]:
            - generic [ref=f1e85]:
              - generic [ref=f1e86]: Address
              - textbox "Address" [ref=f1e88]
            - generic [ref=f1e89]:
              - generic [ref=f1e90]: Phone
              - textbox "Phone" [ref=f1e92]
            - generic [ref=f1e93]:
              - generic [ref=f1e94]: Website
              - textbox "Website" [ref=f1e96]
            - generic [ref=f1e97]:
              - generic [ref=f1e98]: Timezone
              - textbox "Timezone" [ref=f1e100]: Europe/Vienna
          - generic [ref=f1e101]:
            - generic [ref=f1e102]: Opening hours
            - generic [ref=f1e103]:
              - group "Monday opening hours" [ref=f1e104]:
                - generic [ref=f1e105]: Mon
                - checkbox "Open on Monday" [checked] [ref=f1e106]
                - textbox "Monday opening time" [ref=f1e107]: 09:00
                - generic [ref=f1e108]: –
                - textbox "Monday closing time" [ref=f1e109]: 17:00
              - group "Tuesday opening hours" [ref=f1e110]:
                - generic [ref=f1e111]: Tue
                - checkbox "Open on Tuesday" [checked] [ref=f1e112]
                - textbox "Tuesday opening time" [ref=f1e113]: 09:00
                - generic [ref=f1e114]: –
                - textbox "Tuesday closing time" [ref=f1e115]: 17:00
              - group "Wednesday opening hours" [ref=f1e116]:
                - generic [ref=f1e117]: Wed
                - checkbox "Open on Wednesday" [checked] [ref=f1e118]
                - textbox "Wednesday opening time" [ref=f1e119]: 09:00
                - generic [ref=f1e120]: –
                - textbox "Wednesday closing time" [ref=f1e121]: 17:00
              - group "Thursday opening hours" [ref=f1e122]:
                - generic [ref=f1e123]: Thu
                - checkbox "Open on Thursday" [checked] [ref=f1e124]
                - textbox "Thursday opening time" [ref=f1e125]: 09:00
                - generic [ref=f1e126]: –
                - textbox "Thursday closing time" [ref=f1e127]: 17:00
              - group "Friday opening hours" [ref=f1e128]:
                - generic [ref=f1e129]: Fri
                - checkbox "Open on Friday" [checked] [ref=f1e130]
                - textbox "Friday opening time" [ref=f1e131]: 09:00
                - generic [ref=f1e132]: –
                - textbox "Friday closing time" [ref=f1e133]: 17:00
              - group "Saturday opening hours" [ref=f1e134]:
                - generic [ref=f1e135]: Sat
                - checkbox "Open on Saturday" [ref=f1e136]
                - generic [ref=f1e137]: Closed
              - group "Sunday opening hours" [ref=f1e138]:
                - generic [ref=f1e139]: Sun
                - checkbox "Open on Sunday" [ref=f1e140]
                - generic [ref=f1e141]: Closed
          - group "Services & prices" [ref=f1e142]:
            - button "Add Services & prices item" [ref=f1e144]: + Add another
          - group "Holidays & special closures" [ref=f1e145]:
            - button "Add Holidays & special closures item" [ref=f1e147]: + Add another
          - group "FAQ" [ref=f1e148]:
            - button "Add FAQ item" [ref=f1e150]: + Add another
      - generic [ref=f1e151]:
        - generic [ref=f1e152]:
          - heading "Primary assistant" [level=2] [ref=f1e153]
          - paragraph [ref=f1e154]: These legacy settings apply to your first assistant. Manage additional assistants in the Assistants menu.
        - generic [ref=f1e155]:
          - generic [ref=f1e156]:
            - generic [ref=f1e157]:
              - generic [ref=f1e158]: Agent name
              - textbox "Agent name" [ref=f1e160]: Alex
            - generic [ref=f1e161]:
              - generic [ref=f1e162]: Language
              - combobox "Language" [ref=f1e163]:
                - option "English" [selected]
                - option "Deutsch"
                - option "Français"
                - option "Español"
                - option "Nederlands"
                - option "Svenska"
                - option "Dansk"
                - option "Italiano"
                - option "Suomi"
                - option "Русский"
          - generic [ref=f1e164]:
            - generic [ref=f1e165]: Personality
            - textbox "Personality" [ref=f1e167]: friendly and professional
          - generic [ref=f1e168]:
            - generic [ref=f1e169]: Greeting
            - textbox "Greeting" [ref=f1e171]:
              - /placeholder: Leave empty for the default greeting.
          - generic [ref=f1e172]:
            - generic [ref=f1e173]: Voice (Azure TTS)
            - combobox "Voice (Azure TTS)" [ref=f1e175]
            - generic [ref=f1e176]: Default is en-US-AvaMultilingualNeural, one natural voice for all languages. A custom voice applies to your default language only.
          - generic [ref=f1e177]:
            - checkbox "Take messages when the agent can't help" [checked] [ref=f1e178]
            - text: Take messages when the agent can't help
          - generic [ref=f1e179]:
            - generic [ref=f1e180]: Extra instructions
            - textbox "Extra instructions" [ref=f1e182]:
              - /placeholder: Anything else your receptionist should know or do.
      - generic [ref=f1e183]:
        - generic [ref=f1e184]:
          - heading "Engine profiles" [level=2] [ref=f1e185]
          - paragraph [ref=f1e186]: Saved combinations of engine, model, language, and voices — apply one to switch the whole setup at once.
        - generic [ref=f1e187]:
          - paragraph [ref=f1e188]: Up to 64 profiles are shown. Long historical values are previews and cannot be renamed here; applying uses the full saved configuration. Delete unused profiles to reveal more.
          - paragraph [ref=f1e189]: No profiles yet. Configure the engine below, then save it here under a name.
          - generic [ref=f1e190]:
            - textbox "Save current setup as… e.g. \"Realtime HD English (Emma)\"" [ref=f1e191]
            - button "Save profile" [disabled] [ref=f1e192]
      - generic [ref=f1e193]:
        - generic [ref=f1e194]:
          - heading "AI provider" [level=2] [ref=f1e195]
          - paragraph [ref=f1e196]: Provider endpoint and credentials are shared by all assistants. Engine and voice settings below apply to your primary assistant. OpenFon speaks the OpenAI API dialect — point it at Kataleptic, OpenAI, Groq, Ollama, or your own server. Empty model and endpoint fields use instance defaults; saved API keys stay until explicitly replaced or removed.
        - generic [ref=f1e197]:
          - generic [ref=f1e198]:
            - generic [ref=f1e199]: Voice engine
            - generic [ref=f1e200]:
              - generic [ref=f1e201]:
                - radio "Pipeline — transcribe → think → speak. Uses separate transcription, text generation, and speech synthesis settings." [checked] [ref=f1e202]
                - generic [ref=f1e203]:
                  - strong [ref=f1e204]: Pipeline
                  - text: — transcribe → think → speak. Uses separate transcription, text generation, and speech synthesis settings.
              - generic [ref=f1e205]:
                - radio "Realtime — streams audio both ways and supports interruptions. Requires a configured realtime provider." [ref=f1e206]
                - generic [ref=f1e207]:
                  - strong [ref=f1e208]: Realtime
                  - text: — streams audio both ways and supports interruptions. Requires a configured realtime provider.
          - generic [ref=f1e209]:
            - generic [ref=f1e210]: Assistant text model override
            - textbox "Assistant text model override" [ref=f1e212]
            - generic [ref=f1e213]: Blank uses the workspace text model above.
      - generic [ref=f1e214]:
        - paragraph [ref=f1e215]: Changes apply on the next call
        - generic [ref=f1e216]:
          - status [ref=f1e217]: Profile deleted.
          - alert [ref=f1e218]: Failed to fetch
          - button "Save changes" [disabled] [ref=f1e219]
  - contentinfo [ref=f1e220]:
    - generic [ref=f1e222]:
      - paragraph [ref=f1e223]:
        - text: OpenFon — open-source AI phone agent.
        - link "github.com/duguetlabs/openfon" [ref=f1e224] [cursor=pointer]:
          - /url: https://github.com/duguetlabs/openfon
      - paragraph [ref=f1e225]: self-hosted · MIT licensed
```

# Test source

```ts
  1   | import { test, expect } from './fixtures';
  2   | import type { Page, Route } from '@playwright/test';
  3   | 
  4   | async function setup(page: Page, count = 1) {
  5   |   await page.goto('/auth');
  6   |   await page.getByLabel('Email').fill(`rename-actions-${Date.now()}@example.invalid`);
  7   |   await page.getByLabel('Password', { exact: true }).fill('Synthetic-Presets-Password-1234');
  8   |   await page.getByRole('button', { name: 'Create account', exact: true }).click();
  9   |   await page.getByLabel('Business name', { exact: true }).fill('Rename action workshop');
  10  |   await page.getByLabel('What do you do?').fill('Synthetic pending profile rename validation');
  11  |   await page.getByRole('button', { name: 'Continue →' }).click();
  12  |   await page.getByRole('button', { name: 'Continue →' }).click();
  13  |   await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  14  |   await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  15  |   const business = await (await page.request.get('/api/me/business')).json();
  16  |   const profiles: { id: string; name: string }[] = [];
  17  |   for (let i = 0; i < count; i++) {
  18  |     const response = await page.request.post(`/api/me/business/${business.id}/profiles`, {
  19  |       data: { name: `Original ${i}`, engine: 'pipeline', language: 'en' },
  20  |     });
  21  |     expect(response.ok()).toBe(true); profiles.push(await response.json());
  22  |   }
  23  |   await page.goto('/settings');
  24  |   await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(count);
  25  |   return { business, profiles };
  26  | }
  27  | const rows = (page: Page) => page.getByRole('button', { name: 'Apply', exact: true }).locator('..');
  28  | const frames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  29  | async function gateRenames(page: Page) {
  30  |   const held: Route[] = [], outstanding = new Set<Route>();
  31  |   await page.route('**/api/me/profiles/*', route => {
  32  |     if (route.request().method() !== 'PUT') return route.continue();
  33  |     held.push(route); outstanding.add(route);
  34  |   });
  35  |   return {
  36  |     held,
  37  |     async settle(index: number, error?: string) {
  38  |       const route = held[index]; outstanding.delete(route);
  39  |       if (error) await route.fulfill({ status: 503, json: { error } });
  40  |       else await route.continue();
  41  |     },
  42  |     async dispose() { for (const route of outstanding) await route.abort().catch(() => {}); outstanding.clear(); },
  43  |   };
  44  | }
  45  | async function expectGated(page: Page, count: number) {
  46  |   await expect(page.getByRole('status').filter({ hasText: 'Saving profile names…' })).toBeVisible();
  47  |   for (let i = 0; i < count; i++) {
  48  |     await expect(rows(page).nth(i).getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  49  |     await expect(rows(page).nth(i).getByRole('button', { name: 'Delete profile', exact: true })).toBeDisabled();
  50  |   }
  51  | }
  52  | 
  53  | for (const action of ['Apply', 'Delete profile'] as const) {
  54  |   test(`blur then ${action} sends no action while rename is pending; explicit later click works`, async ({ page }) => {
  55  |     const { business, profiles } = await setup(page), id = profiles[0].id;
  56  |     const gate = await gateRenames(page);
  57  |     let actions = 0;
  58  |     page.on('request', request => {
  59  |       if ((request.method() === 'POST' && request.url().endsWith(`/profiles/${id}/apply`)) ||
  60  |           (request.method() === 'DELETE' && request.url().endsWith(`/profiles/${id}`))) actions++;
  61  |     });
  62  |     try {
  63  |       const row = rows(page).first(), input = row.locator('input'), button = row.getByRole('button', { name: action, exact: true });
  64  |       await expect(button).toBeEnabled();
  65  |       // Real mouse order: mousedown blurs the input before click. Do not use
  66  |       // locator.click(), whose disabled-button retry could queue the test action.
  67  |       await button.scrollIntoViewIfNeeded(); const box = await button.boundingBox(); expect(box).not.toBeNull();
  68  |       await input.fill('Renamed before action');
  69  |       await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  70  |       await expect.poll(() => gate.held.length).toBe(1); await frames(page);
> 71  |       expect(actions).toBe(0); await expectGated(page, 1);
      |                       ^ Error: expect(received).toBe(expected) // Object.is equality
  72  |       const saved = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/profiles/${id}`));
  73  |       await gate.settle(0); expect((await saved).ok()).toBe(true);
  74  |       await expect(button).toBeEnabled(); expect(actions).toBe(0);
  75  |       const acted = page.waitForResponse(response => response.url().endsWith(`/profiles/${id}${action === 'Apply' ? '/apply' : ''}`) && response.request().method() === (action === 'Apply' ? 'POST' : 'DELETE'));
  76  |       await button.click(); expect((await acted).ok()).toBe(true); expect(actions).toBe(1);
  77  |       const persisted = await (await page.request.get(`/api/me/business/${business.id}/profiles`)).json() as { id: string; name: string }[];
  78  |       if (action === 'Apply') expect(persisted.find(p => p.id === id)?.name).toBe('Renamed before action');
  79  |       else expect(persisted.some(p => p.id === id)).toBe(false);
  80  |     } finally { await gate.dispose(); }
  81  |   });
  82  | }
  83  | 
  84  | test('all profiles stay gated until both per-id queues and newer queued draft settle', async ({ page }) => {
  85  |   const { business } = await setup(page, 2), gate = await gateRenames(page);
  86  |   try {
  87  |     const first = rows(page).nth(0).locator('input'), second = rows(page).nth(1).locator('input');
  88  |     await first.fill('First pending'); await first.blur(); await expect.poll(() => gate.held.length).toBe(1);
  89  |     await first.fill('First newest'); await first.blur();
  90  |     await second.fill('Second pending'); await second.blur(); await expect.poll(() => gate.held.length).toBe(2);
  91  |     await expectGated(page, 2);
  92  |     await gate.settle(0); await expect.poll(() => gate.held.length).toBe(3);
  93  |     await expect(first).toHaveValue('First newest'); await expectGated(page, 2);
  94  |     await gate.settle(1); await frames(page); await expectGated(page, 2);
  95  |     const last = page.waitForResponse(response => response.request().method() === 'PUT' && response.request().postDataJSON()?.name === 'First newest');
  96  |     await gate.settle(2); expect((await last).ok()).toBe(true);
  97  |     await expect(page.getByRole('status').filter({ hasText: 'Saving profile names…' })).toHaveCount(0);
  98  |     for (let i = 0; i < 2; i++) {
  99  |       await expect(rows(page).nth(i).getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  100 |       await expect(rows(page).nth(i).getByRole('button', { name: 'Delete profile', exact: true })).toBeEnabled();
  101 |     }
  102 |     await first.focus(); await first.blur(); await second.focus(); await second.blur(); await frames(page);
  103 |     expect(gate.held.length).toBe(3);
  104 |     const persisted = await (await page.request.get(`/api/me/business/${business.id}/profiles`)).json() as { name: string }[];
  105 |     expect(persisted.map(p => p.name).sort()).toEqual(['First newest', 'Second pending']);
  106 |   } finally { await gate.dispose(); }
  107 | });
  108 | 
  109 | test('failed rename releases actions with error and confirmed baseline, then retry gates again', async ({ page }) => {
  110 |   await setup(page); const gate = await gateRenames(page);
  111 |   try {
  112 |     const input = rows(page).first().locator('input');
  113 |     await input.fill('Attempted'); await input.blur(); await expect.poll(() => gate.held.length).toBe(1);
  114 |     await expectGated(page, 1); await gate.settle(0, 'Synthetic rename refusal');
  115 |     await expect(input).toHaveValue('Original 0');
  116 |     await expect(page.getByText('Synthetic rename refusal', { exact: true })).toBeVisible();
  117 |     await expect(rows(page).first().getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  118 |     await input.focus(); await input.blur(); await frames(page); expect(gate.held.length).toBe(1);
  119 |     await input.fill('Retry'); await input.blur(); await expect.poll(() => gate.held.length).toBe(2); await expectGated(page, 1);
  120 |     // A newer unblurred draft must survive the pending request's acknowledgement.
  121 |     await input.fill('Newer draft'); await gate.settle(1);
  122 |     await expect(rows(page).first().getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  123 |     await expect(input).toHaveValue('Newer draft');
  124 |     await input.blur(); await expect.poll(() => gate.held.length).toBe(3); await expectGated(page, 1);
  125 |     await gate.settle(2); await expect(rows(page).first().getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  126 |     await page.reload(); await expect(rows(page).first().locator('input')).toHaveValue('Newer draft');
  127 |   } finally { await gate.dispose(); }
  128 | });
  129 | 
```