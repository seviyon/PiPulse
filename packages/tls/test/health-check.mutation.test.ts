import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ISSUER_MISMATCH,
  RELOAD_PENDING_MS,
  checkHealth,
  healthTarget,
  healthy,
  pendingReload,
  verificationFailure
} from '../src/health-check.js';
import { issueCa, issueLeaf } from '../src/ca/issue.js';
import { userId } from '../src/ca/layout.js';
import { processIdentity, writeRuntimeStatus } from '../src/ca/runtime-status.js';
import { X509Certificate } from 'node:crypto';
import { fixture, tempDir } from './helpers.js';
import { TEST_OPENSSL } from './openssl.js';

// Tests that pin the behaviour mutation testing showed was unchecked in health-check.ts.
const run = promisify(execFile);
const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const srcEntry = fileURLToPath(new URL('../src/health-check.ts', import.meta.url));

let dir: string;
let server: HttpServer | undefined;
let extra: Array<{ close: (cb: () => void) => void }> = [];
let sockets: Array<{ destroy: () => void }> = [];
beforeEach(() => {
  dir = tempDir();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  sockets = [];
  server?.closeAllConnections();
  const all = [...(server ? [server] : []), ...extra];
  await Promise.all(all.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  server = undefined;
  extra = [];
  rmSync(dir, { recursive: true, force: true });
});

const put = (name: string, text: string, mode = 0o600) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
};
const OK = { status: 'ok', monitoring: 'ok' };
const noState = () => undefined;
const legacyHttp = () => '{"version":1,"mode":"legacy-http"}';

async function listen(s: HttpServer): Promise<number> {
  server = s;
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return (s.address() as AddressInfo).port;
}
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const json =
  (status: number, body: unknown): Handler =>
  (_req, res) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
/** Answers only on the real path, so a request for any other path is told apart. */
const onlyHealthPath =
  (inner: Handler): Handler =>
  (req, res) =>
    req.url === '/api/health' ? inner(req, res) : json(404, { error: 'no' })(req, res);
const https = (handler: Handler, options: Record<string, unknown> = {}) =>
  createHttpsServer(
    {
      key: fixture('leaf.key'),
      cert: fixture('leaf.crt') + fixture('intermediate.crt'),
      ...options
    },
    handler
  ) as unknown as HttpServer;
