import { request } from 'node:https';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { builtinPlugins, type CollectorPlugin } from '@pipulse/collector';
import { loadConfig, type PiPulseConfig } from '../src/config.js';
import { fixture } from '../../tls/test/helpers.js';

// Pass-through wrappers that remember what startServer handed to each part, so the callbacks it
// wires up (logging, hooks between parts) can be called directly with what they would receive.
vi.mock('@pipulse/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pipulse/storage')>();
  return {
    ...actual,
    startHousekeeping: vi.fn(actual.startHousekeeping),
    retentionSource: vi.fn(actual.retentionSource)
  };
});
vi.mock('@pipulse/collector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pipulse/collector')>();
  return { ...actual, startScheduler: vi.fn(actual.startScheduler) };
});
vi.mock('@pipulse/alerts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pipulse/alerts')>();
  return {
    ...actual,
    startAlerts: vi.fn(actual.startAlerts),
    createRuleSource: vi.fn(actual.createRuleSource)
  };
});
vi.mock('@pipulse/notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pipulse/notify')>();
  return { ...actual, startNotifications: vi.fn(actual.startNotifications) };
});
vi.mock('../src/updates.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/updates.js')>();
  return { ...actual, createUpdates: vi.fn(actual.createUpdates) };
});
vi.mock('../src/app.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app.js')>();
  return { ...actual, buildServer: vi.fn(actual.buildServer) };
});
vi.mock('../src/health.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/health.js')>();
  return { ...actual, createHealth: vi.fn(actual.createHealth) };
});
vi.mock('../src/tls-status.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tls-status.js')>();
  return { ...actual, readGeneratedExtras: vi.fn(actual.readGeneratedExtras) };
});
vi.mock('@pipulse/tls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pipulse/tls')>();
  return { ...actual, processIdentity: vi.fn(actual.processIdentity) };
});
vi.mock('../src/tls-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tls-runtime.js')>();
  return {
    ...actual,
    startCertificateReloader: vi.fn(actual.startCertificateReloader),
    createRuntimeStatus: vi.fn(actual.createRuntimeStatus)
  };
});

const { startHousekeeping, retentionSource } = await import('@pipulse/storage');
const { startScheduler } = await import('@pipulse/collector');
const { startAlerts, createRuleSource } = await import('@pipulse/alerts');
const { createHealth } = await import('../src/health.js');
const { readGeneratedExtras } = await import('../src/tls-status.js');
const { processIdentity } = await import('@pipulse/tls');
const realUpdates = await vi.importActual<typeof import('../src/updates.js')>('../src/updates.js');
const { startNotifications } = await import('@pipulse/notify');
const { createUpdates } = await import('../src/updates.js');
const { buildServer } = await import('../src/app.js');
const { startCertificateReloader, createRuntimeStatus, loadServingCertificate } =
  await import('../src/tls-runtime.js');
const { startServer } = await import('../src/runtime.js');
type RunningServer = Awaited<ReturnType<typeof startServer>>;

let dir: string;
const running: RunningServer[] = [];
let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipulse-hooks-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const printed = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.flat().join('\n');

/** Every built-in id (the built-in rules name them), quiet and fast. */
const fakePlugins = (collect: () => Promise<number | null> = async () => 1): CollectorPlugin[] =>
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
  change: (config: PiPulseConfig) => PiPulseConfig = (config) => config,
  overrides: Parameters<typeof startServer>[1] = { plugins: fakePlugins(), device }
) => {
  const server = await startServer(change(loadConfig(settings(extra))), overrides);
  running.push(server);
  return server;
};
const httpsSettings = (extra: Record<string, string> = {}) => {
  writeFileSync(join(dir, 'cert.pem'), fixture('leaf.crt') + fixture('intermediate.crt'));
  writeFileSync(join(dir, 'key.pem'), fixture('leaf.key'), { mode: 0o600 });
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
/** The certificate (SHA-256) an HTTPS server presents on a new connection, and the response headers. */
const peer = (port: number) =>
  new Promise<{ fingerprint: string; headers: Record<string, unknown> }>((resolve, reject) => {
    request(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        ca: fixture('root-ca.crt'),
        servername: 'localhost',
        agent: false
      },
      (res) => {
        const { fingerprint256 } = (
          res.socket as unknown as { getPeerCertificate(): { fingerprint256: string } }
        ).getPeerCertificate();
        res.resume();
        res.on('end', () => resolve({ fingerprint: fingerprint256, headers: res.headers }));
      }
    )
      .on('error', reject)
      .end();
  });
