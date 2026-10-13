import { expect, test } from './fixtures.js';

test.describe('the Updates tab', () => {
  test('is a tab of its own that says in words what it knows', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Updates' }).click();
    await expect(page).toHaveURL(/#\/updates$/);
    await expect(page.getByRole('heading', { name: 'Updates', level: 2 }).first()).toBeVisible();
    // The test server has just started (no check yet) or has no apt (a Mac): either way it says so
    // in words instead of showing an empty page.
    await expect(
      page.getByText(
        /Not checked yet|doesn't use apt|No package upgrades are waiting|can be upgraded/
      )
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Updates' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });
});
