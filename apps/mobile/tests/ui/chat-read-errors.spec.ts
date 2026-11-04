import { expect, test, type Page } from '@playwright/test';

const storageKey = 'me-demo-state-v1';
const privateTitle = 'Private recovery title marker';
const privateMessage = 'Private recovery message marker';
const chatId = 'private-recovery-chat';

function authorizedState() {
  return {
    profiles: [{ id: 'household-owner', name: 'Jordan Rivera', role: 'parent' }],
    activeProfileId: 'household-owner',
    conversations: [{
      id: chatId,
      profileId: 'household-owner',
      title: privateTitle,
      messages: [{ id: 'private-recovery-message', role: 'user', text: privateMessage, createdAt: 1 }],
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
    liked: [],
    saved: [],
    onboardingCompleted: true,
  };
}

async function installReadScenario(page: Page, scenario: 'throw' | 'delay' | 'invalid-json' | 'invalid-structure') {
  const state = authorizedState();
  if (scenario === 'invalid-structure') {
    state.conversations[0].messages = null as never;
  }
  await page.addInitScript(({ key, savedState, readScenario }) => {
    const testWindow = window as unknown as Window & {
      __savedBytes: string;
      __originalGetState: () => string | null;
      __resolveDelayedStateRead?: () => void;
      __releaseDelayedStateRead?: () => void;
    };
    const malformedJson = '{"private":"Storage details must stay hidden"';
    const bytes = readScenario === 'invalid-json' ? malformedJson : JSON.stringify(savedState);
    localStorage.setItem(key, bytes);
    testWindow.__savedBytes = bytes;
    const originalGetItem = Storage.prototype.getItem;
    testWindow.__originalGetState = () => originalGetItem.call(localStorage, key);
    let reads = 0;
    Storage.prototype.getItem = function (requestedKey: string) {
      if (requestedKey === key) {
        reads += 1;
        if (reads === 1 && readScenario === 'throw') {
          throw new DOMException('Private storage diagnostic detail', 'SecurityError');
        }
        if (reads === 1 && readScenario === 'delay') {
          return new Promise<string>((resolve) => {
            testWindow.__releaseDelayedStateRead = () => resolve(testWindow.__originalGetState() ?? '');
            testWindow.__resolveDelayedStateRead = () => testWindow.__releaseDelayedStateRead?.();
          }) as unknown as string;
        }
      }
      return originalGetItem.call(this, requestedKey);
    };
  }, { key: storageKey, savedState: state, readScenario: scenario });
}

async function expectPrivateChatHidden(page: Page) {
  await expect(page.getByText(privateTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByText(privateMessage, { exact: true })).toHaveCount(0);
  for (const testId of [
    'chat-input',
    'chat-send',
    'start-mock-call',
    'use-chat-browser',
    'stop-reply',
    'retry-chat-send',
  ]) {
    await expect(page.getByTestId(testId)).toHaveCount(0);
  }
}

async function expectSafeReadError(page: Page) {
  await expect(page.getByTestId('local-data-read-error')).toHaveText('Could not read local data');
  await expect(page.getByTestId('retry-local-data-read')).toBeVisible();
  await expectPrivateChatHidden(page);
  const visibleText = await page.locator('body').innerText();
  expect(visibleText).not.toContain(chatId);
  expect(visibleText).not.toContain('Private storage diagnostic detail');
  expect(visibleText).not.toContain('Storage details must stay hidden');
}

async function expectAuthorizedChat(page: Page) {
  await expect(page.getByText(privateTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(privateMessage, { exact: true })).toBeVisible();
  await expect(page.getByTestId('chat-input')).toBeVisible();
}

test('fails closed after a thrown read, preserves bytes, and opens an authorized chat after retry', async ({ page }) => {
  await installReadScenario(page, 'throw');
  await page.goto(`/chat/${chatId}`);

  await expectSafeReadError(page);
  expect(await page.evaluate(() =>
    (window as unknown as Window & { __originalGetState: () => string | null }).__originalGetState(),
  )).toBe(await page.evaluate(() => (window as unknown as Window & { __savedBytes: string }).__savedBytes));

  await page.getByTestId('retry-local-data-read').click();
  await expectAuthorizedChat(page);
});

test('keeps a direct chat private while its first storage read is delayed', async ({ page }) => {
  await installReadScenario(page, 'delay');
  await page.goto(`/chat/${chatId}`);

  await expect(page.getByTestId('local-data-read-error')).toHaveCount(0);
  await expectPrivateChatHidden(page);
  await expect(page.getByTestId('retry-local-data-read')).toHaveCount(0);

  await page.evaluate(() => {
    (window as unknown as Window & { __resolveDelayedStateRead?: () => void }).__resolveDelayedStateRead?.();
  });
  await expectAuthorizedChat(page);
});

test('rejects malformed JSON without changing saved bytes and retries into a valid authorized chat', async ({ page }) => {
  await installReadScenario(page, 'invalid-json');
  await page.goto(`/chat/${chatId}`);

  await expectSafeReadError(page);
  const savedBytes = await page.evaluate(() =>
    (window as unknown as Window & { __originalGetState: () => string | null }).__originalGetState(),
  );
  expect(savedBytes).toBe('{"private":"Storage details must stay hidden"');

  await page.evaluate((nextState) => {
    localStorage.setItem('me-demo-state-v1', JSON.stringify(nextState));
  }, authorizedState());
  await page.getByTestId('retry-local-data-read').click();
  await expectAuthorizedChat(page);
});

test('rejects malformed conversation records and retries to the unavailable-chat screen', async ({ page }) => {
  await installReadScenario(page, 'invalid-structure');
  await page.goto(`/chat/${chatId}`);

  await expectSafeReadError(page);
  const originalBytes = await page.evaluate(() =>
    (window as unknown as Window & { __originalGetState: () => string | null }).__originalGetState(),
  );
  expect(originalBytes).toContain('"messages":null');
  expect(originalBytes).toBe(await page.evaluate(() => (window as unknown as Window & { __savedBytes: string }).__savedBytes));

  await page.evaluate((nextState) => {
    nextState.conversations[0].profileId = 'another-profile';
    localStorage.setItem('me-demo-state-v1', JSON.stringify(nextState));
  }, authorizedState());
  await page.getByTestId('retry-local-data-read').click();
  await expect(page.getByTestId('chat-access-denied')).toBeVisible();
  await expect(page.getByText(privateMessage, { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('chat-input')).toHaveCount(0);
});

test('does not restore seeded chat content from a saved snapshot with no conversations', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('me-demo-state-v1', JSON.stringify({
      profiles: [{ id: 'p-maya', name: 'Maya', role: 'parent' }],
      activeProfileId: 'p-maya',
      settings: { assistantMode: 'demo', homeUrl: '', model: 'me-balanced', learningMix: 50, topics: [], approvalRequired: false },
      onboardingCompleted: true,
    }));
  });
  await page.goto('/chat/c-seed-1');

  await expect(page.getByTestId('chat-access-denied')).toBeVisible();
  for (const savedSeedText of [
    'Talking to Theo about the test result',
    'Theo failed his science test and he is ashamed. How do I bring it up tonight without making it worse?',
    'Start with curiosity, not the grade. Ask which question felt hardest and what he tried. Let him explain his thinking before you offer yours.',
  ]) {
    await expect(page.getByText(savedSeedText, { exact: true })).toHaveCount(0);
  }
  await expectPrivateChatHidden(page);
});