const lastCall = <T extends (...args: never[]) => unknown>(fn: T) =>
  vi.mocked(fn).mock.calls.at(-1) as Parameters<T>;

describe('what startServer prints once it listens', () => {
  it('says the install is read-only without a password hash, and what is not encrypted', async () => {
    await start({}, (config) => config);
    expect(printed(log)).toContain('(HTTPS off: PIPULSE_TLS=off)');
    expect(printed(log)).toContain('(read-only: PIPULSE_ADMIN_PASSWORD_HASH_FILE not set)');
    expect(printed(warn)).not.toContain('sign-in is on but HTTPS is off');
  });

  it('warns that sign-in crosses the network unencrypted over HTTP, and says reads need sign-in', async () => {
    await start({}, (config) => ({
      ...config,
      auth: { passwordHash: 'scrypt$x', protectReads: true } as PiPulseConfig['auth']
    }));
    expect(printed(log)).toContain('(reads need sign-in)');
    expect(printed(log)).not.toContain('read-only');
    expect(printed(warn)).toContain(
      '[pipulse] warning: sign-in is on but HTTPS is off; the password and the session cookie cross the network unencrypted'
    );
  });

  it.each([
    ['env', '(HTTPS off: PIPULSE_TLS=off)'],
    ['state', '(HTTPS off: state.json legacy-http)'],
    ['default', '(HTTPS off: release default)']
  ] as const)('names why HTTPS is off when that is %s', async (modeReason, text) => {
    await start({}, (config) => ({ ...config, tls: { ...config.tls, modeReason } }));
    expect(printed(log)).toContain(text);
  });

  it('points at `pipulse tls enable` when HTTPS is prepared but not switched on', async () => {
    await start({}, (config) => ({
      ...config,
      tls: { ...config.tls, modeReason: 'state', stateMode: 'legacy-http' }
    }));
    expect(printed(log)).toContain('[pipulse] HTTPS is ready: sudo pipulse tls enable');
  });

  it('points at the compose command in a container', async () => {
    await start({}, (config) => ({
      ...config,
      inContainer: true,
      tls: { ...config.tls, modeReason: 'state', stateMode: 'legacy-http' }
    }));
    expect(printed(log)).toContain(
      '[pipulse] HTTPS is ready: docker compose run --rm pipulse-tls pipulse tls enable --yes, then docker compose restart pipulse'
    );
  });

  it('warns about a Node line that no longer gets security fixes', async () => {
    await start({}, (config) => ({
      ...config,
      node: { version: 'v18.0.0', line: 18, supportEnds: '2025-04-30', ended: true }
    }));
    expect(printed(warn)).toContain(
      '[pipulse] Node 18 no longer gets security fixes (since 2025-04-30)'
    );
  });

  it('prints the version, Node and where it listens', async () => {
    const server = await start();
    const { port } = server.address();
    expect(printed(log)).toMatch(
      new RegExp(
        `\\[pipulse\\] .+ \\(Node v?[\\d.]+\\) listening on http://127\\.0\\.0\\.1:${port} `
      )
    );
  });
});

