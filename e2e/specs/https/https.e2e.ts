import { formatValue } from '../../../packages/web/src/format.js';
import { expect, signIn, test } from '../fixtures.js';

// Runs only in the `chromium-https` project, the one project that skips certificate checks in
// the browser. The launcher has already verified the served chain with Node against the test
// root before any test starts, so a wrong chain fails here before a browser opens.
test.use({ serverOptions: { tls: true, password: true } });

interface Config {
  plugins: { id: string; label: string; unit: string }[];
}

test('the dashboard is Live over wss:// and follows readings', async ({ page, server }) => {
  expect(server.baseUrl).toBe(`https://127.0.0.1:${server.port}`);
  const config = (await (await page.request.get('/api/config')).json()) as Config;
  const cpu = config.plugins.find((plugin) => plugin.id === 'cpu_load')!;

  const sockets: string[] = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await page.goto('/');
  await expect(page.locator('header.device').getByRole('status')).toContainText('Live');
  expect(sockets.some((url) => url.startsWith('wss://'))).toBe(true);

  server.setReadings({ cpu_load: 61.5 });
  await expect(page.getByRole('region', { name: cpu.label, exact: true })).toContainText(
    formatValue(61.5, cpu.unit).text
  );
});

test('the session cookie is Secure', async ({ page, context }) => {
  await signIn(page);
  const cookie = (await context.cookies()).find((c) => c.name === 'pipulse_session');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', secure: true });
});

test('plain HTTP to the HTTPS port gets the hint page', async ({ page, server }) => {
  // Reliable for a browser's small request; a request of hundreds of KB can lose the page to a
  // connection reset (see packages/api/src/plain-http.ts).
  const response = await page.goto(`http://127.0.0.1:${server.port}/`);
  expect(response?.status()).toBe(400);
  await expect(page.getByText('This PiPulse address uses HTTPS')).toBeVisible();
});

test('Settings shows the served certificate with its expiry year', async ({ page }) => {
  await page.goto('/#/settings');
  const section = page.getByRole('region', { name: 'Certificate', exact: true });
  await expect(section).toContainText('Valid until');
  await expect(section).toContainText('2125');
});
