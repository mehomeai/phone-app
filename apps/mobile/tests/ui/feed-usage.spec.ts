import { expect, test } from '@playwright/test';

test('shows a review label and a source link for clips without clear terms', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('me-demo-state-v1', JSON.stringify({
      profiles: [{ id: 'usage-test-profile', name: 'Jordan Rivera', role: 'parent' }],
      activeProfileId: 'usage-test-profile',
      conversations: [],
      settings: {
        assistantMode: 'demo',
        homeUrl: '',
        model: 'me-balanced',
        learningMix: 50,
        topics: ['Engineering'],
        approvalRequired: true,
      },
      liked: [],
      saved: [],
      onboardingCompleted: true,
    }));
  });

  await page.goto('/');

  const usageLink = page.getByTestId('usage-bridge');
  await expect(usageLink).toBeVisible();
  await expect(usageLink).toHaveAttribute('role', 'link');
  await expect(usageLink).toHaveAttribute(
    'aria-label',
    'Usage terms for How cargo spacecraft dock in orbit: Terms unclear — review source.',
  );
});