describe('what startServer takes from the config', () => {
  it('marks the firmware plugins unavailable in a container and does not run them', async () => {
    const polled: string[] = [];
    const plugins = builtinPlugins.map((builtin) => ({
      ...builtin,
      collect: async () => (polled.push(builtin.id), 1)
    }));
    const server = await start({}, (config) => ({ ...config, inContainer: true }), {
      plugins,
      device
    });
    const { port } = server.address();
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()) as {
      plugins: Array<{ id: string; unavailable?: string }>;
    };
    expect(body.plugins.find((p) => p.id === 'cpu_voltage')?.unavailable).toBe(
      'Not available in Docker'
    );
    expect(body.plugins.find((p) => p.id === 'cpu_load')?.unavailable).toBeUndefined();
    expect(polled).not.toContain('cpu_voltage');
    expect(polled).toContain('cpu_load');
  });

  it("serves the dashboard's folder when it exists", async () => {
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'index.html'), '<title>dash</title>');
    const server = await start({ PIPULSE_WEB_DIR: join(dir, 'web') });
    const { port } = server.address();
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain(
      '<title>dash</title>'
    );
  });

  it("reads the device from the host's files and puts the host's own name on it", async () => {
    mkdirSync(join(dir, 'host/etc'), { recursive: true });
    writeFileSync(join(dir, 'host/etc/os-release'), 'PRETTY_NAME="Host OS 1"\n');
    writeFileSync(join(dir, 'host/model'), 'Host Pi\0');
    const server = await start({ PIPULSE_HOST_ROOT: join(dir, 'host') }, (config) => config, {
      plugins: fakePlugins()
    });
    const { port } = server.address();
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()) as {
      device: { os: string; model: string; hostname: string };
    };
    expect(body.device).toMatchObject({ os: 'Host OS 1', model: 'Host Pi' });
    expect(body.device.hostname).not.toBe('');
  });

  it('reads the device without a host root too', async () => {
    const server = await start({}, (config) => config, { plugins: fakePlugins() });
    const { port } = server.address();
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()) as {
      device: { platform: string };
    };
    expect(body.device.platform).toBe(process.platform);
  });

  it('runs the built-in plugins when it is given none', async () => {
    const server = await start({}, (config) => config, { device });
    const { port } = server.address();
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()) as {
      plugins: Array<{ id: string }>;
    };
    expect(body.plugins.map((p) => p.id)).toEqual(builtinPlugins.map((p) => p.id));
  });

  it('sends Strict-Transport-Security when HSTS is on over HTTPS', async () => {
    const server = await start(httpsSettings({ PIPULSE_TLS_HSTS: '2d' }));
    const { headers } = await peer(server.address().port);
    expect(headers['strict-transport-security']).toContain('max-age=172800');
  });

  it('does not, without it', async () => {
    const server = await start(httpsSettings());
    const { headers } = await peer(server.address().port);
    expect(headers['strict-transport-security']).toBeUndefined();
  });
});

describe('the webhook file', () => {
  const file = (mode: number) => {
    const path = join(dir, 'notify.json');
    writeFileSync(
      path,
      JSON.stringify({ webhooks: [{ id: 'hook', url: 'http://hook.example:9999/x' }] })
    );
    chmodSync(path, mode);
    return path;
  };

  it('starts a delivery loop for each webhook', async () => {
    await start({ PIPULSE_NOTIFY_FILE: file(0o600) });
    const [, options] = lastCall(startNotifications);
    expect(options.webhooks.map((hook) => hook.id)).toEqual(['hook']);
    expect(printed(warn)).not.toContain('readable by other users');
  });

  it('warns when the file is readable by other users', async () => {
    await start({ PIPULSE_NOTIFY_FILE: file(0o644) });
    expect(printed(warn)).toContain(
      '[pipulse] PIPULSE_NOTIFY_FILE is readable by other users; chmod o-r it'
    );
  });

  it('has none without a file', async () => {
    await start();
    expect(lastCall(startNotifications)[1].webhooks).toEqual([]);
  });

  it('logs what notifications report', async () => {
    await start();
    lastCall(startNotifications)[1].log?.('delivery failed');
    expect(printed(warn)).toContain('[pipulse] delivery failed');
  });
});

