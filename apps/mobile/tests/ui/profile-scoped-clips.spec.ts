import { expect, test, type Page } from '@playwright/test';

const firstMember = { id: 'clip-owner-one', name: 'Jordan Rivera', role: 'parent' as const };
const secondMember = { id: 'clip-owner-two', name: 'Avery Rivera', role: 'child' as const };

async function selectProfile(page: Page, profileId: string) {
  await page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: 'Feed' }) }).getByRole('tab', { name: 'Me' }).click();
  await page.getByTestId('me-mode-settings').click();
  await page.getByTestId(`use-profile-${profileId}`).click();
}

test('likes and saved clips stay with their household member across profile changes', async ({ page }) => {
  await page.addInitScript((profiles) => {
    localStorage.setItem('me-demo-state-v1', JSON.stringify({
      profiles,
      activeProfileId: profiles[0].id,
      conversations: [],
      settings: { assistantMode: 'demo', homeUrl: '', model: 'me-balanced', learningMix: 50, topics: ['Engineering'], approvalRequired: true },
      // Legacy single-profile data must stay with the profile active during migration.
      liked: ['bridge'],
      saved: ['bees'],
      onboardingCompleted: true,
    }));
  }, [firstMember, secondMember]);
  await page.goto('/');

  await selectProfile(page, secondMember.id);
  await page.getByRole('tab', { name: 'Feed' }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}').liked)).toEqual([]);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}').saved)).toEqual([]);

  await page.getByRole('checkbox', { name: 'Like clip' }).first().click();
  await page.getByRole('checkbox', { name: 'Save clip' }).first().click();
  await expect(page.getByRole('checkbox', { name: 'Remove like' }).first()).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Remove saved clip' }).first()).toBeVisible();

  const secondProfileState = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
  expect(secondProfileState.clipCollectionsByProfile[firstMember.id]).toEqual({ liked: ['bridge'], saved: ['bees'] });
  expect(secondProfileState.clipCollectionsByProfile[secondMember.id].liked).toHaveLength(1);
  expect(secondProfileState.clipCollectionsByProfile[secondMember.id].saved).toHaveLength(1);

  await selectProfile(page, firstMember.id);
  const firstProfileState = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
  expect(firstProfileState.liked).toEqual(['bridge']);
  expect(firstProfileState.saved).toEqual(['bees']);

  await selectProfile(page, secondMember.id);
  const restoredSecondState = await page.evaluate(() => JSON.parse(localStorage.getItem('me-demo-state-v1') ?? '{}'));
  expect(restoredSecondState.liked).toEqual(secondProfileState.clipCollectionsByProfile[secondMember.id].liked);
  expect(restoredSecondState.saved).toEqual(secondProfileState.clipCollectionsByProfile[secondMember.id].saved);
});
