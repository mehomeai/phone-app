import { expect, test } from '@playwright/test';

test('plays the redirected bridge clip in the mobile feed preview', async ({ page }) => {
  const cdnResponses: number[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).hostname === 'dn710703.ca.archive.org') {
      cdnResponses.push(response.status());
    }
  });

  await page.addInitScript(() => {
    localStorage.setItem('me-demo-state-v1', JSON.stringify({
      profiles: [{ id: 'playback-test-profile', name: 'Jordan Rivera', role: 'parent' }],
      activeProfileId: 'playback-test-profile',
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

  const video = page.locator(
    'video[src="https://archive.org/download/NASA-Animations/Animation_HTV_Approach-Grapple-Berth_350059.mp4"]',
  );
  await expect(video).toHaveCount(1);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0.5);

  const startTime = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(startTime + 0.75);
  expect(cdnResponses.some((status) => status === 200 || status === 206)).toBe(true);
});

test('shows a retry state when a feed clip never finishes loading', async ({ page }) => {
  let releaseRequest!: () => void;
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route('https://archive.org/download/NASA-Animations/Animation_HTV_Approach-Grapple-Berth_350059.mp4', async (route) => {
    await requestGate;
    try {
      await route.fulfill({ status: 200, contentType: 'video/mp4', body: '' });
    } catch {
      // The timed-out media request may already be closed.
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem('me-demo-state-v1', JSON.stringify({
      profiles: [{ id: 'feed-timeout-profile', name: 'Jordan Rivera', role: 'parent' }],
      activeProfileId: 'feed-timeout-profile',
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
  await expect(page.getByText('Loading clip…').first()).toBeVisible();
  await expect(page.getByText('This clip could not load.')).toBeVisible({ timeout: 17_000 });
  await expect(page.getByText('This clip took too long to load. Try again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  releaseRequest();
});
