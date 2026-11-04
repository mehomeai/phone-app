import { expect, test } from '@playwright/test';

const originalState = {
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
  onboardingCompleted: false,
};

test('adds and activates a household profile during setup without replacing saved data', async ({ page }) => {
  await page.addInitScript((state) => {
    localStorage.setItem('me-demo-state-v1', JSON.stringify(state));
  }, originalState);

  await page.goto('/');
  await expect(page.getByTestId('onboarding-add-profile')).toBeVisible();
  await page.getByTestId('onboarding-add-profile').click();
  await page.getByTestId('onboarding-profile-name').fill('Avery Rivera');
  await page.getByTestId('onboarding-profile-role-child').click();
  await page.getByTestId('onboarding-create-profile').click();

  const newProfile = page.getByRole('radio', { name: 'Avery Rivera, Child' });
  await expect(newProfile).toBeVisible();
  await page.waitForFunction(() => {
    const stored = localStorage.getItem('me-demo-state-v1');
    return stored ? JSON.parse(stored).profiles.some((profile: { name: string }) => profile.name === 'Avery Rivera') : false;
  });

  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
  expect(persisted.profiles).toHaveLength(2);
  expect(persisted.profiles.find((profile: { name: string }) => profile.name === 'Avery Rivera')).toMatchObject({
    id: persisted.activeProfileId,
    role: 'child',
  });
  expect(persisted.conversations).toEqual(originalState.conversations);
  expect(persisted.settings).toEqual(originalState.settings);
  expect(persisted.liked).toEqual([]);
  expect(persisted.saved).toEqual([]);
  expect(persisted.clipCollectionsByProfile['household-owner']).toEqual({ liked: originalState.liked, saved: originalState.saved });
  expect(persisted.clipCollectionsByProfile[persisted.activeProfileId]).toEqual({ liked: [], saved: [] });

  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId('onboarding-next').click();
  }
  await page.getByTestId('finish-onboarding').click();

  await expect.poll(async () => {
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? 'null'));
    return stored?.onboardingCompleted;
  }).toBe(true);
  const completedState = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
  expect(completedState.profiles).toHaveLength(2);
  expect(completedState.conversations).toEqual(originalState.conversations);
  expect(completedState.settings).toEqual(originalState.settings);
  expect(completedState.liked).toEqual([]);
  expect(completedState.saved).toEqual([]);
  expect(completedState.clipCollectionsByProfile['household-owner']).toEqual({ liked: originalState.liked, saved: originalState.saved });

  await page.getByRole('tab', { name: 'Me' }).click();
  await page.getByTestId('me-mode-settings').click();
  await expect(page.getByText('Avery Rivera')).toBeVisible();
  await expect(page.getByText('CHILD  ·  THIS PHONE')).toBeVisible();
  await expect(page.getByText('Jordan Rivera')).toBeVisible();
});

