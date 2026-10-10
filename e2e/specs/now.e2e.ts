import { historyOnly } from '../../packages/web/src/history.js';
import { formatValue } from '../../packages/web/src/format.js';
import { DEFAULT_READINGS } from '../src/harness/readings.js';
import { expect, test } from './fixtures.js';

interface Config {
  device: { hostname: string };
  plugins: { id: string; label: string; unit: string }[];
}

test('the Now page shows a tile per plugin and follows readings live', async ({ page, server }) => {
  const config = (await (await page.request.get('/api/config')).json()) as Config;
  // History-only metrics (the load average, swap traffic) have no tile on the Now page.
  const shown = config.plugins.filter((plugin) => !historyOnly.has(plugin.id));
  const hidden = config.plugins.filter((plugin) => historyOnly.has(plugin.id));
  expect(hidden.map((plugin) => plugin.id).sort()).toEqual(['load_1', 'swap_io']);

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(config.device.hostname);
  await expect(page.getByRole('status')).toContainText('Live');

  for (const plugin of shown) {
    await expect(page.getByRole('region', { name: plugin.label, exact: true })).toBeVisible();
  }
  for (const plugin of hidden) {
    await expect(page.getByRole('region', { name: plugin.label, exact: true })).toHaveCount(0);
  }

  const memory = config.plugins.find((plugin) => plugin.id === 'memory_used')!;
  const tile = page.getByRole('region', { name: memory.label, exact: true });
  await expect(tile).toContainText(formatValue(DEFAULT_READINGS['memory_used']!, memory.unit).text);

  // A new reading reaches the tile over the WebSocket, with no navigation: a reload would also
  // show the new value (after refetching it), so count main-frame navigations from here on.
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });
  server.setReadings({ memory_used: 61.5 });
  await expect(tile).toContainText(formatValue(61.5, memory.unit).text);
  expect(navigations).toBe(0);
});
