import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkHealth,
  healthTarget,
  pendingReload,
  servedFingerprintOf
} from '../src/health-check.js';
import { issueCa, issueLeaf } from '../src/issue.js';
import { fixture, tempDir } from './helpers.js';
import { TEST_OPENSSL } from './openssl.js';

// Findings F1-F3 and F6 of the 2026-10-13 review of the health check, and N1.
const run = promisify(execFile);
const built = existsSync(fileURLToPath(new URL('../dist/health-check.js', import.meta.url)));
const distUrl = new URL('../dist/health-check.js', import.meta.url).href;

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

const put = (name: string, text: string, mode = 0o600) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
};
async function listen(s: HttpServer): Promise<number> {
  server = s;
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return (s.address() as AddressInfo).port;
}
const OK = JSON.stringify({ status: 'ok', monitoring: 'ok' });
const respond = (_q: unknown, res: import('node:http').ServerResponse) => {
  res.setHeader('content-type', 'application/json');
  res.end(OK);
};
const operatorEnv = (port: number, withCa = true): NodeJS.ProcessEnv => ({
  PIPULSE_TLS: 'on',
  PIPULSE_PORT: String(port),
  PIPULSE_TLS_CERT: put('cert.pem', fixture('leaf.crt') + fixture('intermediate.crt'), 0o644),
  PIPULSE_TLS_KEY: put('key.pem', fixture('leaf.key')),
  ...(withCa ? { PIPULSE_TLS_CA: put('ca.pem', fixture('root-ca.crt'), 0o644) } : {})
});