const tlsEnv = (port: number, more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PIPULSE_TLS: 'on',
  PIPULSE_PORT: String(port),
  PIPULSE_TLS_CERT: put('cert.pem', fixture('leaf.crt') + fixture('intermediate.crt'), 0o644),
  PIPULSE_TLS_KEY: put('key.pem', fixture('leaf.key')),
  PIPULSE_TLS_CA: put('ca.pem', fixture('root-ca.crt'), 0o644),
  ...more
});
/** A JSON health body of exactly `bytes` bytes. */
const body = (bytes: number) => {
  const head = '{"monitoring":"ok","pad":"';
  const tail = '"}';
  return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
};
const MAX = 64 * 1024;
const freePort = async (): Promise<number> => {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

describe('verificationFailure and healthy, edge inputs', () => {
  it('needs the UNSPECIFIED code for the name-constraint wording to count', () => {
    for (const code of ['ECONNRESET', undefined, 'ECONNREFUSED']) {
      expect(verificationFailure({ ...(code ? { code } : {}), message: 'name constraint' })).toBe(
        false
      );
      expect(verificationFailure({ ...(code ? { code } : {}), message: 'subtree violation' })).toBe(
        false
      );
    }
    expect(verificationFailure({ code: 'UNSPECIFIED', message: 'subtree violation' })).toBe(true);
    expect(verificationFailure({ code: 'UNSPECIFIED', message: 'something else' })).toBe(false);
  });

  it('is false for null, and for a body with neither monitoring nor an ok status', () => {
    expect(healthy(null)).toBe(false);
    expect(healthy({})).toBe(false);
    expect(healthy({ status: 'degraded' })).toBe(false);
    expect(healthy({ monitoring: 'ok' })).toBe(true);
    expect(healthy({ status: 'ok' })).toBe(true);
    expect(healthy({ monitoring: 'failing', status: 'ok' })).toBe(false);
  });
});

describe('ISSUER_MISMATCH', () => {
  it('is exactly the five codes that mean "not issued by the CA in ca.crt"', () => {
    expect([...ISSUER_MISMATCH].sort()).toEqual([
      'CERT_SIGNATURE_FAILURE',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    ]);
  });
});

describe('pendingReload at its edges', () => {
  const T = 1_700_000_000; // seconds; utimes is exact for whole seconds
  const call = (ageMs: number, served: string | null = 'AA:BB') => {
    const path = put('leaf.pem', fixture('leaf.crt'));
    utimesSync(path, T, T);
    return pendingReload(
      path,
      fixture('leaf.crt'),
      {},
      { servedFingerprint: () => served ?? undefined, now: () => T * 1000 + ageMs }
    );
  };

  it('counts a leaf from the moment it is written up to and including 10 minutes', () => {
    expect(call(0)).toBeDefined();
    expect(call(RELOAD_PENDING_MS)).toBeDefined();
    expect(call(RELOAD_PENDING_MS + 1)).toBeUndefined();
    expect(call(-1)).toBeUndefined();
  });

  it('says how many seconds ago the leaf was written, in seconds', () => {
    expect(call(90_000)).toContain('written 90 s ago');
  });

  it('says nothing when the status file does not say what is served', () => {
    expect(call(1000, null)).toBeUndefined();
  });
});

describe('healthTarget, edge inputs', () => {
  const none = { dns: [], ip: [] };

  it('treats [::] as a wildcard bind', () => {
    expect(healthTarget({ PIPULSE_HOST: '[::]' }, none, [])).toEqual({
      connect: '127.0.0.1',
      identity: '127.0.0.1'
    });
  });

  it('trims the host, and a blank one is a wildcard', () => {
    expect(healthTarget({ PIPULSE_HOST: '  10.0.0.5  ' }, none, [])).toEqual({
      connect: '10.0.0.5',
      identity: '10.0.0.5'
    });
    expect(healthTarget({ PIPULSE_HOST: '   ' }, none, []).connect).toBe('127.0.0.1');
  });

  it('strips brackets only when they wrap the whole host', () => {
    expect(healthTarget({ PIPULSE_HOST: '[::1]' }, none, []).connect).toBe('::1');
    expect(healthTarget({ PIPULSE_HOST: 'a[b]' }, none, []).connect).toBe('a[b]');
    expect(healthTarget({ PIPULSE_HOST: '[b]c' }, none, []).connect).toBe('[b]c');
  });

  it('builds the probe name from the first real wildcard, not from any name', () => {
    expect(healthTarget({}, { dns: ['*foo', '*.example.com'], ip: [] }, []).identity).toBe(
      'pipulse.example.com'
    );
  });

  it('prefers a plain DNS name over a wildcard one, and 127.0.0.1 over another address', () => {
    expect(
      healthTarget({}, { dns: ['*.example.com', 'host.example.com'], ip: [] }, []).identity
    ).toBe('host.example.com');
    expect(healthTarget({}, { dns: [], ip: ['10.0.0.9', '127.0.0.1'] }, []).identity).toBe(
      '127.0.0.1'
    );
  });
});

describe('the plain-HTTP check', () => {
  it('asks for /api/health, accepts a body of exactly 64 KiB and refuses one byte more', async () => {
    const port = await listen(createHttpServer(onlyHealthPath(json(200, body(MAX)))));
    expect(await checkHealth({ PIPULSE_TLS: 'off', PIPULSE_PORT: String(port) })).toEqual({
      code: 0,
      message: 'healthy'
    });
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const port2 = await listen(createHttpServer(onlyHealthPath(json(200, body(MAX + 1)))));
    const result = await checkHealth({ PIPULSE_TLS: 'off', PIPULSE_PORT: String(port2) });
    expect(result.code).toBe(1);
    expect(result.message).toContain('too large');
  });

  it('uses the saved state when no setting decides, and the setting over certificates', async () => {
    const port = await listen(createHttpServer(json(200, OK)));
    expect(await checkHealth({ PIPULSE_PORT: String(port) }, { readState: legacyHttp })).toEqual({
      code: 0,
      message: 'healthy'
    });
    // PIPULSE_TLS=off wins even though a certificate is configured.
    expect(await checkHealth(tlsEnv(port, { PIPULSE_TLS: 'off' }), { readState: noState })).toEqual(
      { code: 0, message: 'healthy' }
    );
  });

  it('cancels its deadline when it is done, on an answer and on an error', async () => {
    const real = globalThis.setTimeout;
    const made: unknown[] = [];
    const cleared: unknown[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const handle = real(fn, ms);
      if (ms === 7777) made.push(handle);
      return handle;
    }) as typeof setTimeout);
    const realClear = globalThis.clearTimeout;
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: never) => {
      cleared.push(handle);
      realClear(handle);
    }) as typeof clearTimeout);
    const port = await listen(createHttpServer(json(200, OK)));
    await checkHealth({ PIPULSE_TLS: 'off', PIPULSE_PORT: String(port) }, { timeoutMs: 7777 });
    expect(made).toHaveLength(1);
    expect(cleared).toContain(made[0]);
    const dead = await freePort();
    await checkHealth({ PIPULSE_TLS: 'off', PIPULSE_PORT: String(dead) }, { timeoutMs: 7777 });
    expect(made).toHaveLength(2);
    expect(cleared).toContain(made[1]);
  });
});

