import { expect, test, type Page } from '@playwright/test';

// ADAPTED to phone-app (Batch 4, Codex direction: split spec-by-spec;
// group 5 = adapt, no production changes).
// The Replit original drove an in-chat browser tool that does not exist
// in phone-app: there is no `use-chat-browser` composer entry, no
// browser-request field, and no in-app page preview / action-approval
// flow (browser-load-button, browser-page-preview, browser-ask-me,
// browser-review-action). Phone-app's browser is a deliberate chooser:
// it opens pages ONLY through the system browser after an explicit tap
// (app/browser.tsx: "Pages open only after you choose them"), with
// `open-chat-browser` on the Chats screen and `browser-address` /
// `browser-open` fields. The preview-before-action and stalled-load
// timeout/retry behaviors are therefore NOT asserted here — they are a
// deferred feature gap, tracked in the Batch 4 disposition table, not a
// behavior this copy claims. What this spec pins is the phone contract:
// browser entry from Chat, no site is contacted before the user acts,
// and the open action stays disabled until an address exists.

async function openChat(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('skip-onboarding')).toBeVisible();
  await page.getByTestId('skip-onboarding').click();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__meBrowserTestStarted') !== 'true') {
      localStorage.clear();
      sessionStorage.setItem('__meBrowserTestStarted', 'true');
    }
  });
});

test('opens the browser from chat and contacts no site before the user acts', async ({ page }) => {
  const siteRequests: string[] = [];
  await page.route('https://example.com/**', async (route) => {
    siteRequests.push(route.request().method());
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>must not be fetched</p>' });
  });

  await openChat(page);
  await page.getByTestId('open-chat-browser').click();

  const address = page.getByTestId('browser-address');
  await expect(address).toBeVisible();
  await expect(address).toHaveValue('');
  // Nothing to open yet: the open action is disabled with no address.
  await expect(page.getByTestId('browser-open')).toBeDisabled();
  await expect(page.getByText('Pages open only after you choose them.')).toBeVisible();
  await expect(page.getByTestId('browser-site-wikipedia')).toBeVisible();
  expect(siteRequests).toEqual([]);

  await address.fill('https://example.com/report');
  await expect(page.getByTestId('browser-open')).toBeEnabled();
  // Typing an address still contacts nothing; opening is a separate,
  // explicit user action (system browser, outside this web preview).
  expect(siteRequests).toEqual([]);
});

test('starts with a fresh address each time the browser is opened', async ({ page }) => {
  // The browser screen holds the address in local state and unmounts on
  // back, so reopening starts empty with the open action disabled —
  // unlike the Replit in-chat tool, which kept the address across a
  // stalled load for its retry. That retention is part of the deferred
  // browser-tool gap, not current phone behavior.
  await openChat(page);
  await page.getByTestId('open-chat-browser').click();
  await page.getByTestId('browser-address').fill('https://example.com/slow');
  await expect(page.getByTestId('browser-address')).toHaveValue('https://example.com/slow');
  await expect(page.getByTestId('browser-open')).toBeEnabled();

  await page.getByTestId('browser-back').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();

  await page.getByTestId('open-chat-browser').click();
  await expect(page.getByTestId('browser-address')).toHaveValue('');
  await expect(page.getByTestId('browser-open')).toBeDisabled();
});
