import { expect, test } from '@playwright/test';

test('chat history date filters narrow results and still combine with search', async ({ page }) => {
  const now = Date.now();
  const state = {
    profiles: [{ id: 'date-filter-profile', name: 'Jordan Rivera', role: 'parent' }],
    activeProfileId: 'date-filter-profile',
    conversations: [
      { id: 'date-today', profileId: 'date-filter-profile', title: 'Today chat', createdAt: now - 3_600_000, messages: [{ id: 'today-message', role: 'user', text: 'needle current', createdAt: now - 3_600_000 }] },
      { id: 'date-recent', profileId: 'date-filter-profile', title: 'Recent chat', messages: [{ id: 'recent-message', role: 'user', text: 'needle recent', createdAt: now - 5 * 86_400_000 }] },
      { id: 'date-empty-draft', profileId: 'date-filter-profile', title: 'Recent draft', createdAt: now - 2 * 86_400_000, messages: [] },
      { id: 'date-old', profileId: 'date-filter-profile', title: 'Older chat', createdAt: now - 40 * 86_400_000, messages: [{ id: 'old-message', role: 'user', text: 'needle old', createdAt: now - 40 * 86_400_000 }] },
    ],
    settings: { assistantMode: 'demo', homeUrl: '', model: 'me-balanced', learningMix: 50, topics: ['Engineering'], approvalRequired: true },
    liked: [],
    saved: [],
    onboardingCompleted: true,
  };
  await page.addInitScript((savedState) => localStorage.setItem('me-demo-state-v1', JSON.stringify(savedState)), state);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.getByTestId('chat-history').click();

  await expect(page.getByTestId('conv-date-today')).toBeVisible();
  await expect(page.getByTestId('conv-date-recent')).toBeVisible();
  await expect(page.getByTestId('conv-date-empty-draft')).toHaveCount(0);
  await expect(page.getByTestId('conv-date-old')).toBeVisible();
  await page.getByTestId('chat-history-search').fill('no-such-match');
  await expect(page.getByText('No matches', { exact: true })).toBeVisible();
  await page.getByTestId('chat-history-search-clear').click();

  await page.getByTestId('chat-history-date-today').click();
  await expect(page.getByTestId('conv-date-today')).toBeVisible();
  await expect(page.getByTestId('conv-date-recent')).toHaveCount(0);
  await expect(page.getByTestId('conv-date-empty-draft')).toHaveCount(0);

  await page.getByTestId('chat-history-date-7days').click();
  await expect(page.getByTestId('conv-date-today')).toBeVisible();
  await expect(page.getByTestId('conv-date-recent')).toBeVisible();
  await expect(page.getByTestId('conv-date-empty-draft')).toHaveCount(0);
  await expect(page.getByTestId('conv-date-old')).toHaveCount(0);
  await page.getByTestId('chat-history-search').fill('needle old');
  await expect(page.getByText('No matches', { exact: true })).toBeVisible();
  await page.getByTestId('chat-history-search-clear').click();

  await page.getByTestId('chat-history-search').fill('needle');
  await expect(page.getByTestId('conv-date-today')).toBeVisible();
  await expect(page.getByTestId('conv-date-recent')).toBeVisible();
  await expect(page.getByTestId('conv-date-old')).toHaveCount(0);
});
