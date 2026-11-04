const { existsSync } = require('node:fs');
const { defineConfig, devices } = require('@playwright/test');

// Dedicated config for tests/ui/error-boundary.spec.ts ONLY.
// Its webServer builds the app with EXPO_PUBLIC_TEST_ERROR_BOUNDARY=true
// (see app/index.tsx: a session-guarded one-time crash fixture). That env
// var must never leak into the main suite's build — every other spec
// would start on the crash screen — so this config uses its own port and
// build, and playwright.config.js testIgnores the spec.
const replitChromium = '/repl/tools/bin/chromium';
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync(replitChromium) ? replitChromium : undefined);

module.exports = defineConfig({
  testDir: './tests/ui',
  testMatch: '**/error-boundary.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4174',
    viewport: { width: 400, height: 720 },
    launchOptions: {
      executablePath,
      args: ['--no-sandbox'],
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run test:web:error-boundary',
    url: 'http://127.0.0.1:4174',
    env: { PORT: '4174' },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