describe('the callbacks it wires between the parts', () => {
  it('logs retention problems and saved-rule problems with the [pipulse] prefix', async () => {
    await start();
    lastCall(retentionSource)[2]?.('retention note');
    lastCall(createRuleSource)[1].onProblem?.('rule note');
    expect(printed(warn)).toContain('[pipulse] retention note');
    expect(printed(warn)).toContain('[pipulse] rule note');
  });

  it('gives the rules the raw retention in force, as milliseconds and text', async () => {
    await start({ PIPULSE_RETENTION_RAW: '3d' });
    const raw = lastCall(createRuleSource)[1].rawRetention();
    expect(raw).toEqual({ ms: 3 * 86_400_000, text: '3d' });
  });

  it('turns certificate rules on only with HTTPS', async () => {
    await start();
    expect(lastCall(createRuleSource)[1].certificate).toBe(false);
    await start(httpsSettings(), (config) => ({
      ...config,
      dbPath: join(dir, 'q.sqlite')
    }));
    expect(lastCall(createRuleSource)[1].certificate).toBe(true);
  });

  it('prints a vacuum, a skipped vacuum and a housekeeping failure', async () => {
    await start();
    const options = lastCall(startHousekeeping)[1];
    options.vacuum?.onVacuum?.({
      ran: true,
      beforeBytes: 21_600_000,
      afterBytes: 4_000_000,
      ms: 1200
    } as never);
    options.vacuum?.onVacuum?.({ ran: false, reason: 'too small' } as never);
    const failure = new Error('disk full');
    options.onError?.(failure);
    expect(printed(log)).toContain('[pipulse] vacuum: 21.6 MB → 4.0 MB in 1.2 s');
    expect(printed(log)).toContain('[pipulse] vacuum skipped: too small');
    expect(error).toHaveBeenCalledWith('[pipulse] housekeeping failed:', failure);
  });

  it('names the plugin whose read failed', async () => {
    await start({}, (config) => config, {
      plugins: fakePlugins(async () => {
        throw new Error('sensor gone');
      }),
      device
    });
    await vi.waitFor(() => expect(printed(error)).toContain('[pipulse] cpu_load failed:'));
  });

  it('prints alert notices and failures, with the rule when there is one', async () => {
    await start();
    const options = lastCall(startAlerts)[1];
    options.onNotice?.('alert note');
    options.onError?.(new Error('boom'), { id: 'cpu_busy' } as never);
    options.onError?.(new Error('boom'));
    expect(printed(warn)).toContain('[pipulse] alert note');
    expect(error).toHaveBeenCalledWith('[pipulse] alert rule cpu_busy failed:', expect.any(Error));
    expect(error).toHaveBeenCalledWith('[pipulse] alert check failed:', expect.any(Error));
  });

  it('queues a notification for each alert change', async () => {
    await start();
    const [, hooks] = lastCall(startAlerts);
    const notifications = vi.mocked(startNotifications).mock.results.at(-1)!.value as {
      enqueue(event: unknown): void;
    };
    const enqueue = vi.spyOn(notifications, 'enqueue').mockImplementation(() => {});
    const event = { type: 'raised' };
    hooks.onChange?.(event as never);
    expect(enqueue).toHaveBeenCalledWith(event);
  });

  it('gives the alert engine the certificate context, empty over HTTP', async () => {
    await start();
    expect(lastCall(startAlerts)[1].context?.()).toEqual({});
  });

  it("reaches the alert engine's recheck through the rules editor's hook", async () => {
    await start();
    const options = lastCall(buildServer)[1];
    const alerts = vi.mocked(startAlerts).mock.results.at(-1)!.value as { check(): void };
    const check = vi.spyOn(alerts, 'check').mockImplementation(() => {});
    options.alertRules?.recheck?.();
    expect(check).toHaveBeenCalledOnce();
  });

  it('tells the settings page how much raw history the rules in force need', async () => {
    await start();
    const options = lastCall(buildServer)[1];
    expect(options.settings?.rawAtLeast()).toMatchObject({ ms: expect.any(Number) });
  });

  it('prints a failed updates check on one line', async () => {
    await start();
    lastCall(createUpdates)[0].onError?.(new Error('first line\nsecond line'));
    expect(error).toHaveBeenCalledWith('updates check failed: first line');
  });

  it("shows a generated certificate's extras in the TLS view", async () => {
    await start({}, (config) => ({
      ...config,
      tls: {
        ...config.tls,
        source: { kind: 'generated', bundlePath: '/x/leaf.pem', caPath: '/x/ca.crt' } as never
      }
    }));
    const view = lastCall(buildServer)[1].tls?.() as { metadataProblems?: unknown };
    expect(view).toBeDefined();
  });
});