test('adds two household members and keeps their profile details and chat histories separate', async ({ page }) => {
  await page.addInitScript((state) => {
    localStorage.setItem('me-demo-state-v1', JSON.stringify(state));
  }, originalState);

  await page.goto('/');
  const addMember = async (name: string, role: 'child' | 'adult', roleLabel: string) => {
    await page.getByTestId('onboarding-add-profile').click();
    await page.getByTestId('onboarding-profile-name').fill(name);
    await page.getByTestId(`onboarding-profile-role-${role}`).click();
    await page.getByTestId('onboarding-create-profile').click();
    await expect(page.getByRole('radio', { name: `${name}, ${roleLabel}` })).toBeVisible();
  };

  await addMember('Avery Rivera', 'child', 'Child');
  await addMember('Morgan Rivera', 'adult', 'Adult');

  const setupState = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
  expect(setupState.profiles).toHaveLength(3);
  const avery = setupState.profiles.find((profile: { name: string }) => profile.name === 'Avery Rivera');
  const morgan = setupState.profiles.find((profile: { name: string }) => profile.name === 'Morgan Rivera');
  expect(avery).toMatchObject({ role: 'child' });
  expect(morgan).toMatchObject({ role: 'adult' });
  expect(avery.id).not.toBe(morgan.id);
  expect(setupState.activeProfileId).toBe(morgan.id);
  expect(setupState.conversations).toEqual(originalState.conversations);
  expect(setupState.settings).toEqual(originalState.settings);

  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId('onboarding-next').click();
  }
  await page.getByTestId('finish-onboarding').click();
  await expect(page.getByTestId('skip-onboarding')).toHaveCount(0);

  const morganMessage = `Morgan private note ${Date.now().toString(36)}`;
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.getByTestId('chat-input').fill(morganMessage);
  await page.getByTestId('chat-send').click();
  await expect(page.getByText(morganMessage, { exact: true })).toBeVisible();

  const selectProfile = async (profileId: string) => {
    await page.getByRole('tab', { name: 'Me' }).click();
    await page.getByTestId('me-mode-settings').click();
    await page.getByTestId(`use-profile-${profileId}`).click();
    await page.getByRole('tab', { name: 'Chat' }).click();
  };

  await selectProfile(avery.id);
  await page.getByTestId('chat-history').click();
  await expect(page.getByTestId('chat-history-list')).toBeVisible();
  await expect(page.getByText(morganMessage, { exact: true })).toHaveCount(0);
  await page.getByTestId('new-chat').click();

  const averyMessage = `Avery private note ${Date.now().toString(36)}`;
  await page.getByTestId('chat-input').fill(averyMessage);
  await page.getByTestId('chat-send').click();
  await expect(page.getByText(averyMessage, { exact: true })).toBeVisible();

  await selectProfile(morgan.id);
  await page.getByTestId('chat-history').click();
  await expect(page.getByText(morganMessage, { exact: true })).toBeVisible();
  await expect(page.getByText(averyMessage, { exact: true })).toHaveCount(0);

  const finalState = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
  const morganChats = finalState.conversations.filter((conversation: { profileId: string }) => conversation.profileId === morgan.id);
  const averyChats = finalState.conversations.filter((conversation: { profileId: string }) => conversation.profileId === avery.id);
  expect(morganChats.some((conversation: { messages: { text: string }[] }) =>
    conversation.messages.some((message) => message.text === morganMessage),
  )).toBe(true);
  expect(morganChats.some((conversation: { messages: { text: string }[] }) =>
    conversation.messages.some((message) => message.text === averyMessage),
  )).toBe(false);
  expect(averyChats.some((conversation: { messages: { text: string }[] }) =>
    conversation.messages.some((message) => message.text === averyMessage),
  )).toBe(true);
  expect(averyChats.some((conversation: { messages: { text: string }[] }) =>
    conversation.messages.some((message) => message.text === morganMessage),
  )).toBe(false);
});

