import { connect, createServer } from 'node:net';
import { request } from 'node:https';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builtinPlugins, type CollectorPlugin } from '@pipulse/collector';
import { loadConfig, StartupError } from '../src/config.js';
import { startServer, type RunningServer } from '../src/runtime.js';
import { fixture } from '../../tls/test/helpers.js';

// The real marker writer, unless a test makes it report a problem (a folder where the file goes
// counts as "already there", and a read-only folder would not stop a root test run).
vi.mock('../src/tls-status.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tls-status.js')>();
  return { ...actual, writeTlsMarker: vi.fn(actual.writeTlsMarker) };
});
const { writeTlsMarker } = await import('../src/tls-status.js');

let dir: string;
const running: RunningServer[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipulse-runtime-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Every built-in id has to be known (the built-in rules name them); cpu_load is the one tests
 * drive, polled every 50 ms, and the others answer 1 on their own schedule.
 */
const plugin = (collect: () => Promise<number | null> = async () => 1): CollectorPlugin[] =>
  builtinPlugins.map((builtin) =>
    builtin.id === 'cpu_load'
      ? { ...builtin, intervalMs: 50, collect }
      : { ...builtin, collect: async () => 1 }
  );
const device = { hostname: 'test', platform: 'linux', arch: 'arm' };

const settings = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PIPULSE_DB_PATH: join(dir, 'p.sqlite'),
  PIPULSE_HOST: '127.0.0.1',
  PIPULSE_PORT: '0',
  PIPULSE_TLS: 'off',
  PIPULSE_TLS_DIR: join(dir, 'tls'),
  PIPULSE_RUNTIME_DIR: join(dir, 'run'),
  PIPULSE_WEB_DIR: join(dir, 'no-dashboard'),
  ...extra
});
const start = async (
  extra: Record<string, string> = {},
  plugins: CollectorPlugin[] = plugin(),
  more: { shutdownTimeoutMs?: number } = {}
) => {
  const server = await startServer(loadConfig(settings(extra)), { plugins, device, ...more });
  running.push(server);
  return server;
};
const httpsSettings = (cert: string, key: string, extra: Record<string, string> = {}) => {
  writeFileSync(join(dir, 'cert.pem'), cert);
  writeFileSync(join(dir, 'key.pem'), key, { mode: 0o600 });
  mkdirSync(join(dir, 'timesync'), { recursive: true });
  writeFileSync(join(dir, 'timesync', 'synchronized'), '');
  return {
    PIPULSE_TLS: 'on',
    PIPULSE_TLS_CERT: join(dir, 'cert.pem'),
    PIPULSE_TLS_KEY: join(dir, 'key.pem'),
    PIPULSE_TLS_TIMESYNC_DIR: join(dir, 'timesync'),
    ...extra
  };
};
const goodHttps = (extra: Record<string, string> = {}) =>
  httpsSettings(fixture('leaf.crt') + fixture('intermediate.crt'), fixture('leaf.key'), extra);
/** GET over HTTPS, verifying against the fixtures' root (as https.test.ts does), never skipping it. */
const trustedJson = (port: number, path: string) =>
  new Promise<unknown>((resolve, reject) => {
    request(
      {
        host: '127.0.0.1',
        port,
        path,
        ca: fixture('root-ca.crt'),
        servername: 'localhost',
        agent: false
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve(JSON.parse(body)));
      }
    )
      .on('error', reject)
      .end();
  });
