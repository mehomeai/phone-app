import { expect, test } from '@playwright/test';
import { GOOGLE_OAUTH_SCOPES, GOOGLE_SERVICES, googleServiceCredentialKey } from '../../lib/google-oauth';

test('uses narrow Google scopes and keeps service credentials isolated by profile', () => {
  expect(GOOGLE_SERVICES).toEqual(['google-calendar', 'google-drive']);
  expect(GOOGLE_OAUTH_SCOPES.gmail).toBe('https://www.googleapis.com/auth/gmail.readonly');
  expect(GOOGLE_OAUTH_SCOPES['google-calendar']).toBe('https://www.googleapis.com/auth/calendar.events.readonly');
  expect(GOOGLE_OAUTH_SCOPES['google-drive']).toBe('https://www.googleapis.com/auth/drive.file');
  expect(googleServiceCredentialKey('profile-maya', 'google-calendar')).not.toBe(
    googleServiceCredentialKey('profile-theo', 'google-calendar'),
  );
  expect(googleServiceCredentialKey('profile-maya', 'google-calendar')).not.toBe(
    googleServiceCredentialKey('profile-maya', 'google-drive'),
  );
});

// ADAPTED to phone-app (Batch 4, Codex direction: group 5 = adapt, no
// production changes). The Replit original expected gmail / calendar /
// drive toggles DISABLED with a 'Native app only' label on web and
// 'Preview only' badges (`connector-preview-*`) on 17 other services.
// Phone-app's AppsPanel makes no native-connection claim at all: its
// header states "These controls are previews; no account data is
// accessed", and every service — Google ones included — is an enabled
// preview toggle (`connector-toggle-*`) that flips Add/Added locally.
// This test pins that phone contract instead; the native-vs-preview
// distinction is a deferred Replit behavior, tracked in the Batch 4
// disposition table.
test('treats every connector, Google services included, as a local preview toggle on web', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();
  await page.getByTestId('skip-onboarding').click();
  await page.getByRole('tab', { name: 'Me' }).click();
  await page.getByTestId('me-mode-apps').click();

  await expect(page.getByText('These controls are previews; no account data is accessed.')).toBeVisible();

  for (const id of ['gmail', 'google-calendar', 'google-drive']) {
    const toggle = page.getByTestId(`connector-toggle-${id}`);
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeEnabled();
    await expect(toggle).toContainText('Add');
  }

  // Toggling is local preview state only: it flips Add/Added (and its
  // accessibility label) and back, without any connection flow.
  const gmail = page.getByTestId('connector-toggle-gmail');
  await expect(gmail).toHaveAttribute('aria-label', 'Add Gmail to preview');
  await gmail.click();
  await expect(gmail).toContainText('Added');
  await expect(gmail).toHaveAttribute('aria-label', 'Remove Gmail from preview');
  await gmail.click();
  await expect(gmail).toContainText('Add');
  await expect(gmail).toHaveAttribute('aria-label', 'Add Gmail to preview');

  for (const id of [
    'outlook',
    'apple-calendar',
    'microsoft-calendar',
    'google-docs',
    'google-sheets',
    'google-photos',
    'onedrive',
    'dropbox',
    'slack',
    'teams',
    'notion',
    'github',
    'linear',
    'todoist',
    'contacts',
    'spotify',
    'youtube',
  ]) {
    const toggle = page.getByTestId(`connector-toggle-${id}`);
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeEnabled();
    await expect(toggle).toContainText('Add');
  }
});
