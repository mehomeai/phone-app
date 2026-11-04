import { expect, test, type Page } from '@playwright/test';

const savedState = {
  profiles: [{ id: 'household-owner', name: 'Jordan Rivera', role: 'parent' }],
  activeProfileId: 'household-owner',
  conversations: [{
    id: 'existing-chat',
    profileId: 'household-owner',
    title: 'A conversation to keep',
    messages: [{ id: 'existing-message', role: 'user', text: 'Keep this conversation.', createdAt: 1 }],
    assistantMode: 'demo',
  }],
  settings: {
    assistantMode: 'demo',
    homeUrl: '',
    model: 'me-balanced',
    learningMix: 31,
    topics: ['Space'],
    approvalRequired: false,
  },
  liked: ['bridge'],
  saved: ['bees'],
};

async function installState(page: Page, state: object) {
  await page.addInitScript((value) => {
    if (sessionStorage.getItem('__onboardingPersistenceSeeded') === 'true') return;
    localStorage.setItem('me-demo-state-v1', JSON.stringify(value));
    sessionStorage.setItem('__onboardingPersistenceSeeded', 'true');
  }, state);
}

async function failStateWrites(page: Page) {
  await page.evaluate(() => {
    type TestWindow = Window & { __failMeStateWrites: boolean };
    const testWindow = window as unknown as TestWindow;
    testWindow.__failMeStateWrites = true;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'me-demo-state-v1' && testWindow.__failMeStateWrites) {
        throw new DOMException('Simulated local-storage write failure', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    };
  });
}

async function restoreStateWrites(page: Page) {
  await page.evaluate(() => {
    (window as unknown as Window & { __failMeStateWrites: boolean }).__failMeStateWrites = false;
  });
}

async function readStoredState(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? 'null'));
}

async function expectSavedDataUnchanged(page: Page) {
  await expect.poll(async () => {
    const stored = await readStoredState(page);
    return stored && typeof stored.onboardingCompleted === 'boolean';
  }).toBe(true);

  const stored = await readStoredState(page);
  expect(stored).toMatchObject(savedState);
}

test('shows setup on a new install, and skip preserves saved profile and demo data', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();

  await page.getByTestId('skip-onboarding').click();
  await expect.poll(async () => (await readStoredState(page))?.onboardingCompleted).toBe(true);

  const afterSkip = await readStoredState(page);
  expect(afterSkip.profiles).toBeTruthy();
  expect(afterSkip.conversations).toBeTruthy();
  expect(afterSkip.settings).toBeTruthy();
  expect(afterSkip.liked).toEqual([]);
  expect(afterSkip.saved).toEqual([]);

  await page.reload();
  await expect(page.getByTestId('skip-onboarding')).toHaveCount(0);
});

test('recovers from blocked and stalled storage reads without replacing saved setup data', async ({ page }) => {
  await page.addInitScript((state) => {
    const key = 'me-demo-state-v1';
    localStorage.setItem(key, JSON.stringify(state));
    const originalGetItem = Storage.prototype.getItem;
    let reads = 0;
    Storage.prototype.getItem = function (requestedKey: string) {
      if (requestedKey === key) {
        reads += 1;
        if (reads === 1) throw new DOMException('Storage access is blocked', 'SecurityError');
        if (reads === 2) return new Promise(() => {}) as unknown as string;
      }
      return originalGetItem.call(this, requestedKey);
    };
  }, { ...savedState, onboardingCompleted: false });

  await page.goto('/');
  const retry = page.getByText('Try again', { exact: true });
  await expect(page.getByText('Could not read local data')).toBeVisible();
  await expect(retry).toBeVisible();

  await retry.click();
  await expect(page.getByText('Could not read local data')).toBeVisible({ timeout: 12_000 });
  await retry.click();
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();
  await expectSavedDataUnchanged(page);
});

test('a reload during setup returns to setup without changing saved profile data', async ({ page }) => {
  await installState(page, { ...savedState, onboardingCompleted: false });
  await page.goto('/');
  await expect(page.getByText('STEP 1 OF 4')).toBeVisible();

  await page.getByTestId('onboarding-next').click();
  await expect(page.getByText('STEP 2 OF 4')).toBeVisible();
  await page.reload();

  await expect(page.getByText('STEP 1 OF 4')).toBeVisible();
  await expect(page.getByTestId('onboarding-next')).toBeVisible();
  await expectSavedDataUnchanged(page);
  expect((await readStoredState(page)).onboardingCompleted).toBe(false);
});

test('skipping setup does not replace an existing profile or demo data', async ({ page }) => {
  await installState(page, { ...savedState, onboardingCompleted: false });
  await page.goto('/');
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();

  await page.getByTestId('skip-onboarding').click();
  await expectSavedDataUnchanged(page);
  expect((await readStoredState(page)).onboardingCompleted).toBe(true);

  await page.reload();
  await expect(page.getByTestId('skip-onboarding')).toHaveCount(0);
  await expectSavedDataUnchanged(page);
});

