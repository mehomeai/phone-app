import { expect, test } from '@playwright/test';

// DEFERRED (Batch 4, Codex direction: feed usage/source link = defer,
// no surface this batch). Phone-app's feed has no usage-terms link or
// source-review label for any clip (no `usage-*` testID exists), while
// the Replit feed shows one for clips without clear terms. Porting it
// needs the Replit feed data model (per-clip usage terms + source URL),
// which is a feed feature decision, not a harness fix. Marked fixme so
// the suite stays honest; un-fixme when the feed gains the surface.
test.fixme('shows a review label and a source link for clips without clear terms', async ({ page }) => {
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
