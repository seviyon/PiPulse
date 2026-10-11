import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  checkHealth,
  healthTarget,
  healthy,
  verificationFailure,
  VERIFY_CODES
} from '../src/health-check.js';
import { listenHost, listenPort, REFUSE_LINE } from '../src/config.js';
import { issueCa, issueLeaf } from '../src/issue.js';
import { fixture, tempDir } from './helpers.js';
import { TEST_OPENSSL } from './openssl.js';

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

  it('enforces an overall timeout when a peer trickles a response', async () => {
    const trickle = createHttpsServer(
      { key: fixture('leaf.key'), cert: fixture('leaf.crt') + fixture('intermediate.crt') },
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        const timer = setInterval(() => response.write(' '), 10);
        response.on('close', () => clearInterval(timer));
      }
    );
    const port = await listen(trickle);
    const result = await checkHealth(tlsEnv(port), { readState: noState, timeoutMs: 50 });
    expect(result.code).toBe(1);
    expect(result.message).toContain('timed out');
  });

  it('rejects an oversized response body', async () => {
    const oversized = createHttpsServer(
      { key: fixture('leaf.key'), cert: fixture('leaf.crt') + fixture('intermediate.crt') },
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('x'.repeat(65 * 1024));
      }
    );
    const port = await listen(oversized);
    const result = await checkHealth(tlsEnv(port), { readState: noState });
    expect(result.code).toBe(1);
    expect(result.message).toContain('health response is too large');
  });
});

describe('VERIFY_CODES', () => {
  it.each([
    'INVALID_CA',
    'INVALID_PURPOSE',
    'CERT_CHAIN_TOO_LONG',
    'PATH_LENGTH_EXCEEDED',
    'UNABLE_TO_DECRYPT_CERT_SIGNATURE'
  ])('treats %s as a verification failure (exit 2, no rollback)', (code) => {
    expect(VERIFY_CODES.has(code)).toBe(true);
  });
});

