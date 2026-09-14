# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: settings-load-error.spec.ts >> accepted automatic settings read clears only an earlier local load failure and retains drafts
- Location: e2e/settings-load-error.spec.ts:58:1

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  getByRole('alert').filter({ hasText: 'Local load unavailable' })
Expected: 0
Received: 1
Timeout:  5000ms

Call log:
  - Expect "toHaveCount" getByRole('alert').filter({ hasText: 'Local load unavailable' }) with timeout 5000ms
  - waiting for getByRole('alert').filter({ hasText: 'Local load unavailable' })
    14 × locator resolved to 1 element
       - unexpected value "1"

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
        - status [ref=f1e31]: Provider settings saved. Test the saved configuration before calling.
        - group [ref=f1e33]:
          - generic [ref=f1e34]:
            - heading "Text generation & call summaries" [level=3] [ref=f1e35]
            - generic [ref=f1e36]:
              - text: Text provider preset
              - combobox "Text provider preset" [ref=f1e37]:
                - option "Instance default (Kataleptic by default)" [selected]
                - option "Kataleptic"
                - option "OpenRouter"
                - option "Hugging Face Inference Providers"
                - option "OpenAI (direct)"
                - option "Custom OpenAI-compatible"
            - generic [ref=f1e38]:
              - generic [ref=f1e39]: Text base URL
              - textbox "Text base URL" [ref=f1e41]:
                - /placeholder: http://127.0.0.1:60383/v1
              - generic [ref=f1e42]: Base URL only; OpenFon appends /chat/completions. Changing endpoints requires a replacement key or explicit removal.
            - generic [ref=f1e43]:
              - generic [ref=f1e44]: Workspace text model
              - textbox "Workspace text model" [ref=f1e46]
              - generic [ref=f1e47]: Editable model ID. Assistants with their own model override this value. Clear that override in Assistants to use this default.
            - generic [ref=f1e48]:
              - generic [ref=f1e49]: Text API key
              - textbox "Text API key" [ref=f1e51]:
                - /placeholder: Enter your provider key
            - generic [ref=f1e52]:
              - checkbox "Remove saved text key" [ref=f1e53]
              - text: Remove saved text key
            - paragraph [ref=f1e54]: OpenRouter and Hugging Face presets configure text chat only. They do not configure speech recognition, speech synthesis, or realtime voice. Model availability and JSON support depend on the provider and your account.
          - generic [ref=f1e55]:
            - heading "Speech recognition (pipeline)" [level=3] [ref=f1e56]
            - generic [ref=f1e57]:
              - text: Transcription provider
              - combobox "Transcription provider" [ref=f1e58]:
                - option "Instance default" [selected]
                - option "OpenAI (direct)"
                - option "Custom OpenAI-compatible transcription"
            - paragraph [ref=f1e59]: Instance transcription uses the operator’s key. An operator key is configured; connection not verified.
          - generic [ref=f1e60]:
            - heading "Realtime voice" [level=3] [ref=f1e61]
            - generic [ref=f1e62]:
              - text: Realtime provider
              - combobox "Realtime provider" [ref=f1e63]:
                - option "Instance default" [selected]
                - option "Kataleptic gateway"
                - option "OpenAI (direct)"
                - option "Custom OpenAI GA protocol (experimental)"
            - paragraph [ref=f1e64]: Instance realtime uses the operator’s key. An operator key is configured; connection not verified.
            - paragraph [ref=f1e65]: OpenAI uses gpt-realtime when the assistant model is blank. Switching to OpenAI clears known Kataleptic model/voice presets; custom values stay editable in Assistants. For independence from Kataleptic, also select an independent text provider for summaries and transcription provider for pipeline calls.
          - generic [ref=f1e66]:
            - heading "Speech synthesis (pipeline)" [level=3] [ref=f1e67]
            - paragraph [ref=f1e68]: "Instance setting: Browser speech synthesis. Browser speech works in browser calls only. Realtime audio uses the selected realtime provider. Text presets do not change speech synthesis."
          - generic [ref=f1e69]:
            - button "Save provider settings" [ref=f1e70]
            - button "Check saved text connection" [ref=f1e71]
      - generic [ref=f1e72]:
        - generic [ref=f1e73]:
          - heading "Business" [level=2] [ref=f1e74]
          - paragraph [ref=f1e75]: The facts your agent answers from.
        - generic [ref=f1e76]:
          - generic [ref=f1e77]:
            - generic [ref=f1e78]: Name
            - textbox "Name" [ref=f1e80]: Newer unsaved business draft
          - generic [ref=f1e81]:
            - generic [ref=f1e82]: Description
            - textbox "Description" [ref=f1e84]: Synthetic load ownership validation
          - generic [ref=f1e85]:
            - generic [ref=f1e86]:
              - generic [ref=f1e87]: Address
              - textbox "Address" [ref=f1e89]
            - generic [ref=f1e90]:
              - generic [ref=f1e91]: Phone
              - textbox "Phone" [ref=f1e93]
            - generic [ref=f1e94]:
              - generic [ref=f1e95]: Website
              - textbox "Website" [ref=f1e97]
            - generic [ref=f1e98]:
              - generic [ref=f1e99]: Timezone
              - textbox "Timezone" [ref=f1e101]: Europe/Vienna
          - generic [ref=f1e102]:
            - generic [ref=f1e103]: Opening hours
            - generic [ref=f1e104]:
              - group "Monday opening hours" [ref=f1e105]:
                - generic [ref=f1e106]: Mon
                - checkbox "Open on Monday" [checked] [ref=f1e107]
                - textbox "Monday opening time" [ref=f1e108]: 09:00
                - generic [ref=f1e109]: –
                - textbox "Monday closing time" [ref=f1e110]: 17:00
              - group "Tuesday opening hours" [ref=f1e111]:
                - generic [ref=f1e112]: Tue
                - checkbox "Open on Tuesday" [checked] [ref=f1e113]
                - textbox "Tuesday opening time" [ref=f1e114]: 09:00
                - generic [ref=f1e115]: –
                - textbox "Tuesday closing time" [ref=f1e116]: 17:00
              - group "Wednesday opening hours" [ref=f1e117]:
                - generic [ref=f1e118]: Wed
                - checkbox "Open on Wednesday" [checked] [ref=f1e119]
                - textbox "Wednesday opening time" [ref=f1e120]: 09:00
                - generic [ref=f1e121]: –
                - textbox "Wednesday closing time" [ref=f1e122]: 17:00
              - group "Thursday opening hours" [ref=f1e123]:
                - generic [ref=f1e124]: Thu
                - checkbox "Open on Thursday" [checked] [ref=f1e125]
                - textbox "Thursday opening time" [ref=f1e126]: 09:00
                - generic [ref=f1e127]: –
                - textbox "Thursday closing time" [ref=f1e128]: 17:00
              - group "Friday opening hours" [ref=f1e129]:
                - generic [ref=f1e130]: Fri
                - checkbox "Open on Friday" [checked] [ref=f1e131]
                - textbox "Friday opening time" [ref=f1e132]: 09:00
                - generic [ref=f1e133]: –
                - textbox "Friday closing time" [ref=f1e134]: 17:00
              - group "Saturday opening hours" [ref=f1e135]:
                - generic [ref=f1e136]: Sat
                - checkbox "Open on Saturday" [ref=f1e137]
                - generic [ref=f1e138]: Closed
              - group "Sunday opening hours" [ref=f1e139]:
                - generic [ref=f1e140]: Sun
                - checkbox "Open on Sunday" [ref=f1e141]
                - generic [ref=f1e142]: Closed
          - group "Services & prices" [ref=f1e143]:
            - button "Add Services & prices item" [ref=f1e145]: + Add another
          - group "Holidays & special closures" [ref=f1e146]:
            - button "Add Holidays & special closures item" [ref=f1e148]: + Add another
          - group "FAQ" [ref=f1e149]:
            - button "Add FAQ item" [ref=f1e151]: + Add another
      - generic [ref=f1e152]:
        - generic [ref=f1e153]:
          - heading "Primary assistant" [level=2] [ref=f1e154]
          - paragraph [ref=f1e155]: These legacy settings apply to your first assistant. Manage additional assistants in the Assistants menu.
        - generic [ref=f1e156]:
          - generic [ref=f1e157]:
            - generic [ref=f1e158]:
              - generic [ref=f1e159]: Agent name
              - textbox "Agent name" [ref=f1e161]: Accepted later server assistant
            - generic [ref=f1e162]:
              - generic [ref=f1e163]: Language
              - combobox "Language" [ref=f1e164]:
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
          - generic [ref=f1e165]:
            - generic [ref=f1e166]: Personality
            - textbox "Personality" [ref=f1e168]: friendly and professional
          - generic [ref=f1e169]:
            - generic [ref=f1e170]: Greeting
            - textbox "Greeting" [ref=f1e172]:
              - /placeholder: Leave empty for the default greeting.
          - generic [ref=f1e173]:
            - generic [ref=f1e174]: Voice (Azure TTS)
            - combobox "Voice (Azure TTS)" [ref=f1e176]
            - generic [ref=f1e177]: Default is en-US-AvaMultilingualNeural, one natural voice for all languages. A custom voice applies to your default language only.
          - generic [ref=f1e178]:
            - checkbox "Take messages when the agent can't help" [checked] [ref=f1e179]
            - text: Take messages when the agent can't help
          - generic [ref=f1e180]:
            - generic [ref=f1e181]: Extra instructions
            - textbox "Extra instructions" [ref=f1e183]:
              - /placeholder: Anything else your receptionist should know or do.
      - generic [ref=f1e184]:
        - generic [ref=f1e185]:
          - heading "Engine profiles" [level=2] [ref=f1e186]
          - paragraph [ref=f1e187]: Saved combinations of engine, model, language, and voices — apply one to switch the whole setup at once.
        - generic [ref=f1e188]:
          - paragraph [ref=f1e189]: Up to 64 profiles are shown. Long historical values are previews and cannot be renamed here; applying uses the full saved configuration. Delete unused profiles to reveal more.
          - paragraph [ref=f1e190]: No profiles yet. Configure the engine below, then save it here under a name.
          - paragraph [ref=f1e191]: If you click Apply or Delete profile while a name is saving, click it again after saving finishes.
          - generic [ref=f1e192]:
            - textbox "Save current setup as… e.g. \"Realtime HD English (Emma)\"" [ref=f1e193]
            - button "Save profile" [disabled] [ref=f1e194]
      - generic [ref=f1e195]:
        - generic [ref=f1e196]:
          - heading "AI provider" [level=2] [ref=f1e197]
          - paragraph [ref=f1e198]: Provider endpoint and credentials are shared by all assistants. Engine and voice settings below apply to your primary assistant. OpenFon speaks the OpenAI API dialect — point it at Kataleptic, OpenAI, Groq, Ollama, or your own server. Empty model and endpoint fields use instance defaults; saved API keys stay until explicitly replaced or removed.
        - generic [ref=f1e199]:
          - generic [ref=f1e200]:
            - generic [ref=f1e201]: Voice engine
            - generic [ref=f1e202]:
              - generic [ref=f1e203]:
                - radio "Pipeline — transcribe → think → speak. Uses separate transcription, text generation, and speech synthesis settings." [checked] [ref=f1e204]
                - generic [ref=f1e205]:
                  - strong [ref=f1e206]: Pipeline
                  - text: — transcribe → think → speak. Uses separate transcription, text generation, and speech synthesis settings.
              - generic [ref=f1e207]:
                - radio "Realtime — streams audio both ways and supports interruptions. Requires a configured realtime provider." [ref=f1e208]
                - generic [ref=f1e209]:
                  - strong [ref=f1e210]: Realtime
                  - text: — streams audio both ways and supports interruptions. Requires a configured realtime provider.
          - generic [ref=f1e211]:
            - generic [ref=f1e212]: Assistant text model override
            - textbox "Assistant text model override" [ref=f1e214]
            - generic [ref=f1e215]: Blank uses the workspace text model above.
      - generic [ref=f1e216]:
        - paragraph [ref=f1e217]: Changes apply on the next call
        - generic [ref=f1e218]:
          - alert [ref=f1e219]: Local load unavailable
          - button "Retry settings refresh" [ref=f1e220]
          - button "Save changes" [ref=f1e221]
  - contentinfo [ref=f1e222]:
    - generic [ref=f1e224]:
      - paragraph [ref=f1e225]:
        - text: OpenFon — open-source AI phone agent.
        - link "github.com/duguetlabs/openfon" [ref=f1e226] [cursor=pointer]:
          - /url: https://github.com/duguetlabs/openfon
      - paragraph [ref=f1e227]: self-hosted · MIT licensed
