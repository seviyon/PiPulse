import { formatValue } from '../../packages/web/src/format.js';
import { expect, test } from './fixtures.js';

interface Config {
  plugins: { id: string; label: string; unit: string }[];
}

test('the dashboard shows Reconnecting when the server stops and is Live again after a restart', async ({
  page,
  server
}) => {
  const config = (await (await page.request.get('/api/config')).json()) as Config;
  const cpu = config.plugins.find((plugin) => plugin.id === 'cpu_load')!;
  const tile = page.getByRole('region', { name: cpu.label, exact: true });

  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Live');

  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });

  await server.halt();
  await expect(page.getByRole('status')).toContainText('Reconnecting');

  server.setReadings({ cpu_load: 77 });
  await server.restart();

  // The first retries come after 1 s, 2 s and 4 s (packages/web/src/live.ts).
  await expect(page.getByRole('status')).toContainText('Live', { timeout: 15_000 });
  await expect(tile).toContainText(formatValue(77, cpu.unit).text);
  expect(navigations).toBe(0);
});
