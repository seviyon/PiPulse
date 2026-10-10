import { insertSample, runHousekeeping } from '@pipulse/storage';
import type { Page } from '@playwright/test';
import type { ServerOptions } from '../src/harness/launch.js';
import { expect, test } from './fixtures.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// 100 days of readings every 10 minutes, rolled up and pruned the way a long-running install
// is. A young database falls back to hourly for every long range and never reaches the daily
// level the 1-year page depends on (see the plan's Task 11).
const seed: NonNullable<ServerOptions['seed']> = (db, now) => {
  db.exec('BEGIN');
  for (let ts = now - 100 * DAY; ts <= now; ts += 10 * MINUTE) {
    const wave = Math.sin(ts / (6 * 60 * MINUTE));
    insertSample(db, { metric: 'cpu_load', ts, value: 50 + 40 * wave });
    insertSample(db, { metric: 'memory_used', ts, value: 50 + 20 * wave });
    insertSample(db, { metric: 'network_rx', ts, value: 2000 + 1500 * wave });
    insertSample(db, { metric: 'network_tx', ts, value: 1000 + 700 * wave });
  }
  db.exec('COMMIT');
  runHousekeeping(db, now);
};

test.use({ serverOptions: { seed } });

const cpuChart = (page: Page, name: RegExp) =>
  page.getByRole('region', { name: 'CPU load', exact: true }).getByRole('img', { name });

const RANGES: { label: string; id: string; chart: RegExp }[] = [
  { label: '24 hours', id: '24h', chart: /every reading/i },
  { label: '7 days', id: '7d', chart: /1-minute averages/i },
  { label: '30 days', id: '30d', chart: /hourly averages/i },
  { label: '1 year', id: '1y', chart: /daily averages/i }
];

for (const range of RANGES) {
  test(`${range.label}: the chart loads at the resolution the server picks`, async ({ page }) => {
    await page.goto(`/#/history?range=${range.id}`);
    await expect(cpuChart(page, range.chart)).toBeVisible();
    const cpu = page.getByRole('region', { name: 'CPU load', exact: true });
    await expect(cpu).not.toContainText('No readings in this range');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'Time range' }).getByRole('link', { name: range.label })
    ).toHaveAttribute('aria-current', 'true');
  });
}

test('1 year: the daily series spans the seeded history, not just its newest days', async ({
  page
}) => {
  const answer = page.waitForResponse(
    (response) =>
      /\/api\/metrics\/cpu_load\/series\?/.test(response.url()) && response.status() === 200
  );
  await page.goto('/#/history?range=1y');
  const series = (await (await answer).json()) as {
    resolution: string;
    points: { ts: number }[];
  };
  expect(series.resolution).toBe('1d');
  const first = series.points[0]!.ts;
  const last = series.points[series.points.length - 1]!.ts;
  expect(last - first).toBeGreaterThanOrEqual(90 * DAY);
  expect(series.points.length).toBeGreaterThanOrEqual(90);
  expect(series.points.length).toBeLessThanOrEqual(110);
});

test('dragging across a chart zooms in on finer data, and Reset zoom brings the range back', async ({
  page
}) => {
  await page.goto('/#/history?range=24h');
  const chart = cpuChart(page, /every reading/i);
  await expect(chart).toBeVisible();
  const rangeLink = page
    .getByRole('navigation', { name: 'Time range' })
    .getByRole('link', { name: '24 hours' });
  await expect(rangeLink).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('button', { name: 'Reset zoom' })).toHaveCount(0);

  const box = (await chart.boundingBox())!;
  const y = box.y + box.height / 2;
  const request = page.waitForRequest(/\/api\/metrics\/cpu_load\/series\?/);
  await page.mouse.move(box.x + box.width * 0.25, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 10 });
  await page.mouse.up();

  const url = new URL((await request).url());
  const from = Number(url.searchParams.get('from'));
  const to = Number(url.searchParams.get('to'));
  expect(to - from).toBeGreaterThan(0);
  expect(to - from).toBeLessThan(DAY);

  const reset = page.getByRole('button', { name: 'Reset zoom' });
  await expect(reset).toBeVisible();
  await expect(rangeLink).not.toHaveAttribute('aria-current', 'true');
  await reset.click();
  await expect(reset).toHaveCount(0);
  await expect(rangeLink).toHaveAttribute('aria-current', 'true');
});
