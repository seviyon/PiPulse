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

test.use({ serverOptions: { password: true, alertsFile: { rules: [RULE] } } });

// The dashboard estimates the Pi's clock from the timestamp of each live reading, so a reading
// that arrives late leaves the estimate behind by that delay. A just-cleared alert is stamped by
// the Pi and must still reach the Recent list.
test('a cleared alert reaches Recent when the clock estimate runs behind the Pi', async ({
  page,
  server
}) => {
  await signIn(page);
  await page.routeWebSocket('**/api/live', (socket) => {
    const upstream = socket.connectToServer();
    socket.onMessage((message) => upstream.send(message));
    upstream.onMessage((message) => {
      const late = typeof message === 'string' && message.includes('"type":"sample"');
      if (late) setTimeout(() => socket.send(message), 1_500);
      else socket.send(message);
    });
  });
  await page.goto('/#/alerts');
  const open = page.getByRole('region', { name: 'Open', exact: true });
  const recent = page.getByRole('region', { name: 'Recent', exact: true });
  await expect(open).toContainText('No open alerts', { timeout: 15_000 });

  server.setReadings({ memory_used: 95 });
  await expect(open).toContainText('E2E memory high', { timeout: 15_000 });
  server.setReadings({ memory_used: 40 });
  await expect(open).toContainText('No open alerts', { timeout: 15_000 });
  await expect(recent).toContainText('E2E memory high', { timeout: 15_000 });
});
