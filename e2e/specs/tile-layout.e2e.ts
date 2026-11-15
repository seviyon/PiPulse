import { expect, test } from './fixtures.js';

// 0x50000: under-voltage and throttling have happened since boot, none right now.
const THROTTLED_BEFORE = 0x50000;

test('a long status and alert line stay inside their tile', async ({ page, server }) => {
  server.setReadings({ throttled: THROTTLED_BEFORE });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');

  const tile = page.getByRole('region', { name: 'Throttling', exact: true });
  await expect(tile).toContainText('Alert since', { timeout: 15_000 });

  const box = (await tile.boundingBox())!;
  for (const part of [tile.locator('.status'), tile.locator('.alert-line')]) {
    const inner = (await part.boundingBox())!;
    expect(inner.x + inner.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
});