test('keeps setup open and offers retry when skipping cannot be saved', async ({ page }) => {
  await installState(page, { ...savedState, onboardingCompleted: false });
  await page.goto('/');
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();
  await failStateWrites(page);

  await page.getByTestId('skip-onboarding').click();

  const setupError = page.getByTestId('setup-save-error');
  await expect(setupError).toBeVisible();
  await expect(setupError).toContainText('Setup couldn’t be saved');
  await expect(setupError).toContainText(/previously saved profiles and conversations are intact/i);
  await expect(page.getByTestId('retry-setup-save')).toBeVisible();
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();

  const afterFailedSkip = await readStoredState(page);
  expect(afterFailedSkip.onboardingCompleted).toBe(false);
  expect(afterFailedSkip).toMatchObject(savedState);

  await restoreStateWrites(page);
  await page.getByTestId('retry-setup-save').click();
  await expect(page.getByTestId('skip-onboarding')).toHaveCount(0);
  await expect.poll(async () => (await readStoredState(page))?.onboardingCompleted).toBe(true);
  await expectSavedDataUnchanged(page);

  await page.reload();
  await expect(page.getByTestId('skip-onboarding')).toHaveCount(0);
  await expectSavedDataUnchanged(page);
});

test('continues with an in-memory setup and persists it only after retry succeeds', async ({ page }) => {
  await installState(page, { ...savedState, onboardingCompleted: false });
  await page.goto('/');
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();
  await failStateWrites(page);

  await page.getByTestId('skip-onboarding').click();
  await expect(page.getByTestId('setup-save-error')).toBeVisible();
  await page.getByTestId('continue-setup-session').click();

  await expect(page.getByTestId('skip-onboarding')).toHaveCount(0);
  const warning = page.getByTestId('storage-save-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('only in memory for this session');
  const beforeRetry = await readStoredState(page);
  expect(beforeRetry.onboardingCompleted).toBe(false);
  expect(beforeRetry).toMatchObject(savedState);

  await restoreStateWrites(page);
  await page.getByTestId('retry-storage-save').click();
  await expect.poll(async () => (await readStoredState(page))?.onboardingCompleted).toBe(true);
  await expect(page.getByTestId('storage-save-warning')).toHaveCount(0);
  await expectSavedDataUnchanged(page);

  await page.reload();
  await expect(page.getByTestId('skip-onboarding')).toHaveCount(0);
  await expectSavedDataUnchanged(page);
});

test('keeps setup incomplete when finishing cannot be saved', async ({ page }) => {
  await installState(page, { ...savedState, onboardingCompleted: false });
  await page.goto('/');
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();

  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId('onboarding-next').click();
  }
  await expect(page.getByTestId('finish-onboarding')).toBeVisible();
  await failStateWrites(page);
  await page.getByTestId('finish-onboarding').click();

  const setupError = page.getByTestId('setup-save-error');
  await expect(setupError).toBeVisible();
  await expect(setupError).toContainText('Setup couldn’t be saved');
  await expect(page.getByTestId('retry-setup-save')).toBeVisible();
  await expect(page.getByTestId('finish-onboarding')).toBeVisible();

  const afterFailedFinish = await readStoredState(page);
  expect(afterFailedFinish.onboardingCompleted).toBe(false);
  expect(afterFailedFinish).toMatchObject(savedState);

  await page.reload();
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();
  await expectSavedDataUnchanged(page);
});

test('a legacy saved install without a setup flag is migrated without losing data', async ({ page }) => {
  await installState(page, savedState);
  await page.goto('/');

  await expect(page.getByTestId('skip-onboarding')).toHaveCount(0);
  await expect.poll(async () => (await readStoredState(page))?.onboardingCompleted).toBe(true);
  await expectSavedDataUnchanged(page);
});

test('replaying and completing setup preserves saved data and stays completed', async ({ page }) => {
  await installState(page, { ...savedState, onboardingCompleted: true });
  await page.goto('/');
  await expect(page.getByTestId('skip-onboarding')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Me' }).click();
  await page.getByTestId('me-mode-settings').click();
  await page.getByTestId('replay-onboarding').click();
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();

  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId('onboarding-next').click();
  }
  await page.getByTestId('finish-onboarding').click();

  await expectSavedDataUnchanged(page);
  expect((await readStoredState(page)).onboardingCompleted).toBe(true);
  await page.reload();
  await expect(page.getByTestId('skip-onboarding')).toHaveCount(0);
  await expectSavedDataUnchanged(page);
});