describe('the HTTPS check, request and answer', () => {
  it('asks for /api/health, names the host in SNI and in the Host header', async () => {
    const names: string[] = [];
    const hosts: Array<string | undefined> = [];
    const context = createSecureContext({
      key: fixture('leaf.key'),
      cert: fixture('leaf.crt') + fixture('intermediate.crt')
    });
    const port = await listen(
      https(
        onlyHealthPath((req, res) => {
          hosts.push(req.headers.host);
          json(200, OK)(req, res);
        }),
        {
          SNICallback: (name: string, cb: (e: Error | null, c: unknown) => void) => (
            names.push(name),
            cb(null, context)
          )
        }
      )
    );
    expect(await checkHealth(tlsEnv(port), { readState: noState })).toEqual({
      code: 0,
      message: 'healthy'
    });
    expect(names).toEqual(['localhost']);
    expect(hosts).toEqual([`localhost:${port}`]);
  });

  it('sends no SNI for an address, and an address in the Host header', async () => {
    const names: string[] = [];
    const hosts: Array<string | undefined> = [];
    const context = createSecureContext({
      key: fixture('leaf.key'),
      cert: fixture('leaf.crt') + fixture('intermediate.crt')
    });
    const port = await listen(
      https(
        (req, res) => {
          hosts.push(req.headers.host);
          json(200, OK)(req, res);
        },
        {
          SNICallback: (name: string, cb: (e: Error | null, c: unknown) => void) => (
            names.push(name),
            cb(null, context)
          )
        }
      )
    );
    const result = await checkHealth(tlsEnv(port, { PIPULSE_HOST: '127.0.0.1' }), {
      readState: noState
    });
    expect(result.code).toBe(0);
    expect(names.filter(Boolean)).toEqual([]);
    expect(hosts).toEqual([`127.0.0.1:${port}`]);
  });

  it('wants exactly 200 with a healthy body, and says which status it got', async () => {
    for (const status of [202, 503, 404]) {
      const port = await listen(https(json(status, OK)));
      expect(await checkHealth(tlsEnv(port), { readState: noState })).toEqual({
        code: 1,
        message: `unhealthy (HTTP ${status})`
      });
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });

  it('accepts a body of exactly 64 KiB', async () => {
    const port = await listen(https(json(200, body(MAX))));
    expect((await checkHealth(tlsEnv(port), { readState: noState })).code).toBe(0);
  });

  it('gives up on a server that accepts the connection and never answers, and says why', async () => {
    const silent = createNetServer((socket) => void sockets.push(socket));
    extra.push(silent);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as AddressInfo).port;
    expect(await checkHealth(tlsEnv(port), { readState: noState, timeoutMs: 300 })).toEqual({
      code: 1,
      message: 'not answering: timed out'
    });
  });

  it('cancels its deadline when it is done', async () => {
    const real = globalThis.setTimeout;
    const made: unknown[] = [];
    const cleared: unknown[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const handle = real(fn, ms);
      if (ms === 7777) made.push(handle);
      return handle;
    }) as typeof setTimeout);
    const realClear = globalThis.clearTimeout;
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: never) => {
      cleared.push(handle);
      realClear(handle);
    }) as typeof clearTimeout);
    const port = await listen(https(json(200, OK)));
    await checkHealth(tlsEnv(port), { readState: noState, timeoutMs: 7777 });
    expect(made.length).toBeGreaterThan(0);
    expect(cleared).toContain(made[0]);
  });
});

describe('the check leaves no connection open', () => {
  const closed = () =>
    vi.waitFor(
      () =>
        new Promise<void>((resolve, reject) =>
          server!.getConnections((error, count) =>
            error || count > 0 ? reject(error ?? new Error(`${count} open`)) : resolve()
          )
        ),
      { timeout: 1500, interval: 25 }
    );

  it('over plain HTTP', async () => {
    const port = await listen(createHttpServer(json(200, OK)));
    await checkHealth({ PIPULSE_TLS: 'off', PIPULSE_PORT: String(port) });
    await closed();
  });

  it('over HTTPS', async () => {
    const port = await listen(https(json(200, OK)));
    await checkHealth(tlsEnv(port), { readState: noState });
    await closed();
  });
});

