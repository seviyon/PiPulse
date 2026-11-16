import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyStatus,
  createWebhookAction,
  DeliveryError,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter
} from '../src/action.js';
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

describe('classifyStatus, at the edges', () => {
  it('puts 199 and 300 and 399 and 400 and 499 and 500 on the right side', () => {
    expect(classifyStatus(199)).toBe('retryable');
    expect(classifyStatus(200)).toBe('ok');
    expect(classifyStatus(299)).toBe('ok');
    expect(classifyStatus(300)).toBe('permanent');
    expect(classifyStatus(399)).toBe('permanent');
    expect(classifyStatus(400)).toBe('permanent');
    expect(classifyStatus(499)).toBe('permanent');
    expect(classifyStatus(500)).toBe('retryable');
    expect(classifyStatus(407)).toBe('permanent');
    expect(classifyStatus(409)).toBe('permanent');
  });
});

describe('classifyStatus', () => {
  it('splits statuses into ok, permanent and retryable', () => {
    for (const s of [200, 204, 299]) expect(classifyStatus(s)).toBe('ok');
    for (const s of [301, 302, 400, 401, 403, 404, 410])
      expect(classifyStatus(s)).toBe('permanent');
    for (const s of [408, 425, 429, 500, 503]) expect(classifyStatus(s)).toBe('retryable');
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('20', now)).toBe(20_000);
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
    expect(parseRetryAfter('31536000', now)).toBe(31_536_000_000); // unclamped: the sender caps it
  });
  it('ignores empty, zero, negative, non-numeric and past values', () => {
    for (const v of [
      null,
      '',
      '  ',
      '0',
      '-5',
      'abc',
      '1e9',
      '1.5',
      '2099-01-01',
      '1/1/2099',
      new Date(now - 1000).toUTCString(),
      new Date(now).toUTCString()
    ])
      expect(parseRetryAfter(v, now)).toBeNull();
  });
  it('ignores spaces around the value', () => {
    expect(parseRetryAfter(' 20 ', now)).toBe(20_000);
    expect(parseRetryAfter(` ${new Date(now + 5000).toUTCString()} `, now)).toBe(5000);
  });
  it('caps nothing itself, and the cap is 15 minutes', () => {
    expect(MAX_RETRY_AFTER_MS).toBe(15 * 60_000);
  });
});

describe('typed delivery errors', () => {
  const respond = (status: number, headers: Record<string, string> = {}) =>
    createWebhookAction(
      hook(),
      (async () => new Response('', { status, headers })) as unknown as typeof fetch
    );
  const failure = (status: number, headers?: Record<string, string>) =>
    respond(status, headers)
      .deliver('{}', AbortSignal.timeout(1000))
      .then(
        () => undefined,
        (e: unknown) => e as DeliveryError
      );

  it('rejects a 401 as permanent, not transport', async () => {
    const error = await failure(401);
    expect(error).toBeInstanceOf(DeliveryError);
    expect(error).toMatchObject({ message: 'HTTP 401', kind: 'permanent', transport: false });
  });
  it('rejects a redirect as permanent', async () => {
    expect(await failure(302)).toMatchObject({
      message: 'redirect (HTTP 302)',
      kind: 'permanent',
      transport: false
    });
  });
  it('rejects a 503 with Retry-After as retryable with the wait', async () => {
    expect(await failure(503, { 'retry-after': '20' })).toMatchObject({
      kind: 'retryable',
      transport: false,
      retryAfterMs: 20_000
    });
  });
  it('reads Retry-After on 429 but ignores it on other statuses', async () => {
    expect(await failure(429, { 'retry-after': '7' })).toMatchObject({ retryAfterMs: 7000 });
    expect(await failure(500, { 'retry-after': '7' })).toMatchObject({ retryAfterMs: null });
  });
  it('rejects a refused connection as retryable transport', async () => {
    const port = await closedPort();
    const error = await createWebhookAction(hook({ url: `http://127.0.0.1:${port}/x` }))
      .deliver('{}', AbortSignal.timeout(1000))
      .catch((e: unknown) => e as DeliveryError);
    expect(error).toMatchObject({
      message: 'connection refused',
      kind: 'retryable',
      transport: true,
      retryAfterMs: null
    });
  });
});

describe('delivery error details', () => {
  const fail = (status: number) =>
    createWebhookAction(
      hook(),
      (async () => new Response('', { status })) as unknown as typeof fetch
    )
      .deliver('{}', AbortSignal.timeout(1000))
      .then(
        () => undefined,
        (e: unknown) => e as DeliveryError
      );

  it('names itself, so a log line says what it is', async () => {
    expect((await fail(401))!.name).toBe('DeliveryError');
  });
  it('words 300 as a redirect and 400 as a plain HTTP status', async () => {
    expect((await fail(300))!.message).toBe('redirect (HTTP 300)');
    expect((await fail(399))!.message).toBe('redirect (HTTP 399)');
    expect((await fail(400))!.message).toBe('HTTP 400');
  });
});
