import { expect, signIn, test } from './fixtures.js';

const RULE = {
  id: 'e2e_memory',
  metric: 'memory_used',
  atLeast: 90,
  for: '2s',
  clearAfter: '2s',
  severity: 'critical',
  message: 'E2E memory high'
};

// The engine checks every second (the harness shortens it) and the rules ask for 2 s, so a
// raise or clear lands within a few seconds; 15 s leaves room on a slow runner.
const ENGINE = { timeout: 15_000 };

test.use({ serverOptions: { password: true, alertsFile: { rules: [RULE] } } });

test('an alert raises, is acknowledged in one tab and clears, live in both tabs', async ({
  page: tabA,
  context,
  server
}) => {
  await signIn(tabA);
  const tabB = await context.newPage();
  for (const tab of [tabA, tabB]) await tab.goto('/#/alerts');

  const open = (tab: typeof tabA) => tab.getByRole('region', { name: 'Open', exact: true });
  const recent = (tab: typeof tabA) => tab.getByRole('region', { name: 'Recent', exact: true });
  const alertsLink = (tab: typeof tabA, name: string) =>
    tab.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name, exact: true });

  for (const tab of [tabA, tabB]) {
    await expect(open(tab)).toContainText('No open alerts');
    await expect(alertsLink(tab, 'Alerts')).toBeVisible();
  }

  server.setReadings({ memory_used: 95 });
  for (const tab of [tabA, tabB]) {
    await expect(open(tab)).toContainText('E2E memory high', ENGINE);
    await expect(alertsLink(tab, 'Alerts, 1 open, critical')).toBeVisible();
  }

  // The tile on the Now page carries the alert too (tab B moves there and back).
  await tabB.goto('/#/');
  await expect(tabB.getByRole('region', { name: 'Memory used', exact: true })).toContainText(
    'Alert since'
  );
  await tabB.goto('/#/alerts');

  // Acknowledging in tab A drops the count in tab B with no reload; the alert stays open.
  let reloads = 0;
  tabB.on('framenavigated', (frame) => {
    if (frame === tabB.mainFrame()) reloads += 1;
  });
  await open(tabA).getByRole('button', { name: 'Acknowledge' }).click();
  await expect(alertsLink(tabB, 'Alerts')).toBeVisible();
  await expect(open(tabB)).toContainText('E2E memory high');
  await expect(open(tabB)).toContainText('Acknowledged');
  expect(reloads).toBe(0);

  server.setReadings({ memory_used: 40 });
  for (const tab of [tabA, tabB]) {
    await expect(open(tab)).toContainText('No open alerts', ENGINE);
    await expect(recent(tab)).toContainText('E2E memory high', ENGINE);
  }
});

test('a rule added in the editor raises without a restart and leaves Open when disabled', async ({
  page,
  server
}) => {
  server.setReadings({ cpu_load: 80 });
  await signIn(page);
  await page.goto('/#/alerts');

  const open = page.getByRole('region', { name: 'Open', exact: true });
  const rules = page.getByRole('region', { name: 'Rules', exact: true });
  await expect(open).toContainText('No open alerts');

  await rules.getByRole('button', { name: 'Add rule' }).click();
  await rules.getByLabel('Id (lowercase, e.g. cpu_busy_short)').fill('e2e_cpu');
  await rules.getByLabel('Metric').selectOption({ label: 'CPU load' });
  await rules.getByLabel('Value', { exact: true }).fill('50');
  await rules.getByLabel('Lasting (e.g. 10min)').fill('2s');
  await rules.getByLabel('Severity').selectOption('warning');
  await rules.getByLabel('Message').fill('E2E CPU high');
  await rules.getByRole('button', { name: 'Save rule' }).click();

  await expect(open).toContainText('E2E CPU high', ENGINE);

  await rules
    .getByRole('listitem')
    .filter({ hasText: 'E2E CPU high' })
    .getByRole('button', { name: 'Disable' })
    .click();
  await expect(open).toContainText('No open alerts', ENGINE);
  // The engine closes it because its rule is no longer in force.
  await expect(page.getByRole('region', { name: 'Recent', exact: true })).toContainText(
    'rule removed',
    ENGINE
  );
});
