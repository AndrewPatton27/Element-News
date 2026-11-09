// End-to-end smoke test against the sample (mock) data, on a phone and a desktop viewport.
//   npm run test:e2e
// First run on a machine without Chrome: `npx playwright install chromium` (or set PW_CHANNEL=chrome
// to use an installed Chrome, PW_CHANNEL=msedge for Edge). The test starts Expo's web dev server
// itself unless one is already running on E2E_PORT (default 8099).

import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 8099);
const channel = process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    channel,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    // Mock mode is the default; blank env guarantees no Supabase calls even if a .env exists.
    command: `npx expo start --web --port ${port} --non-interactive`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 240_000,
    env: { EXPO_PUBLIC_API_MODE: 'mock', CI: '' },
  },
});