describe('the HTTPS check reads the certificate files', () => {
  it('names the setting when the operator certificate cannot be read', async () => {
    const result = await checkHealth(
      {
        PIPULSE_TLS: 'on',
        PIPULSE_PORT: '1',
        PIPULSE_TLS_CERT: put('cert.pem', 'not a certificate', 0o644),
        PIPULSE_TLS_KEY: put('key.pem', fixture('leaf.key'))
      },
      { readState: noState }
    );
    expect(result.code).toBe(1);
    expect(result.message).toContain("can't read the certificate: PIPULSE_TLS_CERT");
  });

  it('names leaf.pem when a generated bundle cannot be read', async () => {
    const tls = join(dir, 'tls');
    mkdirSync(tls);
    writeFileSync(join(tls, 'state.json'), '{"version":1,"mode":"https"}\n');
    writeFileSync(join(tls, 'ca.crt'), fixture('root-ca.crt'));
    writeFileSync(join(tls, 'leaf.pem'), 'garbage');
    const result = await checkHealth({ PIPULSE_TLS_DIR: tls, PIPULSE_PORT: '1' });
    expect(result.code).toBe(1);
    expect(result.message).toContain("can't read the certificate:");
    expect(result.message).toContain('leaf.pem');
  });
});

describe('a refused connection is not a pending reload', () => {
  it('stays "not answering" for a generated certificate even when the leaf is brand new', async () => {
    const tls = join(dir, 'tls');
    mkdirSync(tls);
    writeFileSync(join(tls, 'state.json'), '{"version":1,"mode":"https"}\n');
    writeFileSync(join(tls, 'ca.crt'), fixture('root-ca.crt'));
    writeFileSync(join(tls, 'leaf.pem'), fixture('leaf.crt') + fixture('leaf.key'));
    const result = await checkHealth(
      { PIPULSE_TLS_DIR: tls, PIPULSE_PORT: String(await freePort()) },
      { servedFingerprint: () => 'AA:BB' }
    );
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/^not answering: /);
  });
});