describe('checkHealth with an unusable certificate file', () => {
  it('returns one line (1) for a certificate body that parses as PEM but not as a certificate', async () => {
    const garbage = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
    const env = tlsEnv(1, { PIPULSE_TLS_CERT: put('bad.pem', garbage, 0o644) });
    const result = await checkHealth(env, { readState: noState });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/^can't read the certificate: /);
    expect(result.message).not.toContain('\n');
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

  it('on a wildcard bind prefers the declared name, then localhost, then loopback, then an IP or DNS SAN', () => {
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
    expect(healthTarget({}, sans([], ['192.168.1.20']), [])).toEqual({
      connect: '127.0.0.1',
      identity: '192.168.1.20'
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

describe('checkHealth with an IPv6 identity', () => {
  let ipv6 = false;
  beforeAll(async () => {
    ipv6 = await new Promise<boolean>((resolve) => {
      const probe = createNetServer();
      probe.once('error', () => resolve(false));
      probe.listen(0, '::1', () => probe.close(() => resolve(true)));
    });
  });

  // skipIf(!ipv6) would run before beforeAll set it; ask at run time instead.
  it('passes a leaf that lists IP:::1 on a server bound to ::1', async ({ skip }) => {
    if (!ipv6) skip();
    const work = tempDir();
    try {
      const now = Date.now();
      const scope = {
        dns: ['localhost'],
        excludedDns: [],
        ip: [
          { address: '127.0.0.1', prefix: 32 },
          { address: '::1', prefix: 128 }
        ]
      };
      const ca = await issueCa({
        openssl: TEST_OPENSSL,
        workDir: work,
        subject: 'Health CA',
        scope,
        now
      });
      writeFileSync(join(work, 'ca.key'), ca.keyPem, { mode: 0o600 });
      writeFileSync(join(work, 'ca.crt'), ca.certPem);
      const leaf = await issueLeaf({
        openssl: TEST_OPENSSL,
        workDir: work,
        ca: {
          keyPath: join(work, 'ca.key'),
          certPath: join(work, 'ca.crt'),
          certPem: ca.certPem
        },
        subject: 'localhost',
        dns: [],
        ip: ['::1'],
        now
      });
      const port = await listen(
        createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, answer(200, OK)),
        '::1'
      );
      const env = {
        PIPULSE_TLS: 'on',
        PIPULSE_PORT: String(port),
        PIPULSE_HOST: '::1',
        PIPULSE_TLS_CERT: put('v6cert.pem', leaf.certPem, 0o644),
        PIPULSE_TLS_KEY: put('v6key.pem', leaf.keyPem),
        PIPULSE_TLS_CA: put('v6ca.pem', ca.certPem, 0o644)
      };
      expect((await checkHealth(env, { readState: noState })).code).toBe(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('checkHealth over HTTP', () => {
  it('passes for a pre-6b body and fails for 503', async () => {
    const port = await listen(createHttpServer(answer(200, { status: 'ok' })));
    expect(
      await checkHealth({ PIPULSE_PORT: String(port), PIPULSE_TLS: 'off' }, { readState: noState })
    ).toEqual({
      code: 0,
      message: 'healthy'
    });
  });

  it('fails for 503', async () => {
    const port = await listen(
      createHttpServer(answer(503, { status: 'failing', monitoring: 'failing' }))
    );
    expect(
      (
        await checkHealth(
          { PIPULSE_PORT: String(port), PIPULSE_TLS: 'off' },
          { readState: noState }
        )
      ).code
    ).toBe(1);
  });

  it('says what the server would say with no setting at all, instead of probing', async () => {
    expect(await checkHealth({ PIPULSE_PORT: '1' }, { readState: noState })).toEqual({
      code: 1,
      message: REFUSE_LINE
    });
  });
});

describe('verificationFailure', () => {
  it('treats a name-constraint violation as a verification failure (exit 2)', () => {
    expect(
      verificationFailure({ code: 'UNSPECIFIED', message: 'permitted subtree violation' })
    ).toBe(true);
    expect(
      verificationFailure({ code: 'UNSPECIFIED', message: 'excluded subtree violation' })
    ).toBe(true);
    expect(verificationFailure({ code: 'UNSPECIFIED', message: 'socket hang up' })).toBe(false);
    expect(verificationFailure({ code: 'CERT_HAS_EXPIRED', message: '' })).toBe(true);
    expect(verificationFailure({ code: 'ECONNREFUSED', message: '' })).toBe(false);
  });
});

describe('review fixes: the check never relaxes verification', () => {
  const setting = 'NODE_TLS_REJECT_UNAUTHORIZED';
  const before = process.env[setting];
  afterEach(() => {
    if (before === undefined) delete process.env[setting];
    else process.env[setting] = before;
  });

  it('still verifies when the environment says not to (Docker HEALTHCHECK inherits it)', async () => {
    process.env[setting] = '0';
    // A certificate from an unrelated CA, and a name the certificate does not carry.
    const port = await listen(httpsServer(200, OK, 'other-leaf'));
    const result = await checkHealth(tlsEnv(port, { PIPULSE_TLS_NAMES: 'wrong.example' }), {
      readState: noState
    });
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/^TLS verification failed: /);
  });

  it('still passes a good certificate with the same environment', async () => {
    process.env[setting] = '0';
    const port = await listen(httpsServer(200, OK));
    expect((await checkHealth(tlsEnv(port), { readState: noState })).code).toBe(0);
  });
});

describe('review fixes: the plain-HTTP check is as strict as the HTTPS one', () => {
  const httpEnv = (port: number) => ({ PIPULSE_TLS: 'off', PIPULSE_PORT: String(port) });
  const respond = (status: number, body: string, headers: Record<string, string> = {}) =>
    createHttpServer((_q, res) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body);
    });

  it('passes a 200 with a healthy body', async () => {
    const port = await listen(respond(200, JSON.stringify(OK)));
    expect((await checkHealth(httpEnv(port), { readState: noState })).code).toBe(0);
  });

  it('does not follow a redirect to something that looks healthy', async () => {
    const target = respond(200, JSON.stringify(OK));
    const targetPort = await listen(target);
    const other = respond(302, '', { location: `http://127.0.0.1:${targetPort}/api/health` });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const port = (other.address() as AddressInfo).port;
    try {
      const result = await checkHealth(httpEnv(port), { readState: noState });
      expect(result.code).toBe(1);
      expect(result.message).toContain('302');
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it('wants exactly 200, as over HTTPS (a 202 with a healthy body is not PiPulse)', async () => {
    const port = await listen(respond(202, JSON.stringify(OK)));
    const result = await checkHealth(httpEnv(port), { readState: noState });
    expect(result.code).toBe(1);
    expect(result.message).toContain('202');
  });

  it('is not healthy for an answer with no body, or a body that is not JSON', async () => {
    const empty = createHttpServer((_q, res) => {
      res.statusCode = 204;
      res.end();
    });
    const emptyPort = await listen(empty);
    const none = await checkHealth(httpEnv(emptyPort), { readState: noState });
    expect(none).toEqual({ code: 1, message: 'unhealthy (HTTP 204)' });
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const port = await listen(respond(200, 'not json'));
    expect(await checkHealth(httpEnv(port), { readState: noState })).toEqual({
      code: 1,
      message: 'unhealthy (HTTP 200)'
    });
  });

  it('says what is wrong with PIPULSE_PORT instead of trying a port', async () => {
    const result = await checkHealth(
      { PIPULSE_TLS: 'off', PIPULSE_PORT: '80x' },
      { readState: noState }
    );
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/^PIPULSE_PORT must be a port number/);
  });

  it('refuses an oversized body instead of reading it all', async () => {
    const port = await listen(respond(200, 'x'.repeat(65 * 1024)));
    const result = await checkHealth(httpEnv(port), { readState: noState });
    expect(result.code).toBe(1);
    expect(result.message).toContain('too large');
  });
});

describe('review fixes: one reading of the port and the host', () => {
  it('an empty PIPULSE_PORT is the default port for the check, as for the server', () => {
    expect(listenPort({})).toBe(8889);
    expect(listenPort({ PIPULSE_PORT: '' })).toBe(8889);
    expect(listenPort({ PIPULSE_PORT: '  ' })).toBe(8889);
    expect(listenPort({ PIPULSE_PORT: ' 9000 ' })).toBe(9000);
    expect(listenPort({ PIPULSE_PORT: '0' })).toBe(0);
  });

  it.each(['abc', '70000', '-1', '80.5', '1e3', '0x50'])('refuses PIPULSE_PORT=%s', (port) => {
    expect(() => listenPort({ PIPULSE_PORT: port })).toThrow(/PIPULSE_PORT/);
  });

  it('an empty or blank PIPULSE_HOST is every address, and a host is trimmed', () => {
    expect(listenHost({})).toBe('0.0.0.0');
    expect(listenHost({ PIPULSE_HOST: '' })).toBe('0.0.0.0');
    expect(listenHost({ PIPULSE_HOST: '  ' })).toBe('0.0.0.0');
    expect(listenHost({ PIPULSE_HOST: ' 127.0.0.1 ' })).toBe('127.0.0.1');
  });
});
