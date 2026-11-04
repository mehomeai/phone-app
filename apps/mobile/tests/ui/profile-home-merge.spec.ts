import { expect, test } from '@playwright/test';

test('keeps the overview and Me Home connection together in the Me profile', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();
  await page.getByTestId('skip-onboarding').click();
  await page.getByRole('tab', { name: 'Me' }).click();

  await expect(page.getByTestId('me-mode-me')).toBeVisible();
  await expect(page.getByTestId('me-mode-home')).toHaveCount(0);
  await expect(page.getByTestId('me-mode-device')).toHaveCount(0);
  await expect(page.getByText('Good to see you, Maya.')).toBeVisible();
  await expect(page.getByTestId('me-home-url')).toBeVisible();
  await expect(page.getByTestId('me-home-token')).toBeVisible();

  await page.getByTestId('me-mode-apps').click();
  await expect(page.getByTestId('connector-toggle-gmail')).toBeVisible();
  await page.getByTestId('me-mode-settings').click();
  await expect(page.getByText('Household', { exact: true })).toBeVisible();
  await page.getByTestId('me-mode-me').click();
  await expect(page.getByTestId('me-home-url')).toBeVisible();
});