test('keeps a completed two-member setup and separate chats after a force-close relaunch', async ({ page, browser }) => {
  await page.addInitScript((state) => {
    localStorage.setItem('me-demo-state-v1', JSON.stringify(state));
  }, originalState);
  await page.goto('/');

  const addMember = async (name: string, role: 'child' | 'adult', roleLabel: string) => {
    await page.getByTestId('onboarding-add-profile').click();
    await page.getByTestId('onboarding-profile-name').fill(name);
    await page.getByTestId(`onboarding-profile-role-${role}`).click();
    await page.getByTestId('onboarding-create-profile').click();
    await expect(page.getByRole('radio', { name: `${name}, ${roleLabel}` })).toBeVisible();
  };
  await addMember('Avery Rivera', 'child', 'Child');
  await addMember('Morgan Rivera', 'adult', 'Adult');

  const setupState = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
  const avery = setupState.profiles.find((profile: { name: string }) => profile.name === 'Avery Rivera');
  const morgan = setupState.profiles.find((profile: { name: string }) => profile.name === 'Morgan Rivera');
  expect(setupState.activeProfileId).toBe(morgan.id);

  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId('onboarding-next').click();
  }
  await page.getByTestId('finish-onboarding').click();
  await expect(page.getByRole('tab', { name: 'Chat' })).toBeVisible();
  await expect.poll(async () => {
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
    return stored.onboardingCompleted;
  }).toBe(true);

  const morganMessage = `Morgan restart note ${Date.now().toString(36)}`;
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.getByTestId('chat-input').fill(morganMessage);
  await page.getByTestId('chat-send').click();
  await expect(page.getByText(morganMessage, { exact: true })).toBeVisible();

  const selectProfile = async (profileId: string) => {
    await page.getByRole('tab', { name: 'Me' }).click();
    await page.getByTestId('me-mode-settings').click();
    await page.getByTestId(`use-profile-${profileId}`).click();
    await page.getByRole('tab', { name: 'Chat' }).click();
  };
  await selectProfile(avery.id);
  const averyMessage = `Avery restart note ${Date.now().toString(36)}`;
  await page.getByTestId('chat-input').fill(averyMessage);
  await page.getByTestId('chat-send').click();
  await expect(page.getByText(averyMessage, { exact: true })).toBeVisible();

  await page.waitForFunction(([morganText, averyText]) => {
    const state = JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}');
    const messages = state.conversations?.flatMap((conversation: { messages?: { text: string }[] }) =>
      conversation.messages?.map((message) => message.text) ?? [],
    ) ?? [];
    return messages.includes(morganText) && messages.includes(averyText);
  }, [morganMessage, averyMessage]);

  const storageState = await page.context().storageState();
  const appUrl = new URL('/', page.url()).toString();
  await page.close();

  const reopenedContext = await browser.newContext({
    storageState,
    viewport: { width: 402, height: 874 },
  });
  try {
    const reopenedPage = await reopenedContext.newPage();
    await reopenedPage.goto(appUrl);
    await expect(reopenedPage.getByRole('tab', { name: 'Feed' })).toBeVisible();
    await expect(reopenedPage.getByTestId('skip-onboarding')).toHaveCount(0);

    const restored = await reopenedPage.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
    expect(restored.onboardingCompleted).toBe(true);
    expect(restored.profiles).toHaveLength(3);
    expect(restored.profiles.find((profile: { name: string }) => profile.name === 'Avery Rivera')).toMatchObject({
      id: avery.id,
      role: 'child',
    });
    expect(restored.profiles.find((profile: { name: string }) => profile.name === 'Morgan Rivera')).toMatchObject({
      id: morgan.id,
      role: 'adult',
    });
    expect(restored.activeProfileId).toBe(avery.id);

    await reopenedPage.getByRole('tab', { name: 'Chat' }).click();
    await reopenedPage.getByTestId('chat-history').click();
    await expect(reopenedPage.getByText(averyMessage, { exact: true }).first()).toBeVisible();
    await expect(reopenedPage.getByText(morganMessage, { exact: true })).toHaveCount(0);

    await reopenedPage.getByRole('tab', { name: 'Me' }).click();
    await reopenedPage.getByTestId('me-mode-settings').click();
    await reopenedPage.getByTestId(`use-profile-${morgan.id}`).click();
    await reopenedPage.getByRole('tab', { name: 'Chat' }).click();
    await reopenedPage.getByTestId('chat-history').click();
    await expect(reopenedPage.getByText(morganMessage, { exact: true }).first()).toBeVisible();
    await expect(reopenedPage.getByText(averyMessage, { exact: true })).toHaveCount(0);
  } finally {
    await reopenedContext.close();
  }
});

