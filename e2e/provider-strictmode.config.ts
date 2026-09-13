import { defineConfig, devices } from '@playwright/test';

// Isolated component browser: route fixtures serve the actual React development
// bundle so StrictMode effect replay is exercised without a Worker or live API.
export default defineConfig({
  testDir: '.', testMatch: 'provider-strictmode.spec.ts', workers: 1, retries: 0,
  timeout: 30_000, use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
});