```

# Test source

```ts
  1   | import { test, expect } from './fixtures';
  2   | import type { Page, Route } from '@playwright/test';
  3   | 
  4   | const providerSave = (page: Page) => page.getByRole('button', { name: 'Save provider settings', exact: true });
  5   | const retrySettings = (page: Page) => page.getByRole('button', { name: 'Retry settings refresh', exact: true });
  6   | const alert = (page: Page, text: string) => page.getByRole('alert').filter({ hasText: text });
  7   | function latch() {
  8   |   let release!: () => void;
  9   |   const gate = new Promise<void>(resolve => { release = resolve; });
  10  |   return { gate, release };
  11  | }
  12  | async function rendered(page: Page) {
  13  |   await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  14  | }
  15  | async function openSettings(page: Page, label: string, withProfile = false) {
  16  |   await page.goto('/auth');
  17  |   await page.getByLabel('Email').fill(`load-owner-${label}-${Date.now()}@example.invalid`);
  18  |   await page.getByLabel('Password', { exact: true }).fill('Synthetic-Load-Ownership-1234');
  19  |   await page.getByRole('button', { name: 'Create account', exact: true }).click();
  20  |   await page.getByLabel('Business name', { exact: true }).fill('Load ownership workshop');
  21  |   await page.getByLabel('What do you do?').fill('Synthetic load ownership validation');
  22  |   await page.getByRole('button', { name: 'Continue →' }).click();
  23  |   await page.getByRole('button', { name: 'Continue →' }).click();
  24  |   await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  25  |   await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  26  |   const business = await (await page.request.get('/api/me/business')).json();
  27  |   let profileId = '';
  28  |   if (withProfile) {
  29  |     const response = await page.request.post(`/api/me/business/${business.id}/profiles`, {
  30  |       data: { name: 'Retained profile', engine: 'pipeline', language: 'fr', voice: '', llm_model: '' },
  31  |     });
  32  |     expect(response.status()).toBe(201); profileId = (await response.json()).id;
  33  |   }
  34  |   await page.goto('/settings');
  35  |   await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Load ownership workshop');
  36  |   await expect(providerSave(page)).toBeEnabled();
  37  |   if (withProfile) await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  38  |   return { businessId: business.id as string, profileId };
  39  | }
  40  | // Installed only after Settings loaded. Each explicit provider refresh has a
  41  | // session GET first and effect-local Settings GET second. Every selected boundary
  42  | // is counted/awaited; APIRequestContext setup writes do not traverse page routes.
  43  | async function businessReads(page: Page, selected: Record<number, (route: Route) => Promise<void>>) {
  44  |   const state = { reads: 0, delivered: [] as number[] };
  45  |   await page.route('**/api/me/business', async route => {
  46  |     if (route.request().method() !== 'GET') return route.continue();
  47  |     const ordinal = ++state.reads;
  48  |     if (selected[ordinal]) await selected[ordinal](route);
  49  |     else { const response = await route.fetch(); await route.fulfill({ response }); }
  50  |     state.delivered.push(ordinal);
  51  |   });
  52  |   return state;
  53  | }
  54  | async function serverMarker(page: Page, businessId: string, marker: string) {
  55  |   expect((await page.request.put(`/api/me/business/${businessId}/agent`, { data: { agent_name: marker } })).ok()).toBe(true);
  56  | }
  57  | 
  58  | test('accepted automatic settings read clears only an earlier local load failure and retains drafts', async ({ page }) => {
  59  |   const { businessId } = await openSettings(page, 'clear');
  60  |   const reads = await businessReads(page, { 2: async route => { await route.fulfill({ status: 503, json: { error: 'Local load unavailable' } }); } });
  61  |   await providerSave(page).click();
  62  |   await expect(alert(page, 'Local load unavailable')).toBeVisible();
  63  |   await expect(retrySettings(page)).toBeVisible(); expect(reads.reads).toBe(2);
  64  |   await page.getByLabel('Name', { exact: true }).fill('Newer unsaved business draft');
  65  |   await serverMarker(page, businessId, 'Accepted later server assistant');
  66  |   await providerSave(page).click();
  67  |   await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Accepted later server assistant');
  68  |   await expect.poll(() => reads.delivered.includes(4)).toBe(true);
  69  |   console.log('settings-load-diagnostic', JSON.stringify({ reads: reads.reads, delivered: reads.delivered, loadAlerts: await alert(page, 'Local load unavailable').count() }));
> 70  |   await expect(alert(page, 'Local load unavailable')).toHaveCount(0);
      |                                                       ^ Error: expect(locator).toHaveCount(expected) failed
  71  |   await expect(retrySettings(page)).toHaveCount(0);
  72  |   await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Newer unsaved business draft');
  73  |   expect((await (await page.request.get('/api/me/business')).json()).name).toBe('Load ownership workshop');
  74  | });
  75  | 
  76  | for (const late of ['success', 'failure'] as const) {
  77  |   test(`superseded local ${late} cannot change the newer load outcome`, async ({ page }) => {
  78  |     const { businessId } = await openSettings(page, `stale-${late}`);
  79  |     const hold = latch(); let captured = false;
  80  |     const reads = await businessReads(page, {
  81  |       2: async route => {
  82  |         const response = await route.fetch(); captured = true; await hold.gate;
  83  |         if (late === 'success') await route.fulfill({ response });
  84  |         else await route.fulfill({ status: 503, json: { error: 'Superseded load failure' } });
  85  |       },
  86  |       4: async route => {
  87  |         if (late === 'success') await route.fulfill({ status: 503, json: { error: 'Current load failure' } });
  88  |         else { const response = await route.fetch(); await route.fulfill({ response }); }
  89  |       },
  90  |     });
  91  |     try {
  92  |       await providerSave(page).click(); await expect.poll(() => captured).toBe(true);
  93  |       await serverMarker(page, businessId, 'New current assistant');
  94  |       await providerSave(page).click();
  95  |       if (late === 'success') await expect(alert(page, 'Current load failure')).toBeVisible();
  96  |       else await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('New current assistant');
  97  |       await expect.poll(() => reads.delivered.includes(4)).toBe(true);
  98  |       hold.release(); await expect.poll(() => reads.delivered.includes(2)).toBe(true); await rendered(page);
  99  |       expect(reads.reads).toBe(4);
  100 |       if (late === 'success') {
  101 |         await expect(alert(page, 'Current load failure')).toBeVisible(); await expect(retrySettings(page)).toBeVisible();
  102 |       } else {
  103 |         await expect(alert(page, 'Superseded load failure')).toHaveCount(0); await expect(retrySettings(page)).toHaveCount(0);
  104 |         await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('New current assistant');
  105 |       }
  106 |     } finally { hold.release(); }
  107 |   });
  108 | }
  109 | 
  110 | for (const mutation of ['create', 'rename'] as const) {
  111 |   test(`accepted settings read preserves a newer ${mutation} refusal with identical error text`, async ({ page }) => {
  112 |     const { businessId, profileId } = await openSettings(page, `mutation-${mutation}`, mutation === 'rename');
  113 |     const hold = latch(); let captured = false, writes = 0;
  114 |     const reads = await businessReads(page, {
  115 |       2: async route => { await route.fulfill({ status: 503, json: { error: 'Same ownership message' } }); },
  116 |       4: async route => { const response = await route.fetch(); captured = true; await hold.gate; await route.fulfill({ response }); },
  117 |     });
  118 |     try {
  119 |       await providerSave(page).click(); await expect(alert(page, 'Same ownership message')).toBeVisible();
  120 |       await serverMarker(page, businessId, 'Accepted after mutation error');
  121 |       await providerSave(page).click(); await expect.poll(() => captured).toBe(true);
  122 |       await page.route(mutation === 'create' ? `**/api/me/business/${businessId}/profiles` : `**/api/me/profiles/${profileId}`, async route => {
  123 |         if (route.request().method() !== (mutation === 'create' ? 'POST' : 'PUT')) return route.continue();
  124 |         writes++; await route.fulfill({ status: 503, json: { error: 'Same ownership message' } });
  125 |       });
  126 |       if (mutation === 'create') {
  127 |         await page.getByPlaceholder(/Save current setup as/).fill('Retained create draft');
  128 |         await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  129 |         await expect(page.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
  130 |       } else {
  131 |         // The row input has no label; its acknowledged exact value identifies it.
  132 |         await page.locator('input[value="Retained profile"]').fill('Refused rename');
  133 |         await page.getByLabel('Name', { exact: true }).focus();
  134 |         await expect(page.locator('input[value="Retained profile"]')).toBeVisible();
  135 |       }
  136 |       await expect.poll(() => writes).toBe(1); await expect(alert(page, 'Same ownership message')).toBeVisible();
  137 |       await page.getByLabel('Name', { exact: true }).fill('Newer draft after refusal');
  138 |       hold.release(); await expect.poll(() => reads.delivered.includes(4)).toBe(true);
  139 |       await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Accepted after mutation error');
  140 |       await expect(alert(page, 'Same ownership message')).toBeVisible();
  141 |       await expect(retrySettings(page)).toHaveCount(0);
  142 |       await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Newer draft after refusal');
  143 |       if (mutation === 'create') await expect(page.getByPlaceholder(/Save current setup as/)).toHaveValue('Retained create draft');
  144 |       expect(writes).toBe(1);
  145 |     } finally { hold.release(); }
  146 |   });
  147 | }
  148 | 
  149 | for (const operation of ['apply', 'delete'] as const) {
  150 |   test(`independent accepted settings read retains confirmed ${operation} display recovery`, async ({ page }) => {
  151 |     const { businessId, profileId } = await openSettings(page, `profile-${operation}`, true);
  152 |     let writes = 0, failRead = false;
  153 |     await page.route(url => url.pathname.includes('/profiles') || url.pathname === '/api/me', async route => {
  154 |       const request = route.request();
  155 |       if (request.method() !== 'GET') {
  156 |         writes++; const response = await route.fetch(); expect(response.ok()).toBe(true); failRead = true;
  157 |         return route.fulfill({ response });
  158 |       }
  159 |       if (failRead && (operation === 'apply' ? new URL(request.url()).pathname === '/api/me' : request.url().includes('/profiles'))) {
  160 |         failRead = false; return route.fulfill({ status: 503, json: { error: 'Profile display unavailable' } });
  161 |       }
  162 |       return route.continue();
  163 |     });
  164 |     await page.getByRole('button', { name: operation === 'apply' ? 'Apply' : 'Delete profile', exact: true }).click();
  165 |     await expect(alert(page, 'The profile change was saved')).toBeVisible();
  166 |     await serverMarker(page, businessId, 'Independent accepted snapshot');
  167 |     await page.getByLabel('Name', { exact: true }).fill('Later unsaved workspace');
  168 |     await providerSave(page).click();
  169 |     await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Independent accepted snapshot');
  170 |     await expect(alert(page, 'The profile change was saved')).toBeVisible();
```