describe('run as a command', () => {
  const active = process.env['__STRYKER_ACTIVE_MUTANT__'];
  const stryker = active === undefined ? {} : { __STRYKER_ACTIVE_MUTANT__: active };
  const exec = async (env: NodeJS.ProcessEnv) => {
    try {
      const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', srcEntry], {
        cwd: pkgDir,
        // Stryker's command runner names the active mutant in the environment; the child must see it
        // or it runs the unmutated code and no mutant in the command's entry can fail.
        env: { PATH: process.env['PATH'] ?? '', ...stryker, ...env },
        timeout: 30_000
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  };

  it('prints nothing and exits 0 when healthy', async () => {
    const port = await listen(createHttpServer(json(200, OK)));
    expect(await exec({ PIPULSE_TLS: 'off', PIPULSE_PORT: String(port) })).toEqual({
      code: 0,
      stdout: '',
      stderr: ''
    });
  });

  it('prints one line to stderr and exits with the check’s code when not', async () => {
    const port = await listen(createHttpServer(json(503, OK)));
    const result = await exec({ PIPULSE_TLS: 'off', PIPULSE_PORT: String(port) });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('[pipulse] health check: unhealthy (HTTP 503)\n');
  });
});

describe('an IPv6 identity in the Host header', () => {
  it('is bracketed', async ({ skip }) => {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createNetServer();
      probe.once('error', () => resolve(false));
      probe.listen(0, '::1', () => probe.close(() => resolve(true)));
    });
    if (!free) skip();
    const now = Date.now();
    const scope = {
      dns: ['localhost'],
      excludedDns: [],
      ip: [{ address: '::1', prefix: 128 }]
    };
    const ca = await issueCa({ openssl: TEST_OPENSSL, workDir: dir, subject: 'V6 CA', scope, now });
    writeFileSync(join(dir, 'ca.key'), ca.keyPem, { mode: 0o600 });
    writeFileSync(join(dir, 'ca.crt'), ca.certPem);
    const leaf = await issueLeaf({
      openssl: TEST_OPENSSL,
      workDir: dir,
      ca: { keyPath: join(dir, 'ca.key'), certPath: join(dir, 'ca.crt'), certPem: ca.certPem },
      subject: 'localhost',
      dns: [],
      ip: ['::1'],
      now
    });
    const hosts: Array<string | undefined> = [];
    server = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
      hosts.push(req.headers.host);
      json(200, OK)(req, res);
    }) as unknown as HttpServer;
    await new Promise<void>((resolve) => server!.listen(0, '::1', resolve));
    const port = (server.address() as AddressInfo).port;
    const result = await checkHealth(
      {
        PIPULSE_TLS: 'on',
        PIPULSE_PORT: String(port),
        PIPULSE_HOST: '::1',
        PIPULSE_TLS_CERT: put('v6cert.pem', leaf.certPem, 0o644),
        PIPULSE_TLS_KEY: put('v6key.pem', leaf.keyPem),
        PIPULSE_TLS_CA: put('v6ca.pem', ca.certPem, 0o644)
      },
      { readState: noState }
    );
    expect(result.code).toBe(0);
    expect(hosts).toEqual([`[::1]:${port}`]);
  });

  it('is bracketed when the check connects to 127.0.0.1 but must verify ::1 (a wildcard bind)', async ({
    skip
  }) => {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createNetServer();
      probe.once('error', () => resolve(false));
      probe.listen(0, '::1', () => probe.close(() => resolve(true)));
    });
    if (!free) skip();
    const now = Date.now();
    const scope = { dns: ['localhost'], excludedDns: [], ip: [{ address: '::1', prefix: 128 }] };
    const ca = await issueCa({ openssl: TEST_OPENSSL, workDir: dir, subject: 'V6 CA', scope, now });
    writeFileSync(join(dir, 'ca.key'), ca.keyPem, { mode: 0o600 });
    writeFileSync(join(dir, 'ca.crt'), ca.certPem);
    const leaf = await issueLeaf({
      openssl: TEST_OPENSSL,
      workDir: dir,
      ca: { keyPath: join(dir, 'ca.key'), certPath: join(dir, 'ca.crt'), certPem: ca.certPem },
      subject: 'localhost',
      dns: [],
      ip: ['::1'],
      now
    });
    const hosts: Array<string | undefined> = [];
    const port = await listen(
      https(
        (req, res) => {
          hosts.push(req.headers.host);
          json(200, OK)(req, res);
        },
        { key: leaf.keyPem, cert: leaf.certPem }
      )
    );
    const result = await checkHealth(
      {
        PIPULSE_TLS: 'on',
        PIPULSE_PORT: String(port),
        PIPULSE_TLS_CERT: put('v6cert.pem', leaf.certPem, 0o644),
        PIPULSE_TLS_KEY: put('v6key.pem', leaf.keyPem),
        PIPULSE_TLS_CA: put('v6ca.pem', ca.certPem, 0o644)
      },
      { readState: noState }
    );
    expect(result.code).toBe(0);
    // The identity is the certificate's own text for the address (OpenSSL writes ::1 in full).
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatch(new RegExp(`^\\[[0-9a-f:]+\\]:${port}$`));
  });
});

// The running server's status file is read through /proc, which only Linux has; and a machine
// with a `pipulse` user expects the file to be that user's, which a test cannot make it.
describe.skipIf(process.platform !== 'linux' || userId('pipulse') !== undefined)(
  'pendingReload with no fingerprint given reads the running server’s status file',
  () => {
    const leaf = () => fixture('leaf.crt');
    const write = (fingerprint: string) => {
      const identity = processIdentity(process.pid)!;
      writeRuntimeStatus(dir, {
        version: 1,
        transport: 'https',
        certificate: {
          source: 'generated',
          fingerprint,
          class: 'valid',
          notAfter: 5,
          reload: { state: 'ok', lastAttempt: null, lastError: null }
        },
        pid: process.pid,
        startTime: identity.startTime,
        bootId: identity.bootId,
        writtenAt: 1
      });
    };
    const recentLeaf = () => {
      const path = put('leaf.pem', leaf());
      const now = Date.now();
      utimesSync(path, new Date(now - 1000), new Date(now - 1000));
      return { path, now };
    };
    const other = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(
      ':'
    );

    it('says the reload is pending while the server serves another certificate', () => {
      write(other);
      const { path, now } = recentLeaf();
      expect(
        pendingReload(path, leaf(), { PIPULSE_RUNTIME_DIR: `  ${dir}  ` }, { now: () => now })
      ).toContain('pending reload');
    });

    it('says nothing when the server already serves what leaf.pem holds', () => {
      write(new X509Certificate(leaf()).fingerprint256);
      const { path, now } = recentLeaf();
      expect(
        pendingReload(path, leaf(), { PIPULSE_RUNTIME_DIR: dir }, { now: () => now })
      ).toBeUndefined();
    });
  }
);
