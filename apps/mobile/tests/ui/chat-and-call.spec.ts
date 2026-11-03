import { expect, test, type Page } from '@playwright/test';

async function openChat(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();
  await page.getByTestId('skip-onboarding').click();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__meUiTestStarted') !== 'true') {
      localStorage.clear();
      sessionStorage.setItem('__meUiTestStarted', 'true');
    }
  });
});

test('starts clean drafts, resets them, saves the first message, and reopens the exchange', async ({ page }) => {
  await openChat(page);
  const input = page.getByTestId('chat-input');

  await expect(input).toHaveValue('');
  await input.fill('This draft should not follow me');
  await page.getByRole('tab', { name: 'Feed' }).click();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await expect(input).toHaveValue('');

  await input.fill('Discard this draft too');
  await page.getByTestId('new-chat').click();
  await expect(input).toHaveValue('');

  const message = `Chat smoke ${Date.now().toString(36)}`;
  await input.fill(message);
  await page.getByTestId('chat-send').click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  const reply = 'Here is how I would think about it. Name the one thing that matters most to you here, then we can work backwards from that.';
  await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: 7_000 });

  await page.reload();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.getByTestId('chat-history').click();
  await expect(page.getByTestId('chat-history-list')).toBeVisible();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await page.getByText(message, { exact: true }).click();

  await expect(page.getByTestId('chat-input')).toBeVisible();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
});

test('keeps a deleted conversation gone when its delayed reply arrives and after reload', async ({ page }) => {
  await openChat(page);
  const message = `Delete before reply ${Date.now().toString(36)}`;
  await page.getByTestId('chat-input').fill(message);
  await page.getByTestId('chat-send').click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();

  await page.getByTestId('chat-history').click();
  await expect(page.getByTestId('chat-history-list')).toBeVisible();
  const deleteButton = page.getByRole('button', { name: `Delete ${message}` });
  await expect(deleteButton).toBeVisible();
  const confirmation = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain('removed from this device');
    await dialog.accept();
  });
  await deleteButton.click();
  await confirmation;
  await expect(page.getByText(message, { exact: true })).toHaveCount(0);

  // Scripted replies arrive after a random delay of 1.4–2.3 seconds.
  await page.waitForTimeout(2_600);
  await expect(page.getByText(message, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Delete ${message}` })).toHaveCount(0);

  await page.reload();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.getByTestId('chat-history').click();
  await expect(page.getByText(message, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Delete ${message}` })).toHaveCount(0);
});

test('keeps each profile chat history private when switching profiles in Me settings', async ({ page }) => {
  await openChat(page);

  const mayaMessage = `Maya note ${Date.now().toString(36)}`;
  await page.getByTestId('chat-input').fill(mayaMessage);
  await page.getByTestId('chat-send').click();
  const mayaReply = 'Here is how I would think about it. Name the one thing that matters most to you here, then we can work backwards from that.';
  await expect(page.getByText(mayaReply, { exact: true })).toBeVisible({ timeout: 7_000 });

  await page.getByRole('tab', { name: 'Me' }).click();
  await page.getByTestId('me-mode-settings').click();
  await page.getByTestId('use-profile-p-theo').click();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.getByTestId('chat-history').click();
  await expect(page.getByTestId('chat-history-list')).toBeVisible();
  await expect(page.getByText(mayaMessage, { exact: true })).toHaveCount(0);
  await expect(page.getByText('Why do bridges sway?', { exact: true })).toBeVisible();

  await page.getByTestId('new-chat').click();
  const theoMessage = `Theo note ${Date.now().toString(36)}`;
  await page.getByTestId('chat-input').fill(theoMessage);
  await page.getByTestId('chat-send').click();
  const theoReply = 'Interesting. How could we check if that is true instead of just trusting me?';
  await expect(page.getByText(theoReply, { exact: true })).toBeVisible({ timeout: 7_000 });

  await page.getByRole('tab', { name: 'Me' }).click();
  await page.getByTestId('me-mode-settings').click();
  await page.getByTestId('use-profile-p-maya').click();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.getByTestId('chat-history').click();
  await expect(page.getByText(mayaMessage, { exact: true })).toBeVisible();
  await expect(page.getByText(theoMessage, { exact: true })).toHaveCount(0);
  await page.getByText(mayaMessage, { exact: true }).click();
  await expect(page.getByText(mayaReply, { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Me' }).click();
  await page.getByTestId('me-mode-settings').click();
  await page.getByTestId('use-profile-p-theo').click();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.getByTestId('chat-history').click();
  await expect(page.getByText(theoMessage, { exact: true })).toBeVisible();
  await expect(page.getByText(mayaMessage, { exact: true })).toHaveCount(0);
  await page.getByText(theoMessage, { exact: true }).click();
  await expect(page.getByText(theoReply, { exact: true })).toBeVisible();
});

test('starts, mutes, locks, ends calls, and clears the call timer', async ({ page }) => {
  await page.addInitScript(() => {
    const activeIntervals = new Set<number>();
    const originalSetInterval = window.setInterval.bind(window);
    const originalClearInterval = window.clearInterval.bind(window);

    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = originalSetInterval(handler, timeout, ...args);
      activeIntervals.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      if (id !== undefined) activeIntervals.delete(id);
      originalClearInterval(id);
    }) as typeof window.clearInterval;
    Object.defineProperty(window, '__e2eActiveIntervals', { value: activeIntervals });
  });

  await openChat(page);
  const intervalCountBeforeCall = await page.evaluate(
    () => (window as unknown as Window & { __e2eActiveIntervals: Set<number> }).__e2eActiveIntervals.size,
  );
  await page.getByTestId('start-mock-call').click();

  const callStatus = page.getByTestId('call-status');
  await expect(callStatus).toContainText('SIMULATED');
  await expect.poll(async () => page.evaluate(
    () => (window as unknown as Window & { __e2eActiveIntervals: Set<number> }).__e2eActiveIntervals.size,
  )).toBeGreaterThan(intervalCountBeforeCall);
  await expect(callStatus).toContainText('00:01', { timeout: 3_000 });

  await page.getByTestId('mute-call').click();
  await expect(page.getByTestId('mute-call')).toHaveAttribute('aria-label', 'Unmute simulated call');
  await page.getByTestId('mute-call').click();
  await expect(page.getByTestId('mute-call')).toHaveAttribute('aria-label', 'Mute simulated call');

  const chatCallButton = page.getByTestId('start-mock-call');
  await expect(chatCallButton, 'The chat call button should remain locked while a call is active').toBeDisabled();

  await page.getByTestId('hang-up').click();
  await expect(page.getByTestId('chat-history')).toBeVisible();
  await expect(chatCallButton).toBeEnabled();
  await expect.poll(async () => page.evaluate(
    () => (window as unknown as Window & { __e2eActiveIntervals: Set<number> }).__e2eActiveIntervals.size,
  )).toBe(intervalCountBeforeCall);
});
