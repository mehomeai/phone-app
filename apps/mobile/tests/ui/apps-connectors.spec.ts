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

test('distinguishes native Google connections from preview-only services on web', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();
  await page.getByTestId('skip-onboarding').click();
  await page.getByRole('tab', { name: 'Me' }).click();
  await page.getByTestId('me-mode-apps').click();

  const gmail = page.getByTestId('connector-toggle-gmail');
  await expect(gmail).toBeVisible();
  await expect(gmail).toBeDisabled();
  await expect(gmail).toContainText('Native app only');
  const calendar = page.getByTestId('connector-toggle-google-calendar');
  const drive = page.getByTestId('connector-toggle-google-drive');
  await expect(calendar).toBeVisible();
  await expect(calendar).toBeDisabled();
  await expect(calendar).toContainText('Native app only');
  await expect(drive).toBeVisible();
  await expect(drive).toBeDisabled();
  await expect(drive).toContainText('Native app only');
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
    await expect(page.getByTestId(`connector-preview-${id}`)).toContainText('Preview only');
  }
});
