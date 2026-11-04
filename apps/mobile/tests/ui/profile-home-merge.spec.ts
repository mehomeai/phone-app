import { expect, test } from '@playwright/test';

// ADAPTED to phone-app (Batch 4, Codex direction: group 5 = adapt, no
// production changes). The Replit original expected a merged Me layout:
// a single `me-mode-me` panel holding the overview greeting AND the
// Me Home connection fields (`me-home-url` / `me-home-token`), with no
// separate home/device modes. Phone-app's Me screen deliberately keeps
// four modes — `me-mode-home` (overview), `me-mode-device` (Me Home
// pairing), `me-mode-apps`, `me-mode-settings` — and its pairing form
// uses a home URL + invitation id/secret (no raw token field). This
// test pins the phone layout: overview and the Me Home connection live
// one tap apart inside Me, and switching modes loses nothing.
test('keeps the overview and Me Home connection together inside the Me tab modes', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();
  await page.getByTestId('skip-onboarding').click();
  await page.getByRole('tab', { name: 'Me' }).click();

  // Overview is the default Me mode; there is no Replit-style merged
  // `me-mode-me` panel in this copy.
  await expect(page.getByTestId('me-mode-home')).toBeVisible();
  await expect(page.getByTestId('me-mode-me')).toHaveCount(0);
  await expect(page.getByText('Good to see you, Maya.')).toBeVisible();

  // The Me Home connection lives in its own mode, one tap away.
  await page.getByTestId('me-mode-device').click();
  await expect(page.getByTestId('me-home-url')).toBeVisible();
  await expect(page.getByTestId('me-home-invitation-id')).toBeVisible();

  await page.getByTestId('me-mode-apps').click();
  await expect(page.getByTestId('connector-toggle-gmail')).toBeVisible();
  await page.getByTestId('me-mode-settings').click();
  await expect(page.getByText('Household', { exact: true })).toBeVisible();
  await page.getByTestId('me-mode-home').click();
  await expect(page.getByText('Good to see you, Maya.')).toBeVisible();
});
