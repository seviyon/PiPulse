import { insertSample } from '@pipulse/storage';
import type { Page } from '@playwright/test';
import type { ServerOptions } from '../src/harness/launch.js';
import { expect, signIn, test } from './fixtures.js';

const MINUTE = 60_000;

// 26 h of raw readings every minute, so cutting raw retention to 1 h has data to delete.
const seed: NonNullable<ServerOptions['seed']> = (db, now) => {
  for (let ts = now - 26 * 60 * MINUTE; ts <= now; ts += MINUTE) {
    insertSample(db, { metric: 'cpu_load', ts, value: 10 });
  }
};

const rawField = (page: Page) => page.getByLabel('Raw readings');
const retention = (page: Page) => page.getByRole('region', { name: 'Data retention', exact: true });

test.describe('retention editor', () => {
  test.use({ serverOptions: { password: true, seed } });

  test('a deleting change needs the confirmation and survives a reload', async ({ page }) => {
    await signIn(page);
    await page.goto('/#/settings');
    await expect(rawField(page)).toHaveValue('2d');

    await rawField(page).fill('1h');
    await page.getByRole('button', { name: 'Review changes' }).click();

    const preview = retention(page).locator('.preview');
    await expect(preview.getByRole('listitem')).toContainText('Raw readings');
    await expect(preview.getByRole('listitem')).toContainText('Deletes ~');
    const save = preview.getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();

    await preview.getByLabel('I understand this deletes data').check();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(retention(page).getByRole('status')).toContainText('Saved.');

    await page.reload();
    await expect(rawField(page)).toHaveValue('1h');
  });

  test('a change that deletes nothing saves without a confirmation', async ({ page }) => {
    await signIn(page);
    await page.goto('/#/settings');

    await rawField(page).fill('3d');
    await page.getByRole('button', { name: 'Review changes' }).click();

    const preview = retention(page).locator('.preview');
    await expect(preview).toContainText('Keeps more from now on');
    await expect(preview.getByLabel('I understand this deletes data')).toHaveCount(0);
    await preview.getByRole('button', { name: 'Save' }).click();
    await expect(retention(page).getByRole('status')).toContainText('Saved.');

    await page.reload();
    await expect(rawField(page)).toHaveValue('3d');
  });
});

test.describe('a level set by the environment', () => {
  test.use({ serverOptions: { password: true, env: { PIPULSE_RETENTION_RAW: '2d' } } });

  test('is locked and names its variable', async ({ page }) => {
    await signIn(page);
    await page.goto('/#/settings');
    await expect(rawField(page)).toBeDisabled();
    await expect(rawField(page)).toHaveValue('2d');
    await expect(retention(page)).toContainText('set by PIPULSE_RETENTION_RAW');
  });
});