/** Whether something accepts TCP connections on the port (for a chain a client would refuse). */
const accepts = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('startServer', () => {
  it('starts over HTTP, serves its routes, and stops cleanly', async () => {
    const server = await start();
    const { host, port } = server.address();
    expect(port).toBeGreaterThan(0);
    expect(await (await fetch(`http://${host}:${port}/health`)).json()).toEqual({ status: 'ok' });
    const config = (await (await fetch(`http://${host}:${port}/api/config`)).json()) as {
      plugins: Array<{ id: string }>;
    };
    expect(config.plugins.map((p) => p.id)).toEqual(builtinPlugins.map((p) => p.id));
    await expect(server.stop()).resolves.toEqual({ drained: true });
    await expect(fetch(`http://${host}:${port}/health`)).rejects.toThrow();
  });

  it('starts over HTTPS, writes the data-folder marker, and reports the transport', async () => {
    const server = await start(goodHttps());
    const health = (await trustedJson(server.address().port, '/api/health')) as {
      transport: string;
    };
    expect(health.transport).toBe('https');
    expect(existsSync(join(dir, 'tls-installed'))).toBe(true);
  });

  it('says so, loudly, when the data-folder marker cannot be written', async () => {
    vi.mocked(writeTlsMarker).mockReturnValueOnce('tls-installed could not be written (EACCES)');
    const server = await start(goodHttps());
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      '[pipulse] ERROR: tls-installed could not be written (EACCES): if the TLS folder is ever lost'
    );
    const config = (await trustedJson(server.address().port, '/api/config')) as {
      tls?: { markerProblem?: string };
    };
    expect(JSON.stringify(config)).toContain('EACCES');
  });

  it('starts, with a SEVERE line, with an expired certificate', async () => {
    const server = await start(
      httpsSettings(
        fixture('under-expired.crt') + fixture('expired-intermediate.crt'),
        fixture('under-expired.key')
      )
    );
    // A client would refuse the expired chain, so check that the port is open, not a response.
    expect(await accepts(server.address().port)).toBe(true);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain(
      '[pipulse] SEVERE: the HTTPS certificate is expired'
    );
  });

  it('prints the config warnings before anything else', async () => {
    await start({ PIPULSE_TLS_CERT: '/x.pem', PIPULSE_TLS_KEY: '/x.key' });
    expect(vi.mocked(console.warn).mock.calls[0]![0]).toBe(
      '[pipulse] warning: PIPULSE_TLS_CERT/PIPULSE_TLS_KEY are set but HTTPS is off (set PIPULSE_TLS=on)'
    );
  });

  it('stops once however often it is asked, with the same answer', async () => {
    const server = await start();
    const first = server.stop();
    const second = server.stop();
    expect(second).toBe(first);
    expect(await first).toEqual({ drained: true });
  });

  it('stops collecting when it is stopped', async () => {
    let calls = 0;
    const server = await start(
      {},
      plugin(async () => {
        calls++;
        return 1;
      })
    );
    await wait(200);
    expect(calls).toBeGreaterThan(1);
    await server.stop();
    const after = calls;
    await wait(300);
    expect(calls).toBe(after);
  });

  it('does not wait for a read that never settles: drained is false', async () => {
    const server = await start(
      {},
      plugin(() => new Promise<number | null>(() => {})),
      {
        shutdownTimeoutMs: 50
      }
    );
    await expect(server.stop()).resolves.toEqual({ drained: false });
  });

  it.skipIf(process.platform !== 'linux')(
    'writes the runtime status file once it listens',
    async () => {
      mkdirSync(join(dir, 'run'));
      await start(goodHttps());
      expect(existsSync(join(dir, 'run', 'tls-status.json'))).toBe(true);
    }
  );
});

describe('startServer refuses before anything exists', () => {
  it('a certificate that does not match its key: no database, no port', async () => {
    const env = httpsSettings(
      fixture('leaf.crt') + fixture('intermediate.crt'),
      fixture('leaf2.key')
    );
    await expect(start(env)).rejects.toBeInstanceOf(StartupError);
    expect(existsSync(join(dir, 'p.sqlite'))).toBe(false);
  });

  it.each([
    ['PIPULSE_ALLOWED_HOSTS', { PIPULSE_ALLOWED_HOSTS: 'bad_name' }],
    ['PIPULSE_RETENTION_RAW', { PIPULSE_RETENTION_RAW: '10m' }]
  ])('a bad %s is refused by loadConfig, with nothing created', (_name, env) => {
    expect(() => loadConfig(settings(env))).toThrow(StartupError);
    expect(existsSync(join(dir, 'p.sqlite'))).toBe(false);
  });
});

describe('startServer cleans up after a failure part-way through', () => {
  it('a rules file that cannot be read: StartupError, and the database is closed', async () => {
    await expect(start({ PIPULSE_ALERTS_FILE: join(dir, 'missing.json') })).rejects.toThrow(
      /^PIPULSE_ALERTS_FILE .* could not be read: ENOENT$/
    );
    // The last connection closing is what removes the write-ahead log.
    expect(existsSync(join(dir, 'p.sqlite-wal'))).toBe(false);
  });

  it('a webhook file that cannot be read: StartupError, and the database is closed', async () => {
    await expect(start({ PIPULSE_NOTIFY_FILE: join(dir, 'missing.json') })).rejects.toThrow(
      /^PIPULSE_NOTIFY_FILE .* could not be read: ENOENT$/
    );
    expect(existsSync(join(dir, 'p.sqlite-wal'))).toBe(false);
  });

  it('raw retention too short for the built-in rules is refused', async () => {
    await expect(start({ PIPULSE_RETENTION_RAW: '1min' })).rejects.toBeInstanceOf(StartupError);
    expect(existsSync(join(dir, 'p.sqlite-wal'))).toBe(false);
  });

  it('a port already in use: the original listen error, and whatever started is stopped', async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const taken = (holder.address() as { port: number }).port;
    let calls = 0;
    const error: unknown = await start(
      { PIPULSE_PORT: String(taken) },
      plugin(async () => {
        calls++;
        return 1;
      })
    ).catch((caught: unknown) => caught);
    holder.close();
    expect((error as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
    expect(error).not.toBeInstanceOf(StartupError);
    const after = calls;
    await wait(300);
    expect(calls).toBe(after); // the scheduler it had started is stopped
    expect(existsSync(join(dir, 'p.sqlite-wal'))).toBe(false);
  });
});
