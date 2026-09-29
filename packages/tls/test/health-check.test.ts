import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkHealth, healthTarget, healthy } from '../src/health-check.js';
import { fixture, tempDir } from './helpers.js';

let dir: string;
let server: HttpServer | undefined;
beforeEach(() => {
  dir = tempDir();
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const noState = () => undefined;
const put = (name: string, text: string, mode = 0o600) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
};
async function listen(s: HttpServer, host = '127.0.0.1'): Promise<number> {
  server = s;
  await new Promise<void>((resolve) => s.listen(0, host, resolve));
  return (s.address() as AddressInfo).port;
}
const answer =
  (status: number, body: unknown) => (_q: unknown, res: import('node:http').ServerResponse) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
const httpsServer = (status: number, body: unknown, name = 'leaf') =>
  createHttpsServer(
    { key: fixture(`${name}.key`), cert: fixture(`${name}.crt`) + fixture('intermediate.crt') },
    answer(status, body)
  );
const tlsEnv = (port: number, extra: NodeJS.ProcessEnv = {}, name = 'leaf') => ({
  PIPULSE_TLS: 'on',
  PIPULSE_PORT: String(port),
  PIPULSE_TLS_CERT: put('cert.pem', fixture(`${name}.crt`) + fixture('intermediate.crt'), 0o644),
  PIPULSE_TLS_KEY: put('key.pem', fixture(`${name}.key`)),
  PIPULSE_TLS_CA: put('ca.pem', fixture('root-ca.crt'), 0o644),
  ...extra
});
const OK = { status: 'ok', monitoring: 'ok' };

describe('healthy', () => {
  it('accepts monitoring ok (even degraded) and a pre-6b status ok', () => {
    expect(healthy({ status: 'degraded', monitoring: 'ok' })).toBe(true);
    expect(healthy({ status: 'ok' })).toBe(true);
    expect(healthy({ status: 'ok', monitoring: 'failing' })).toBe(false);
    expect(healthy(undefined)).toBe(false);
  });
});

describe('checkHealth over HTTPS', () => {
  it('passes against the configured CA with the certificate name as SNI', async () => {
    const port = await listen(httpsServer(200, { status: 'degraded', monitoring: 'ok' }));
    expect(await checkHealth(tlsEnv(port), { readState: noState })).toEqual({
      code: 0,
      message: 'healthy'
    });
  });

  it('returns 2 when verification fails (no CA configured, private root)', async () => {
    const port = await listen(httpsServer(200, { status: 'ok', monitoring: 'ok' }));
    const { PIPULSE_TLS_CA: _ca, ...env } = tlsEnv(port);
    const result = await checkHealth(env, { readState: noState });
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/^TLS verification failed: /);
  });

  it('returns 1 for a failing server and for nothing listening', async () => {
    const port = await listen(httpsServer(503, { status: 'failing', monitoring: 'failing' }));
    expect((await checkHealth(tlsEnv(port), { readState: noState })).code).toBe(1);
    const closed = await new Promise<number>((resolve) => {
      const s = createHttpServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    expect((await checkHealth(tlsEnv(closed), { readState: noState })).code).toBe(1);
  });
});

describe('healthTarget', () => {
  const sans = (dns: string[], ip: string[] = []) => ({ dns, ip });

  it('verifies a concrete PIPULSE_HOST as exactly that identity', () => {
    expect(healthTarget({ PIPULSE_HOST: '192.168.1.20' }, sans(['example.internal']), [])).toEqual({
      connect: '192.168.1.20',
      identity: '192.168.1.20'
    });
    expect(healthTarget({ PIPULSE_HOST: 'io.lan' }, sans(['io.lan']), [])).toEqual({
      connect: 'io.lan',
      identity: 'io.lan'
    });
    expect(healthTarget({ PIPULSE_HOST: '[::1]' }, sans([]), [])).toEqual({
      connect: '::1',
      identity: '::1'
    });
  });

  it('on a wildcard bind prefers the declared name, then localhost, then 127.0.0.1, then the first DNS name', () => {
    expect(healthTarget({}, sans(['localhost']), ['io.lan'])).toEqual({
      connect: '127.0.0.1',
      identity: 'io.lan'
    });
    expect(
      healthTarget({ PIPULSE_HOST: '0.0.0.0' }, sans(['a.test', 'localhost'], ['127.0.0.1']), [])
    ).toEqual({
      connect: '127.0.0.1',
      identity: 'localhost'
    });
    expect(healthTarget({ PIPULSE_HOST: '::' }, sans([], ['127.0.0.1']), [])).toEqual({
      connect: '127.0.0.1',
      identity: '127.0.0.1'
    });
    expect(healthTarget({}, sans(['example.internal']), [])).toEqual({
      connect: '127.0.0.1',
      identity: 'example.internal'
    });
    expect(healthTarget({}, sans([]), [])).toEqual({ connect: '127.0.0.1', identity: '127.0.0.1' });
  });
});

describe('checkHealth identity', () => {
  it('passes a concrete IP bind whose certificate has that IP SAN', async () => {
    const port = await listen(httpsServer(200, OK));
    expect(
      (await checkHealth(tlsEnv(port, { PIPULSE_HOST: '127.0.0.1' }), { readState: noState })).code
    ).toBe(0);
  });

  it('fails (2) a concrete IP bind whose certificate names only an unrelated host', async () => {
    const port = await listen(httpsServer(200, OK, 'dns-only'));
    const result = await checkHealth(tlsEnv(port, { PIPULSE_HOST: '127.0.0.1' }, 'dns-only'), {
      readState: noState
    });
    expect(result).toEqual({
      code: 2,
      message: 'TLS verification failed: ERR_TLS_CERT_ALTNAME_INVALID'
    });
  });

  it('passes a concrete host name the certificate covers', async () => {
    // Dual-stack listen: "localhost" may resolve to ::1 or 127.0.0.1.
    const port = await listen(httpsServer(200, OK), '::');
    expect(
      (await checkHealth(tlsEnv(port, { PIPULSE_HOST: 'localhost' }), { readState: noState })).code
    ).toBe(0);
  });

  it('on a wildcard bind verifies the declared name, and fails one the certificate lacks', async () => {
    const port = await listen(httpsServer(200, OK));
    expect(
      (
        await checkHealth(
          tlsEnv(port, { PIPULSE_HOST: '0.0.0.0', PIPULSE_TLS_NAMES: 'pipulse.test' }),
          { readState: noState }
        )
      ).code
    ).toBe(0);
    expect(
      (
        await checkHealth(tlsEnv(port, { PIPULSE_HOST: '0.0.0.0', PIPULSE_TLS_NAMES: 'io.lan' }), {
          readState: noState
        })
      ).code
    ).toBe(2);
  });

  it('passes a certificate with only an IP SAN on a wildcard bind', async () => {
    const port = await listen(httpsServer(200, OK, 'ip-only'));
    expect((await checkHealth(tlsEnv(port, {}, 'ip-only'), { readState: noState })).code).toBe(0);
  });
});

describe('checkHealth over HTTP', () => {
  it('passes for a pre-6b body and fails for 503', async () => {
    const port = await listen(createHttpServer(answer(200, { status: 'ok' })));
    expect(await checkHealth({ PIPULSE_PORT: String(port) }, { readState: noState })).toEqual({
      code: 0,
      message: 'healthy'
    });
  });

  it('fails for 503', async () => {
    const port = await listen(
      createHttpServer(answer(503, { status: 'failing', monitoring: 'failing' }))
    );
    expect((await checkHealth({ PIPULSE_PORT: String(port) }, { readState: noState })).code).toBe(
      1
    );
  });
});
