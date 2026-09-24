import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebhookAction } from '../src/action.js';
import type { WebhookConfig } from '../src/config.js';

/** Binds a server, records its port, then closes it — nothing there to refuse the next connect. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  return port;
}

let server: Server;
let handler: (
  req: IncomingMessage,
  body: string
) => { status: number; headers?: Record<string, string>; body?: string } | 'hang';
let received: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[];
let base: string;
beforeEach(async () => {
  received = [];
  handler = () => ({ status: 200 });
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const answer = handler(req, body);
      if (answer === 'hang') return;
      res.writeHead(answer.status, answer.headers).end(answer.body ?? '');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const hook = (over: Partial<WebhookConfig> = {}): WebhookConfig => ({
  id: 'test',
  url: `${base}/notify/key`,
  method: 'POST',
  headers: {},
  events: ['raised', 'cleared'],
  minSeverity: 'warning',
  timeoutMs: 1000,
  ...over
});
const deliver = (over: Partial<WebhookConfig> = {}, timeoutMs = 1000) =>
  createWebhookAction(hook(over)).deliver('{"a":1}', AbortSignal.timeout(timeoutMs));

describe('webhook action', () => {
  it('sends the payload as JSON with the configured method and headers', async () => {
    await deliver({ method: 'PUT', headers: { Authorization: 'Bearer t' } });
    expect(received[0]).toMatchObject({ method: 'PUT', url: '/notify/key', body: '{"a":1}' });
    expect(received[0]!.headers).toMatchObject({
      authorization: 'Bearer t',
      'content-type': 'application/json'
    });
  });

  it('rejects with a short reason for non-2xx, redirects, timeouts and refused connections', async () => {
    handler = () => ({ status: 503, body: 'x'.repeat(5000) });
    await expect(deliver()).rejects.toThrow(/^HTTP 503$/);
    handler = () => ({ status: 302, headers: { location: 'http://example.com/' } });
    await expect(deliver()).rejects.toThrow(/^redirect \(HTTP 302\)$/);
    expect(received).toHaveLength(2); // the redirect was not followed
    handler = () => 'hang';
    await expect(deliver({}, 200)).rejects.toThrow(/^timeout$/);
    const port = await closedPort();
    await expect(
      createWebhookAction(hook({ url: `http://127.0.0.1:${port}/x` })).deliver(
        '{}',
        AbortSignal.timeout(1000)
      )
    ).rejects.toThrow(/^connection refused$/);
  });

  it('rejects a blocked port with a network error, not connection refused', async () => {
    // Port 1 is on the Fetch spec's forbidden-port list: undici refuses to dial it at
    // all, before any TCP-level ECONNREFUSED is possible.
    await expect(
      createWebhookAction(hook({ url: 'http://127.0.0.1:1/x' })).deliver(
        '{}',
        AbortSignal.timeout(1000)
      )
    ).rejects.toThrow(/^network error/);
  });

  it('never puts the URL in a reason', async () => {
    handler = () => ({ status: 500 });
    await expect(deliver({ url: `${base}/secret-key?token=abc` })).rejects.toThrow(/^HTTP 500$/);
  });

  it('never leaks credentials, paths or header values through the raw fetch error', async () => {
    const port = await closedPort();
    const urlError = await createWebhookAction(
      hook({ url: `http://user:SECRETPW@127.0.0.1:${port}/secret-path?token=abc` })
    )
      .deliver('{}', AbortSignal.timeout(1000))
      .catch((e: unknown) => e);
    const urlDump = inspect(urlError);
    expect(urlDump).not.toContain('SECRETPW');
    expect(urlDump).not.toContain('secret-path');
    expect(urlDump).not.toContain('token=abc');

    const headerError = await deliver({ headers: { Authorization: 'Bearer SECRET\nX' } }).catch(
      (e: unknown) => e
    );
    expect(inspect(headerError)).not.toContain('SECRET');
  });
});
