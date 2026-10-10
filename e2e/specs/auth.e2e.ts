import { E2E_PASSWORD, expect, test } from './fixtures.js';

test.describe('without an admin password', () => {
  test('Settings is read-only and a write from the page is refused', async ({ page }) => {
    await page.goto('/#/settings');
    await expect(page.getByRole('heading', { name: 'Data retention' })).toBeVisible();
    await expect(page.getByText('Editing is off: no admin password is configured')).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);

    // Sent from the page, so the browser adds the Origin header like a real write would.
    const answer = await page.evaluate(async () => {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      return { status: response.status, body: (await response.json()) as { error: string } };
    });
    // The message tells the no-password refusal from the origin check's `origin not allowed`.
    expect(answer).toEqual({
      status: 403,
      body: { error: 'editing is disabled: no admin password configured' }
    });
  });
});

test.describe('with an admin password', () => {
  test.use({ serverOptions: { password: true } });

  test('a wrong password is refused, the right one signs in, and Sign out ends the session', async ({
    page,
    context
  }) => {
    const sessionCookie = async () =>
      (await context.cookies()).find((cookie) => cookie.name === 'pipulse_session');

    await page.goto('/#/settings');
    await expect(page.getByRole('heading', { name: 'Sign in to change settings' })).toBeVisible();

    // One wrong attempt only: the limit is five failures per address per 15 minutes.
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Sign-in failed');
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    expect(await sessionCookie()).toBeUndefined();

    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    const cookie = await sessionCookie();
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', secure: false });

    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sign in to change settings' })).toBeVisible();
    await expect.poll(sessionCookie).toBeUndefined();
  });
});

test.describe('with read protection', () => {
  test.use({ serverOptions: { password: true, protectReads: true } });

  test('a signed-out browser sees only the sign-in form, and signing in brings the dashboard Live', async ({
    page
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in to PiPulse' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Pages' })).toHaveCount(0);

    // The WebSocket close code is read from the close event itself, not guessed from the form.
    const closeCode = await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const socket = new WebSocket(`ws://${location.host}/api/live`);
          socket.addEventListener('close', (event) => resolve(event.code));
          setTimeout(() => reject(new Error('the WebSocket did not close within 10 s')), 10_000);
        })
    );
    expect(closeCode).toBe(4401);

    const configStatus = await page.evaluate(async () => (await fetch('/api/config')).status);
    expect(configStatus).toBe(401);

    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('navigation', { name: 'Pages' })).toBeVisible();
    await expect(page.locator('header.device').getByRole('status')).toContainText('Live');
  });
});
