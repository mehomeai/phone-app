import { expect, test } from '@playwright/test';

// Batch 4 disposition (Codex: split spec-by-spec):
// - 'plays the redirected bridge clip' is ENVIRONMENTAL in this VM: it
//   needs direct egress to archive.org / its CDN, which the VM proxy
//   blocks (the clip element reports a format error before any bytes
//   arrive). Kept verbatim; expected to pass where egress is available.
// - 'shows a retry state' is a PORT: phone-app's feed gained the Replit
//   15s load timeout (FEED_LOAD_TIMEOUT_MS in app/(tabs)/feed.tsx) that
//   surfaces 'This clip could not load.' + 'This clip took too long to
//   load. Try again.' + a 'Retry loading clip' retry.
// - 'offers retry when an already-playing feed video stream stalls' is
//   the Nov 4 Replit port (Step 5): the feed's stream-stall timer
//   (FEED_STREAM_STALL_TIMEOUT_MS) turns a mid-playback stall into the
//   interrupted-stream error + retry, exercised against the real
//   playback fixture tests/fixtures/feed-stall.mp4. The PR #12
//   archive.org host-filter fix above is retained unchanged.

test('plays the redirected bridge clip in the mobile feed preview', async ({ page }) => {
  const cdnResponses: number[] = [];
  page.on('response', (response) => {
    const { hostname } = new URL(response.url());
    if (hostname === 'archive.org' || hostname.endsWith('.archive.org')) {
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
  await expect(page.getByRole('button', { name: 'Retry loading clip', exact: true })).toBeVisible();
  releaseRequest();
});

test('offers retry when an already-playing feed video stream stalls', async ({ page }) => {
  const videoUrl = 'https://archive.org/download/NASA-Animations/Animation_HTV_Approach-Grapple-Berth_350059.mp4';
  await page.route(videoUrl, async (route) => {
    await route.fulfill({ status: 200, contentType: 'video/mp4', path: 'tests/fixtures/feed-stall.mp4' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('me-demo-state-v1', JSON.stringify({
      profiles: [{ id: 'feed-stall-profile', name: 'Jordan Rivera', role: 'parent' }],
      activeProfileId: 'feed-stall-profile',
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
  const video = page.locator(`video[src="${videoUrl}"]`);
  await expect(video).toHaveCount(1);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused)).toBe(false);
  const startTime = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(startTime);
  await video.evaluate((element) => element.dispatchEvent(new Event('stalled', { bubbles: true })));

  await expect(page.getByText('This clip could not load.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('This video stream was interrupted. Try again.')).toBeVisible();
  const retry = page.getByRole('button', { name: 'Retry loading clip', exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByText('Loading clip…').first()).toBeVisible();
});
