import { fillCatalog, expectCatalog } from './catalog-fields';
import { test, expect, type Route } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let bundle: string;
test.beforeAll(async () => {
  const result = await build({ stdin: { contents: `
    import React, { StrictMode } from 'react';
    import { createRoot } from 'react-dom/client';
    import { createMemoryRouter, RouterProvider, Link, Outlet } from 'react-router-dom';
    import ProviderSettings from './web/src/pages/ProviderSettings';
    import { useUnsavedNavigationGuard } from './web/src/unsaved-edits';
    function Shell() { useUnsavedNavigationGuard(); return <Outlet />; }
    const router = createMemoryRouter([{ element: <Shell />, children: [{ path: '/', element: <><Link to="/away">Leave form</Link><ProviderSettings onSaved={async () => { window.parentRefreshes = (window.parentRefreshes || 0) + 1; }} /></> }, { path:'/away',element:<p>Away</p> }] }]);
    createRoot(document.getElementById('root')).render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  `, resolveDir: resolve(import.meta.dirname, '..'), loader: 'tsx' }, bundle: true, write: false,
    format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
  bundle = result.outputFiles[0].text;
});
const provider = (model = 'baseline') => ({ baseUrl: 'https://instance.example/v1', model, usesInstanceDefault: true,
  apiKeyConfigured: true, workspaceApiKeyConfigured: false, realtime_provider: 'instance', realtime_base_url: '',
  realtime_api_key_configured: false, stt_provider: 'instance', stt_base_url: '', stt_model: '', stt_api_key_configured: false,
  tts_provider: 'browser', presets: [{ id: 'instance', label: 'Instance default', baseUrl: '', model: '' }] });

for (const late of ['success', 'error'] as const) {
  test(`StrictMode ignores obsolete initial ${late} after editing and preserves save recovery`, async ({ page }) => {
    const reads: Route[] = [];
    let writes = 0;
    let savedModel = '';
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/component.js"></script>' });
      if (url.pathname === '/component.js') return route.fulfill({ contentType: 'application/javascript', body: bundle });
      if (url.pathname === '/api/me/provider') {
        if (route.request().method() === 'GET') { reads.push(route); return; }
        writes++; savedModel = route.request().postDataJSON().model;
        return route.fulfill({ json: { ok: true, apiKeyConfigured: true, workspaceApiKeyConfigured: true } });
      }
      return route.abort();
    });
    await page.goto('http://127.0.0.1:8812/');
    await expect.poll(() => reads.length).toBe(2); // Actual StrictMode replay.
    await reads[1].fulfill({ json: provider() });
    await page.locator('#providers details').filter({ has: page.locator('summary').filter({ hasText: 'Text generation' }) }).locator('summary').click();
    const key = page.getByLabel('Text API key', { exact: true });
    await fillCatalog(page, 'Workspace text model', 'unsaved-model');
    await key.fill('synthetic-unsaved-key');
    if (late === 'success') await reads[0].fulfill({ json: provider('stale-model') });
    else await reads[0].fulfill({ status: 503, json: { error: 'stale initial failure' } });
    // Give the fulfilled fetch and React update a deterministic rendering turn.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expectCatalog(page, 'Workspace text model', 'unsaved-model');
    await expect(key).toHaveValue('synthetic-unsaved-key');
    await expect(page.getByRole('alert')).toHaveCount(0);
    let dialogs = 0;
    page.on('dialog', async dialog => { dialogs++; await dialog.dismiss(); });
    await page.getByRole('link', { name: 'Leave form' }).click();
    await expect.poll(() => dialogs).toBe(1);
    await expectCatalog(page, 'Workspace text model', 'unsaved-model');

    await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
    await expect.poll(() => reads.length).toBe(3);
    await reads[2].fulfill({ status: 503, json: { error: 'follow-up read failed' } });
    await expect(page.getByRole('alert')).toContainText('Provider settings were saved');
    await expect(key).toHaveValue('');
    expect(writes).toBe(1); expect(savedModel).toBe('unsaved-model');
    await page.getByRole('button', { name: 'Refresh saved provider settings', exact: true }).click();
    await expect.poll(() => reads.length).toBe(4);
    await reads[3].fulfill({ json: provider(savedModel) });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expectCatalog(page, 'Workspace text model', savedModel);
    expect(writes).toBe(1);
    await page.getByRole('link', { name: 'Leave form' }).click();
    await expect(page.getByText('Away', { exact: true })).toBeVisible();
    expect(dialogs).toBe(1); // Successful persistence cleared the dirty guard.
  });
}
