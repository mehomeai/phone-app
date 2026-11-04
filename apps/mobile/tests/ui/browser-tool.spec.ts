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
    if (sessionStorage.getItem('__meBrowserTestStarted') !== 'true') {
      localStorage.clear();
      sessionStorage.setItem('__meBrowserTestStarted', 'true');
    }
  });
});

test('passes a chat request into the browser and previews the page before any site action', async ({ page }) => {
  const siteRequests: string[] = [];
  await page.route('https://example.com/report', async (route) => {
    siteRequests.push(route.request().method());
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><head><title>Quarterly Update</title><script>ignore this hidden text</script></head><body><main><h1>Shipping update</h1><p>The shipment is delayed until Friday.</p></main></body></html>',
    });
  });

  await openChat(page);
  const request = 'Check this latest update';
  const url = 'https://example.com/report';
  await page.getByTestId('chat-input').fill(`${request}: ${url}`);
  await page.getByTestId('use-chat-browser').click();

  await expect(page.getByTestId('browser-address')).toHaveValue(url);
  await expect(page.getByTestId('browser-request')).toHaveValue(request);
  expect(siteRequests).toEqual([]);

  await page.getByTestId('browser-load-button').click();
  await expect(page.getByTestId('browser-page-preview')).toBeVisible();
  await expect(page.getByTestId('browser-page-title')).toHaveText('Quarterly Update');
  await expect(page.getByTestId('browser-page-content')).toContainText('The shipment is delayed until Friday.');
  await expect(page.getByTestId('browser-page-content')).not.toContainText('ignore this hidden text');
  await expect(page.getByTestId('browser-ask-me')).toBeDisabled();
  await expect(page.getByText('Connect Me Home to analyze page text. This app does not send it to a cloud model.')).toBeVisible();
  expect(siteRequests).toEqual(['GET']);

  await page.getByTestId('browser-review-action').click();
  const preview = page.getByTestId('browser-action-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(request);
  await expect(preview).toContainText(url);
  await expect(preview).toContainText('Nothing has been submitted');
  await expect(page.getByTestId('browser-approve-action')).toBeVisible();
  expect(siteRequests).toEqual(['GET']);
});

test('ends a stalled page load with a retryable error and keeps the address', async ({ page }) => {
  let requests = 0;
  let releaseFirstRequest!: () => void;
  const firstResponseGate = new Promise<void>((resolve) => { releaseFirstRequest = resolve; });
  let firstRequestStarted!: () => void;
  const firstRequest = new Promise<void>((resolve) => { firstRequestStarted = resolve; });

  await page.route('https://example.com/slow', async (route) => {
    requests += 1;
    if (requests === 1) {
      firstRequestStarted();
      await firstResponseGate;
      try {
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Late response</p>' });
      } catch {
        // The app aborts the timed-out request; its retry gets a fresh response.
      }
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Recovered page</title></head><body><p>Retry succeeded.</p></body></html>',
    });
  });

  await openChat(page);
  await page.getByTestId('chat-input').fill('Read https://example.com/slow');
  await page.getByTestId('use-chat-browser').click();
  await expect(page.getByTestId('browser-address')).toHaveValue('https://example.com/slow');
  await page.getByTestId('browser-load-button').click();
  await firstRequest;

  await expect(page.getByText('This page took too long to respond. Check the address and try again.')).toBeVisible({ timeout: 17_000 });
  await expect(page.getByTestId('browser-address')).toHaveValue('https://example.com/slow');
  releaseFirstRequest();
  await page.getByTestId('browser-load-button').click();
  await expect(page.getByTestId('browser-page-title')).toHaveText('Recovered page');
});