/** checkHealth in a child process whose environment is `env` (settings Node reads only at start). */
async function childCheck(env: NodeJS.ProcessEnv): Promise<{ code: number; message: string }> {
  const script = `import { checkHealth } from '${distUrl}'; console.log(JSON.stringify(await checkHealth(process.env)));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    timeout: 30_000
  });
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as { code: number; message: string };
}

const PROXY = {
  NODE_USE_ENV_PROXY: '1',
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9'
};

describe.skipIf(!built)('F1: the check never goes through a proxy', () => {
  it('HTTPS: loopback is reached directly although the environment names a proxy', async () => {
    const port = await listen(
      createHttpsServer(
        { key: fixture('leaf.key'), cert: fixture('leaf.crt') + fixture('intermediate.crt') },
        respond
      ) as unknown as HttpServer
    );
    expect(await childCheck({ ...operatorEnv(port), ...PROXY })).toEqual({
      code: 0,
      message: 'healthy'
    });
  });

  it('HTTP: the same', async () => {
    const port = await listen(createHttpServer(respond));
    expect(await childCheck({ PIPULSE_TLS: 'off', PIPULSE_PORT: String(port), ...PROXY })).toEqual({
      code: 0,
      message: 'healthy'
    });
  });
});

describe('F2: a certificate that names only a wildcard', () => {
  it('is probed by a name the wildcard covers, never by the wildcard itself', () => {
    const target = healthTarget({}, { dns: ['*.example.com'], ip: [] }, []);
    expect(target.identity).toBe('pipulse.example.com');
    expect(target.connect).toBe('127.0.0.1');
  });

  it('still prefers a plain name, localhost or an address when the certificate has one', () => {
    expect(
      healthTarget({}, { dns: ['*.example.com', 'pi.example.com'], ip: [] }, []).identity
    ).toBe('pi.example.com');
    expect(healthTarget({}, { dns: ['*.example.com', 'localhost'], ip: [] }, []).identity).toBe(
      'localhost'
    );
  });

  it('says what to set when the server refuses the probe name (421)', async () => {
    const port = await listen(
      createHttpsServer(
        { key: fixture('leaf.key'), cert: fixture('leaf.crt') + fixture('intermediate.crt') },
        (_q, res) => {
          res.statusCode = 421;
          res.end();
        }
      ) as unknown as HttpServer
    );
    const result = await checkHealth(operatorEnv(port), { readState: () => undefined });
    expect(result.code).toBe(1);
    expect(result.message).toContain('421');
    expect(result.message).toContain('PIPULSE_TLS_NAMES');
  });
});

describe.skipIf(!built)(
  'F3: an operator certificate is trusted by Node’s bundled roots alone',
  () => {
    it('NODE_EXTRA_CA_CERTS (set for webhooks) does not make a private CA look trusted', async () => {
      const port = await listen(
        createHttpsServer(
          { key: fixture('leaf.key'), cert: fixture('leaf.crt') + fixture('intermediate.crt') },
          respond
        ) as unknown as HttpServer
      );
      const extra = put('extra.pem', fixture('root-ca.crt'), 0o644);
      const result = await childCheck({
        ...operatorEnv(port, false),
        NODE_EXTRA_CA_CERTS: extra
      });
      expect(result.code).toBe(2);
    });
  }
);

describe('F6: a CA replaced on disk before the server reloads', () => {
  /** A generated layout: the server serves a leaf of the OLD CA; ca.crt and leaf.pem are the NEW ones. */
  async function rotation(
    leafAgeMs: number,
    servedElsewhere: boolean | 'status-file' | 'default-dir' = true
  ): Promise<number> {
    const scope = {
      dns: ['localhost'],
      excludedDns: [],
      ip: [{ address: '127.0.0.1', prefix: 32 }]
    };
    const make = async (name: string) => {
      const work = join(dir, name);
      mkdirSync(work);
      const ca = await issueCa({
        openssl: TEST_OPENSSL,
        workDir: work,
        subject: `${name} CA`,
        scope,
        now: Date.now()
      });
      writeFileSync(join(work, 'ca.key'), ca.keyPem, { mode: 0o600 });
      writeFileSync(join(work, 'ca.crt'), ca.certPem);
      const leaf = await issueLeaf({
        openssl: TEST_OPENSSL,
        workDir: work,
        ca: { keyPath: join(work, 'ca.key'), certPath: join(work, 'ca.crt'), certPem: ca.certPem },
        subject: 'localhost',
        dns: ['localhost'],
        ip: ['127.0.0.1'],
        now: Date.now()
      });
      return { ca, leaf };
    };
    const oldPair = await make('old');
    const newPair = await make('new');
    const tls = join(dir, 'tls');
    mkdirSync(tls);
    writeFileSync(join(tls, 'state.json'), '{"version":1,"mode":"https"}\n');
    writeFileSync(join(tls, 'ca.crt'), newPair.ca.certPem);
    writeFileSync(join(tls, 'leaf.pem'), newPair.leaf.certPem + newPair.leaf.keyPem);
    const when = new Date(Date.now() - leafAgeMs);
    utimesSync(join(tls, 'leaf.pem'), when, when);
    const port = await listen(
      createHttpsServer(
        { key: oldPair.leaf.keyPem, cert: oldPair.leaf.certPem },
        respond
      ) as unknown as HttpServer
    );
    const result = await checkHealth(
      {
        PIPULSE_TLS_DIR: tls,
        PIPULSE_PORT: String(port),
        ...(servedElsewhere === 'status-file'
          ? { PIPULSE_RUNTIME_DIR: join(dir, 'no-status-here') }
          : {})
      },
      servedElsewhere === 'status-file' || servedElsewhere === 'default-dir'
        ? {}
        : {
            // what the running server's status file says it serves
            servedFingerprint: () =>
              servedElsewhere
                ? new X509Certificate(oldPair.leaf.certPem).fingerprint256
                : new X509Certificate(newPair.leaf.certPem).fingerprint256
          }
    );
    lastMessage = result.message;
    return result.code;
  }
  let lastMessage = '';

  it('is healthy, and says so, while a just-written leaf is waiting to be reloaded', async () => {
    expect(await rotation(30_000)).toBe(0);
    expect(lastMessage).toMatch(/reload.*pending|pending.*reload/i);
  });

  it('is a verification failure (2) when the server already serves what leaf.pem holds', async () => {
    expect(await rotation(30_000, false)).toBe(2);
  });

  it('with no status file to say what the server serves, it is a verification failure (2)', async () => {
    expect(await rotation(30_000, 'status-file')).toBe(2);
  });

  it('...nor at the default runtime folder, which holds none here either', async () => {
    expect(await rotation(30_000, 'default-dir')).toBe(2);
  });

  it('is a verification failure (2) once the leaf on disk is old: the server should have reloaded', async () => {
    expect(await rotation(30 * 60_000)).toBe(2);
  });
});

describe('the plain-HTTP check has a deadline', () => {
  it('gives up on a server that never answers', async () => {
    const port = await listen(createHttpServer(() => undefined));
    const result = await checkHealth(
      { PIPULSE_TLS: 'off', PIPULSE_PORT: String(port) },
      { timeoutMs: 100 }
    );
    expect(result.code).toBe(1);
    expect(result.message).toContain('timed out');
  });
});

describe('what the running server says it serves', () => {
  const fingerprint = new X509Certificate(fixture('leaf.crt')).fingerprint256;
  const status = (certificate: object | null) =>
    ({
      state: 'running',
      status: {
        version: 1,
        transport: 'https',
        certificate,
        pid: 1,
        startTime: 's',
        bootId: 'b',
        writtenAt: 1
      }
    }) as never;

  it('is the served certificate’s fingerprint, or nothing', () => {
    expect(servedFingerprintOf(status({ fingerprint }))).toBe(fingerprint);
    expect(servedFingerprintOf(status(null))).toBeUndefined();
    expect(servedFingerprintOf({ state: 'not-running', reason: 'missing' })).toBeUndefined();
  });

  it('pendingReload says nothing when leaf.pem cannot be examined', () => {
    expect(pendingReload(join(dir, 'missing.pem'), fixture('leaf.crt'), {}, {})).toBeUndefined();
  });
});