describe('the certificate reloader it starts', () => {
  it('replaces the served certificate, logs, and republishes the runtime status', async () => {
    const server = await start(httpsSettings());
    const { port } = server.address();
    const before = (await peer(port)).fingerprint;

    const [options] = lastCall(startCertificateReloader);
    writeFileSync(join(dir, 'cert2.pem'), fixture('leaf2.crt') + fixture('intermediate.crt'));
    writeFileSync(join(dir, 'key2.pem'), fixture('leaf2.key'), { mode: 0o600 });
    const next = loadServingCertificate({
      ...options.tls,
      source: {
        ...options.tls.source!,
        certPath: join(dir, 'cert2.pem'),
        keyPath: join(dir, 'key2.pem')
      } as never
    })!;
    options.apply(next);
    options.log('reloaded');
    const publish = vi.mocked(createRuntimeStatus).mock.results.at(-1)!.value as {
      publish(): void;
    };
    const published = vi.spyOn(publish, 'publish');
    options.onChange();

    expect((await peer(port)).fingerprint).not.toBe(before);
    expect(printed(warn)).toContain('[pipulse] reloaded');
    expect(published).toHaveBeenCalled();
  });

  it('is not started over plain HTTP', async () => {
    const calls = vi.mocked(startCertificateReloader).mock.calls.length;
    await start();
    expect(vi.mocked(startCertificateReloader).mock.calls.length).toBe(calls);
  });

  it('tells the runtime status what the provider says', async () => {
    await start(httpsSettings());
    const [options] = lastCall(createRuntimeStatus);
    expect(options.provider()?.current().source).toBe('operator');
    options.warn('status note');
    expect(printed(warn)).toContain('[pipulse] status note');
  });
});

describe('what each part is told about the plugins', () => {
  const idsAndIntervals = (list: Array<{ id: string; intervalMs: number }>) =>
    list.map(({ id, intervalMs }) => ({ id, intervalMs }));

  it('gives the rules and the engine the metrics of the plugins, the engine only the running ones', async () => {
    const plugins = fakePlugins();
    await start({}, (config) => ({ ...config, inContainer: true }), { plugins, device });
    const running = plugins.filter((p) => p.id !== 'cpu_voltage' && p.id !== 'throttled');
    expect(lastCall(createRuleSource)[1].metrics).toEqual(idsAndIntervals(plugins));
    expect(lastCall(startAlerts)[1].metrics).toEqual(idsAndIntervals(running));
  });

  it('gives notifications a label and unit for each plugin and for the certificate', async () => {
    const plugins = fakePlugins();
    await start({}, (config) => config, { plugins, device });
    expect(lastCall(startNotifications)[1].metrics).toEqual([
      ...plugins.map(({ id, label, unit }) => ({ id, label, unit })),
      { id: 'certificate', label: 'HTTPS certificate', unit: '' }
    ]);
    expect(lastCall(startNotifications)[1].hostname).toBeTruthy();
  });

  it('asks the health check to track readings and alert checks', async () => {
    await start();
    expect(lastCall(createHealth)[1]).toEqual({ trackReadings: true, trackAlertChecks: true });
  });
});

