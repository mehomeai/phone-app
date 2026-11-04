const { existsSync } = require('node:fs');
const { defineConfig, devices } = require('@playwright/test');

const replitChromium = '/repl/tools/bin/chromium';
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync(replitChromium) ? replitChromium : undefined);

module.exports = defineConfig({
  testDir: './tests/ui',
  // The error-boundary spec needs the crash-fixture build
  // (EXPO_PUBLIC_TEST_ERROR_BOUNDARY=true), which would make every other
  // spec start on a crash screen. It runs only under
  // playwright.error-boundary.config.js (`npm run test:ui:error-boundary`).
  testIgnore: ['**/error-boundary.spec.ts'],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 400, height: 720 },
    launchOptions: {
      executablePath,
      args: ['--no-sandbox'],
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run test:web',
    url: 'http://127.0.0.1:4173',
    env: { PORT: '4173' },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
