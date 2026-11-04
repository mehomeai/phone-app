import { expect, test } from '@playwright/test';

test('a screen render error shows a fallback and can recover', async ({
  page,
}) => {
  await page.goto('/');

  await expect(
    page.getByText('Something went wrong', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Something went wrong' }),
  ).toBeFocused();
  await expect(page.getByRole('alert')).toHaveAttribute(
    'aria-live',
    'assertive',
  );
  await expect(page.getByRole('alert')).toHaveText(
    'Please reload the app to continue.',
  );
  await expect(
    page.getByRole('button', { name: 'Try Again' }),
  ).toBeVisible();
  await expect(page.getByTestId('error-boundary-recovered')).toHaveCount(0);

  await page.getByRole('button', { name: 'Try Again' }).click();

  await expect(page.getByTestId('error-boundary-recovered')).toBeVisible();
  await expect(
    page.getByText('Something went wrong', { exact: true }),
  ).toHaveCount(0);
});