test('recovers an added profile after reload without duplicating it or exposing the previous profile chat', async ({ page }) => {
  await page.addInitScript((state) => {
    if (sessionStorage.getItem('__onboardingProfileRecoverySeeded') === 'true') return;
    localStorage.setItem('me-demo-state-v1', JSON.stringify(state));
    sessionStorage.setItem('__onboardingProfileRecoverySeeded', 'true');
  }, originalState);

  await page.goto('/');
  await page.getByTestId('onboarding-add-profile').click();
  await page.getByTestId('onboarding-profile-name').fill('Avery Rivera');
  await page.getByTestId('onboarding-profile-role-child').click();
  await page.getByTestId('onboarding-create-profile').click();
  await expect.poll(async () => {
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? 'null'));
    return stored?.profiles?.length;
  }).toBe(2);

  await page.reload();
  await expect(page.getByText('STEP 1 OF 4')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Avery Rivera, Child' })).toBeVisible();

  const afterReload = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
  const averyId = afterReload.profiles.find((profile: { name: string }) => profile.name === 'Avery Rivera').id;
  expect(afterReload.profiles).toHaveLength(2);
  expect(afterReload.activeProfileId).toBe(averyId);
  expect(afterReload.conversations).toEqual(originalState.conversations);
  expect(afterReload.settings).toEqual(originalState.settings);
  expect(afterReload.liked).toEqual(originalState.liked);
  expect(afterReload.saved).toEqual(originalState.saved);

  await page.getByTestId('onboarding-add-profile').click();
  await page.getByTestId('onboarding-profile-name').fill('Avery Rivera');
  await page.getByTestId('onboarding-profile-role-child').click();
  await page.getByTestId('onboarding-create-profile').click();
  await expect.poll(async () => {
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? 'null'));
    return stored?.profiles?.length;
  }).toBe(2);
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'))).activeProfileId).toBe(averyId);

  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId('onboarding-next').click();
  }
  await page.getByTestId('finish-onboarding').click();
  await expect(page.getByTestId('skip-onboarding')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('skip-onboarding')).toHaveCount(0);
  const afterCompletionReload = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
  expect(afterCompletionReload.onboardingCompleted).toBe(true);
  expect(afterCompletionReload.profiles).toHaveLength(2);

  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.getByTestId('chat-history').click();
  await expect(page.getByTestId('chat-history-list')).toBeVisible();
  await expect(page.getByText('A conversation to keep', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Keep this conversation.', { exact: true })).toHaveCount(0);

  await page.getByRole('tab', { name: 'Me' }).click();
  await page.getByTestId('me-mode-settings').click();
  await page.getByTestId('use-profile-household-owner').click();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.getByTestId('chat-history').click();
  await expect(page.getByText('A conversation to keep', { exact: true })).toBeVisible();
  await expect(page.getByText('Keep this conversation.', { exact: true })).toBeVisible();
});

test('keeps a failed profile save recoverable and persists one complete member on retry', async ({ page }) => {
  await page.addInitScript((state) => {
    if (sessionStorage.getItem('__onboardingProfileFailureSeeded') === 'true') return;
    localStorage.setItem('me-demo-state-v1', JSON.stringify(state));
    sessionStorage.setItem('__onboardingProfileFailureSeeded', 'true');
  }, originalState);
  await page.goto('/');
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

  await page.getByTestId('onboarding-add-profile').click();
  await page.getByTestId('onboarding-profile-name').fill('Avery Rivera');
  await page.getByTestId('onboarding-profile-role-child').click();
  await page.getByTestId('onboarding-create-profile').click();
  await expect(page.getByTestId('setup-memory-warning')).toBeVisible();

  const beforeRetry = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
  expect(beforeRetry).toMatchObject(originalState);
  expect(beforeRetry.profiles).toHaveLength(1);
  await expect(page.getByRole('radio', { name: 'Avery Rivera, Child' })).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as Window & { __failMeStateWrites: boolean }).__failMeStateWrites = false;
  });
  await page.getByTestId('retry-setup-draft-save').click();
  await expect(page.getByTestId('setup-memory-warning')).toHaveCount(0);
  await expect.poll(async () => {
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? 'null'));
    return stored?.profiles?.length;
  }).toBe(2);

  await page.reload();
  await expect(page.getByText('STEP 1 OF 4')).toBeVisible();
  const afterReload = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
  expect(afterReload.profiles).toHaveLength(2);
  expect(afterReload.profiles.filter((profile: { name: string }) => profile.name === 'Avery Rivera')).toHaveLength(1);
  expect(afterReload.conversations).toEqual(originalState.conversations);
  expect(afterReload.settings).toEqual(originalState.settings);
  expect(afterReload.liked).toEqual(originalState.liked);
  expect(afterReload.saved).toEqual(originalState.saved);
});
