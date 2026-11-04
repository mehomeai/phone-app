import { expect, test } from '@playwright/test';

test('feed controls expose labels and selected state to assistive technology', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('me-demo-state-v1', JSON.stringify({
      profiles: [{ id: 'feed-a11y-profile', name: 'Jordan Rivera', role: 'parent' }],
      activeProfileId: 'feed-a11y-profile',
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

  const openControls = page.getByRole('button', { name: 'Open feed controls' });
  await expect(openControls).toBeVisible();
  await openControls.click();

  const mix = page.getByRole('radiogroup', { name: 'Learning mix' });
  const balanced = mix.getByRole('radio', { name: 'Balanced, 50% toward focus' });
  await expect(balanced).toHaveAttribute('aria-checked', 'true');
  const mostlyFocused = mix.getByRole('radio', { name: 'Mostly my topics, 75% toward focus' });
  await mostlyFocused.click();
  await expect(mostlyFocused).toHaveAttribute('aria-checked', 'true');

  const engineering = page.getByRole('checkbox', { name: 'Engineering' });
  await expect(engineering).toHaveAttribute('aria-checked', 'true');
  await engineering.click();
  await expect(engineering).toHaveAttribute('aria-checked', 'false');

  await page.getByRole('button', { name: 'Close feed controls' }).click();
  const like = page.getByRole('checkbox', { name: 'Like clip' }).first();
  const save = page.getByRole('checkbox', { name: 'Save clip' }).first();
  await expect(like).toHaveAttribute('aria-checked', 'false');
  await expect(save).toHaveAttribute('aria-checked', 'false');
  await like.click();
  await save.click();
  await expect(page.getByRole('checkbox', { name: 'Remove like' }).first()).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('checkbox', { name: 'Remove saved clip' }).first()).toHaveAttribute('aria-checked', 'true');
});
