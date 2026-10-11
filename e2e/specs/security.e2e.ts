import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures.js';

test.describe('the browser defenses', () => {
  test('the dashboard runs under its own Content-Security-Policy on every page, with no violation', async ({
    page
  }) => {
    const violations: string[] = [];
    await page.exposeFunction('reportViolation', (text: string) => violations.push(text));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).reportViolation(`${event.violatedDirective}: ${event.blockedURI}`);
      });
    });

    const response = await page.goto('/');
    expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response?.headers()['x-frame-options']).toBe('DENY');
    await expect(page.getByRole('status')).toContainText('Live'); // the WebSocket is allowed by connect-src

    for (const route of ['#/history?range=24h', '#/alerts', '#/settings', '#/']) {
      await page.goto(`/${route}`);
      await page.waitForLoadState('networkidle');
    }
    // The chart (uPlot sets styles through CSSOM) drew without a style violation.
    await page.goto('/#/history?range=1h');
    await expect(page.locator('.chart canvas').first()).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('inline script and style the policy forbids really are blocked (the policy is enforced)', async ({
    page
  }) => {
    await page.goto('/');
    const blocked = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          document.addEventListener(
            'securitypolicyviolation',
            (event) => resolve(event.violatedDirective),
            {
              once: true
            }
          );
          const script = document.createElement('script');
          script.textContent = 'window.__ran = true';
          document.head.append(script);
          setTimeout(() => resolve('not blocked'), 1000);
        })
    );
    expect(blocked).toMatch(/^script-src/);
    expect(
      await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran)
    ).toBeUndefined();
  });

  test('the dashboard cannot be framed, so a page cannot click on it for the signed-in admin', async ({
    page,
    server
  }) => {
    // A page on another port of the same machine (same site, as Pi-hole or RPi-Monitor are on the
    // Pi) with the dashboard in an iframe. Chrome refuses a public page framing a local address
    // by another rule, which would make this pass for the wrong reason.
    const framer = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html><iframe id="f" src="${server.baseUrl}/"></iframe>`);
    });
    await new Promise<void>((resolve) => framer.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = framer.address() as AddressInfo;
      const answered = page.waitForResponse(
        (response) =>
          response.url() === `${server.baseUrl}/` && response.frame() !== page.mainFrame()
      );
      await page.goto(`http://127.0.0.1:${port}/`);
      expect((await answered).status()).toBe(200); // the server did answer the frame's request...
      // ...and the browser refused to show it.
      await expect
        .poll(() => page.frames().map((frame) => frame.url()))
        .toContain('chrome-error://chromewebdata/');
      expect(page.frames().some((frame) => frame.url().startsWith(server.baseUrl))).toBe(false);
    } finally {
      await new Promise((resolve) => framer.close(resolve));
    }
  });

  test('API answers are not cacheable, the dashboard files are', async ({ page }) => {
    const api = await page.request.get('/api/config');
    expect(api.headers()['cache-control']).toBe('no-store');
    const html = await page.request.get('/');
    expect(html.headers()['cache-control']).not.toBe('no-store');
  });
});