describe('what the server is built with', () => {
  it('passes the sign-in settings through, with the hash only when there is one', async () => {
    await start();
    expect(lastCall(buildServer)[1].auth).toEqual({ protectReads: false });
    await start({}, (config) => ({
      ...config,
      dbPath: join(dir, 'q.sqlite'),
      auth: { passwordHash: 'scrypt$x', protectReads: true } as PiPulseConfig['auth']
    }));
    expect(lastCall(buildServer)[1].auth).toEqual({ passwordHash: 'scrypt$x', protectReads: true });
  });

  it('has an HSTS setting only when HSTS is on', async () => {
    await start();
    expect(lastCall(buildServer)[1]).not.toHaveProperty('hstsSeconds');
    await start(httpsSettings({ PIPULSE_TLS_HSTS: '1d' }), (config) => ({
      ...config,
      dbPath: join(dir, 'q.sqlite')
    }));
    expect(lastCall(buildServer)[1].hstsSeconds).toBe(86_400);
  });

  it("reads a generated certificate's files for the TLS view, and no other kind's", async () => {
    await start({}, (config) => ({
      ...config,
      tls: {
        ...config.tls,
        source: { kind: 'generated', bundlePath: '/x/leaf.pem', caPath: '/x/ca.crt' } as never
      }
    }));
    expect(vi.mocked(startCertificateReloader)).not.toHaveBeenCalled(); // no certificate is served
    vi.mocked(readGeneratedExtras).mockClear();
    lastCall(buildServer)[1].tls?.();
    expect(readGeneratedExtras).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readGeneratedExtras).mock.calls[0]![0]).toBe(join(dir, 'tls'));

    await start({}, (config) => ({ ...config, dbPath: join(dir, 'q.sqlite') }));
    vi.mocked(readGeneratedExtras).mockClear();
    lastCall(buildServer)[1].tls?.();
    expect(readGeneratedExtras).not.toHaveBeenCalled();
  });

  it('does not keep a certificate reloader for a server that serves none', async () => {
    vi.mocked(startCertificateReloader).mockClear();
    await start();
    expect(startCertificateReloader).not.toHaveBeenCalled();
  });
});

describe('the callbacks, called with what they receive', () => {
  it('publishes a sample to the live feed and marks a reading', async () => {
    await start();
    const live = lastCall(buildServer)[1].live!;
    const health = vi.mocked(createHealth).mock.results.at(-1)!.value as { markReading(): void };
    const marked = vi.spyOn(health, 'markReading');
    const received: unknown[] = [];
    live.subscribe((sample) => received.push(sample));
    const sample = { ts: 1, metric: 'cpu_load', value: 2 };
    lastCall(startScheduler)[2]?.onSample?.(sample);
    expect(received).toEqual([sample]);
    expect(marked).toHaveBeenCalled();
  });

  it('marks an alert check, and publishes an alert change to the alert feed', async () => {
    await start();
    const health = vi.mocked(createHealth).mock.results.at(-1)!.value as {
      markAlertCheck(): void;
    };
    const marked = vi.spyOn(health, 'markAlertCheck');
    const options = lastCall(startAlerts)[1];
    options.onCheck?.();
    expect(marked).toHaveBeenCalled();

    const feed = lastCall(buildServer)[1].alertFeed!;
    const received: unknown[] = [];
    feed.subscribe((event) => received.push(event));
    const notifications = vi.mocked(startNotifications).mock.results.at(-1)!.value as {
      enqueue(event: unknown): void;
    };
    vi.spyOn(notifications, 'enqueue').mockImplementation(() => {});
    const event = { type: 'raised' };
    options.onChange?.(event as never);
    expect(received).toEqual([event]);
  });

  it('hands the housekeeping job the retention in force, in milliseconds', async () => {
    await start({ PIPULSE_RETENTION_RAW: '3d' });
    expect(lastCall(startHousekeeping)[1].retention()).toMatchObject({ raw: 3 * 86_400_000 });
  });

  it('gives the alert engine the certificate context over HTTPS', async () => {
    await start(httpsSettings());
    expect(lastCall(startAlerts)[1].context?.()).toMatchObject({
      certificate: { notAfter: expect.any(Number), clockSynced: true }
    });
  });

  it('starts the updates check once it listens', async () => {
    const started: Array<ReturnType<typeof vi.spyOn>> = [];
    vi.mocked(createUpdates).mockImplementationOnce((options) => {
      const updates = realUpdates.createUpdates(options);
      started.push(vi.spyOn(updates, 'start').mockImplementation(() => {}));
      return updates;
    });
    await start();
    expect(started[0]).toHaveBeenCalledTimes(1);
  });
});

describe('what is written and printed after it listens', () => {
  beforeEach(() => {
    vi.mocked(processIdentity).mockReturnValue({ startTime: '1', bootId: 'b' });
  });

  it('writes the runtime status file, on any platform', async () => {
    mkdirSync(join(dir, 'run'));
    await start();
    expect(existsSync(join(dir, 'run', 'tls-status.json'))).toBe(true);
  });

  it('writes the data-folder marker only for HTTPS, and says nothing when that works', async () => {
    await start();
    expect(existsSync(join(dir, 'tls-installed'))).toBe(false);
    await start(httpsSettings(), (config) => ({ ...config, dbPath: join(dir, 'q.sqlite') }));
    expect(existsSync(join(dir, 'tls-installed'))).toBe(true);
    expect(printed(error)).not.toContain('[pipulse] ERROR:');
  });

  it('prints the certificate, its end date and fingerprint when it serves HTTPS', async () => {
    const server = await start(httpsSettings());
    const { port } = server.address();
    const cert = loadServingCertificate(lastCall(startCertificateReloader)[0].tls)!;
    expect(printed(log)).toContain(
      `listening on https://127.0.0.1:${port} (certificate: operator, valid until ${new Date(cert.notAfter).toISOString().slice(0, 10)}, SHA-256 ${cert.fingerprint})`
    );
  });

  it('ends the line there when there is nothing more to say', async () => {
    await start({}, (config) => ({
      ...config,
      auth: { passwordHash: 'scrypt$x', protectReads: false } as PiPulseConfig['auth']
    }));
    const line = log.mock.calls.flat().find((text) => String(text).includes('listening on'))!;
    expect(String(line)).toMatch(/\(HTTPS off: PIPULSE_TLS=off\)$/);
  });

  it('says nothing about "HTTPS is ready" unless the state file says HTTPS is prepared', async () => {
    const ready = '[pipulse] HTTPS is ready';
    await start({}, (config) => ({
      ...config,
      tls: { ...config.tls, modeReason: 'env', stateMode: 'legacy-http' }
    }));
    expect(printed(log)).not.toContain(ready);
    await start({}, (config) => ({
      ...config,
      dbPath: join(dir, 'q.sqlite'),
      tls: { ...config.tls, modeReason: 'state', stateMode: 'https' }
    }));
    expect(printed(log)).not.toContain(ready);
    await start({}, (config) => ({
      ...config,
      dbPath: join(dir, 'r.sqlite'),
      tls: { ...config.tls, modeReason: 'state', stateMode: undefined }
    }));
    expect(printed(log)).not.toContain(ready);
  });

  it('says nothing about "HTTPS is ready" when HTTPS is on', async () => {
    await start(httpsSettings(), (config) => ({
      ...config,
      tls: { ...config.tls, modeReason: 'state', stateMode: 'legacy-http' }
    }));
    expect(printed(log)).not.toContain('[pipulse] HTTPS is ready');
  });

  it('does not warn about Node when its line is supported', async () => {
    await start();
    expect(printed(warn)).not.toContain('no longer gets security fixes');
  });

  it('does not warn about unencrypted sign-in over HTTPS', async () => {
    await start(httpsSettings(), (config) => ({
      ...config,
      auth: { passwordHash: 'scrypt$x', protectReads: false } as PiPulseConfig['auth']
    }));
    expect(printed(warn)).not.toContain('sign-in is on but HTTPS is off');
  });
});

describe('the certificate reloader, what it is given', () => {
  it('keeps the TLS floor when it replaces the context', async () => {
    const server = await start(httpsSettings());
    const [options] = lastCall(startCertificateReloader);
    const setSecureContext = vi
      .spyOn(
        server.app.server as unknown as { setSecureContext(o: unknown): void },
        'setSecureContext'
      )
      .mockImplementation(() => {});
    const cert = loadServingCertificate(options.tls)!;
    options.apply(cert);
    expect(setSecureContext).toHaveBeenCalledWith({
      key: cert.key,
      cert: cert.cert,
      minVersion: 'TLSv1.2'
    });
  });
});
