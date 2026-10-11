import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { paths, readMeta, readState, writeRenewStatus } from '../src/layout.js';
import { sidecar, sidecarHealth, sidecarInit, sidecarStart } from '../src/sidecar.js';
import { withLock } from '../src/lock.js';
import { testContext, type TestContext } from './cli-context.js';
import { tempDir } from './helpers.js';

let dir: string;
let ready: string;
const docker = (overrides = {}): TestContext => {
  const ctx = testContext(join(dir, 'tls'), { inContainer: true, ...overrides });
  ctx.layout = { ...ctx.layout, caRoot: join(dir, 'tls-ca') };
  ctx.env['PIPULSE_DB_PATH'] = join(dir, 'data', 'pipulse.sqlite');
  return ctx;
};
/** Resolves once the context has printed a line matching `pattern` (output or error). */
const printed = (ctx: TestContext, pattern: RegExp) =>
  new Promise<void>((resolve) => {
    const { out, err } = ctx;
    ctx.out = (line) => {
      out(line);
      if (pattern.test(line)) resolve();
    };
    ctx.err = (line) => {
      err(line);
      if (pattern.test(line)) resolve();
    };
  });
beforeEach(() => {
  dir = tempDir();
  for (const d of ['tls', 'tls-ca', 'data']) mkdirSync(join(dir, d));
  ready = join(dir, 'ready');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('sidecarStart', () => {
  it('first start: CA in the CA volume only, leaf and https state in /tls, then ready', async () => {
    const ctx = docker();
    expect(await sidecarStart(ctx, ready)).toBe(0);
    expect(existsSync(join(dir, 'tls-ca', 'ca', 'ca.key'))).toBe(true);
    expect(readdirSync(join(dir, 'tls'))).not.toContain('ca');
    expect(readState(ctx.layout)).toBe('https');
    expect(existsSync(ready)).toBe(true);
    expect(ctx.lines.filter((l) => l.startsWith('CA SHA-256 fingerprint:'))).toHaveLength(1);
  });

  it('prints the same CA facts on every start', async () => {
    const first = docker();
    await sidecarStart(first, ready);
    const second = docker();
    await sidecarStart(second, ready);
    const facts = (c: TestContext) =>
      c.lines.filter((l) => /^CA SHA-256|^ {2}PiPulse CA|^ {2}(DNS|IP):/.test(l));
    expect(facts(second)).toEqual(facts(first));
  });

  it('existing data without the marker is an upgrade (legacy-http); with it, https', async () => {
    writeFileSync(join(dir, 'data', 'pipulse.sqlite'), '');
    const ctx = docker();
    await sidecarStart(ctx, ready);
    expect(readState(ctx.layout)).toBe('legacy-http');
    expect(ctx.lines.join('\n')).toContain(
      'docker compose run --rm pipulse-tls pipulse tls enable --yes'
    );
    rmSync(join(dir, 'tls', 'state.json'));
    writeFileSync(join(dir, 'data', 'tls-installed'), '');
    await sidecarStart(docker(), ready);
    expect(readState(ctx.layout)).toBe('https');
  });

  it('takes subnets from PIPULSE_TLS_SUBNETS only (never inferred)', async () => {
    const ctx = docker();
    ctx.env['PIPULSE_TLS_SUBNETS'] = '192.168.1.0/24';
    await sidecarStart(ctx, ready);
    expect(readMeta(ctx.layout)!.constraints.subnets).toEqual(['192.168.1.0/24']);
  });

  it('is not ready when it can’t issue (clock unsynced)', async () => {
    const ctx = docker({ clock: () => ({ state: 'unsynced', synced: false }) });
    expect(await sidecarStart(ctx, ready)).toBe(1);
    expect(existsSync(ready)).toBe(false);
  });

  it('an operator certificate: no CA is made, and it is ready and healthy', async () => {
    const ctx = docker();
    ctx.env['PIPULSE_TLS_CERT'] = '/etc/pipulse/cert.pem';
    ctx.env['PIPULSE_TLS_KEY'] = '/etc/pipulse/key.pem';
    expect(await sidecarStart(ctx, ready)).toBe(0);
    expect(existsSync(paths(ctx.layout).caDir)).toBe(false);
    expect(existsSync(ready)).toBe(true);
    // The server, not the sidecar, loads that pair: no ca.crt exists and none is needed.
    expect(sidecarHealth(ctx, ready)).toBe(0);
  });

  it('an incomplete CA never keeps a servable install from starting', async () => {
    const first = docker();
    await sidecarStart(first, ready);
    rmSync(paths(first.layout).caConstraints);
    const ctx = docker();
    expect(await sidecarStart(ctx, ready)).toBe(0);
    expect(ctx.errors.join('\n')).toContain('the CA is incomplete');
    expect(ctx.errors.join('\n')).toContain('starts with what is already in /tls');
    expect(existsSync(ready)).toBe(true);
    expect(sidecarHealth(ctx, ready)).toBe(0);
  });

  it('a failed start with nothing to serve stays unready', async () => {
    const first = docker();
    await sidecarStart(first, ready);
    rmSync(paths(first.layout).caConstraints);
    rmSync(paths(first.layout).bundle);
    expect(await sidecarStart(docker(), ready)).toBe(1);
    expect(existsSync(ready)).toBe(false);
  });

  it('an unreadable marker counts as served over HTTPS, never as a reason to fall back to HTTP', async () => {
    // A path below a regular file fails with ENOTDIR, not ENOENT: the marker can't be told apart
    // from "present", and so can't the database.
    writeFileSync(join(dir, 'notadir'), '');
    const ctx = docker();
    ctx.env['PIPULSE_DB_PATH'] = join(dir, 'notadir', 'pipulse.sqlite');
    expect(await sidecarStart(ctx, ready)).toBe(0);
    expect(readState(ctx.layout)).toBe('https');
  });

  it('existing data stays on HTTP and the server starts even when the CA can’t be made', async () => {
    writeFileSync(join(dir, 'data', 'pipulse.sqlite'), '');
    const ctx = docker({ clock: () => ({ state: 'unsynced', synced: false }) });
    expect(await sidecarStart(ctx, ready)).toBe(0);
    expect(readState(ctx.layout)).toBe('legacy-http');
    expect(existsSync(ready)).toBe(true);
    expect(sidecarHealth(ctx, ready)).toBe(0);
  });

  it('new-ca works across the two volumes', async () => {
    const ctx = docker();
    await sidecarStart(ctx, ready);
    const before = readMeta(ctx.layout)!.fingerprint;
    const run = docker();
    run.setNow(run.now() + 5000);
    expect(await main(['new-ca', '--yes'], run)).toBe(0);
    expect(readMeta(ctx.layout)!.fingerprint).not.toBe(before);
    expect(readdirSync(join(dir, 'tls-ca')).some((n) => n.startsWith('ca.old-'))).toBe(true);
  });
});

describe('sidecarHealth', () => {
  it('is unhealthy before ready and healthy after, whatever the last renewal did', async () => {
    const ctx = docker();
    expect(sidecarHealth(ctx, ready)).toBe(1);
    await sidecarStart(ctx, ready);
    expect(sidecarHealth(ctx, ready)).toBe(0);
    for (const result of ['waiting-clock', 'failed'] as const) {
      writeRenewStatus(ctx.layout, {
        version: 1,
        lastAttempt: ctx.now(),
        result,
        reason: 'x'
      });
      // A failed renewal must never keep the server from starting (depends_on: service_healthy).
      expect(sidecarHealth(ctx, ready)).toBe(0);
    }
  });

  it('stays healthy once the leaf has expired (it is a certificate problem, not readiness)', async () => {
    const ctx = docker();
    await sidecarStart(ctx, ready);
    ctx.setNow(ctx.now() + 100 * 86_400_000);
    expect(sidecarHealth(ctx, ready)).toBe(0);
  });

  it('does not look at the CA key, and is unhealthy when the leaf or the public CA is gone', async () => {
    const ctx = docker();
    await sidecarStart(ctx, ready);
    rmSync(paths(ctx.layout).caDir, { recursive: true });
    expect(sidecarHealth(ctx, ready)).toBe(0);
    rmSync(paths(ctx.layout).publicCa);
    expect(sidecarHealth(ctx, ready)).toBe(1);
  });

  it('plain HTTP needs no certificate: healthy even with the leaf gone', async () => {
    writeFileSync(join(dir, 'data', 'pipulse.sqlite'), '');
    const ctx = docker();
    await sidecarStart(ctx, ready);
    expect(readState(ctx.layout)).toBe('legacy-http');
    rmSync(paths(ctx.layout).bundle);
    expect(sidecarHealth(ctx, ready)).toBe(0);
  });

  it('is unhealthy when the leaf is gone', async () => {
    const ctx = docker();
    await sidecarStart(ctx, ready);
    rmSync(paths(ctx.layout).bundle);
    expect(sidecarHealth(ctx, ready)).toBe(1);
  });
});

describe('PIPULSE_TLS=off', () => {
  it('makes no CA, records legacy-http on a fresh volume and is ready and healthy', async () => {
    const ctx = docker();
    ctx.env['PIPULSE_TLS'] = 'off';
    expect(await sidecarStart(ctx, ready)).toBe(0);
    expect(readState(ctx.layout)).toBe('legacy-http');
    expect(existsSync(join(dir, 'tls-ca', 'ca'))).toBe(false);
    expect(existsSync(paths(ctx.layout).bundle)).toBe(false);
    expect(existsSync(ready)).toBe(true);
    expect(sidecarHealth(ctx, ready)).toBe(0);
  });

  it('the loop idles without renewing and stops when told to', async () => {
    const ctx = docker();
    ctx.env['PIPULSE_TLS'] = 'off';
    const stop = new AbortController();
    const idle = printed(ctx, /nothing to renew/);
    const running = sidecar(ctx, [], { readyFile: ready, intervalMs: 20, stop: stop.signal });
    await idle;
    stop.abort();
    expect(await running).toBe(0);
    expect(existsSync(paths(ctx.layout).renewStatus)).toBe(false);
  });
});

describe('sidecar loop', () => {
  it('starts, renews once, and stops when told to', async () => {
    const ctx = docker();
    const stop = new AbortController();
    // renew records its result, then prints it: the first "not due" is after the first renewal.
    const renewed = printed(ctx, /^not due/);
    const running = sidecar(ctx, [], { readyFile: ready, intervalMs: 50, stop: stop.signal });
    await renewed;
    stop.abort();
    expect(await running).toBe(0);
    expect(existsSync(paths(ctx.layout).renewStatus)).toBe(true);
  });
});

describe('sidecarInit', () => {
  it('makes both volumes with their modes and says so', () => {
    const ctx = docker();
    expect(sidecarInit(ctx)).toBe(0);
    expect(existsSync(join(dir, 'tls'))).toBe(true);
    expect(existsSync(join(dir, 'tls-ca'))).toBe(true);
    expect(ctx.lines.join('\n')).toMatch(/is root:pipulse 2750 and .* root 0700/);
  });
});

describe('a start that cannot prepare the material', () => {
  /** Another command (a `new-ca` run through compose) holds the TLS lock until released. */
  const holdLock = async (ctx: TestContext) => {
    let release!: () => void;
    let acquired!: () => void;
    const got = new Promise<void>((resolve) => (acquired = resolve));
    const held = withLock(
      ctx.layout,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          acquired();
        }),
      { create: true, waitMs: 0, now: ctx.now, sleep: ctx.sleep, alive: () => true }
    );
    await got;
    return async () => {
      release();
      await held;
    };
  };

  it('a held lock never keeps a servable install from starting, and says why', async () => {
    await sidecarStart(docker(), ready);
    const unlock = await holdLock(docker());
    try {
      const ctx = docker({ lockAlive: () => true });
      expect(await sidecarStart(ctx, ready)).toBe(0);
      expect(ctx.errors.join('\n')).toMatch(
        /the HTTPS material was not prepared: .*another pipulse tls command is running/
      );
      expect(ctx.errors.join('\n')).toContain('starts with what is already in /tls');
      expect(existsSync(ready)).toBe(true);
      expect(sidecarHealth(ctx, ready)).toBe(0);
    } finally {
      await unlock();
    }
  });

  it('still starts when the CA facts cannot be shown while degraded', async () => {
    const first = docker();
    await sidecarStart(first, ready);
    rmSync(paths(first.layout).caConstraints); // init refuses an incomplete CA...
    writeFileSync(paths(first.layout).meta, 'not json'); // ...and the facts can't be read
    const ctx = docker();
    expect(await sidecarStart(ctx, ready)).toBe(0);
    expect(ctx.errors.join('\n')).toMatch(/the CA facts can't be shown: /);
    expect(existsSync(ready)).toBe(true);
  });

  it('with an unreadable state.json and a held lock there is nothing it can vouch for', async () => {
    await sidecarStart(docker(), ready);
    writeFileSync(join(dir, 'tls', 'state.json'), 'not json');
    const unlock = await holdLock(docker());
    try {
      const ctx = docker({ lockAlive: () => true });
      expect(await sidecarStart(ctx, ready)).toBe(1);
      expect(existsSync(ready)).toBe(false);
    } finally {
      await unlock();
    }
  });

  it('the loop says the server will not start, and returns the code, when nothing is servable', async () => {
    const unlock = await holdLock(docker());
    try {
      const ctx = docker({ lockAlive: () => true });
      expect(await sidecar(ctx, [], { readyFile: ready, intervalMs: 50 })).toBe(1);
      expect(ctx.errors.join('\n')).toContain(
        'pipulse-tls is not ready; the server will not start until this is fixed'
      );
      expect(existsSync(ready)).toBe(false);
    } finally {
      await unlock();
    }
  });
});

describe('a renewal round that cannot take the lock', () => {
  it('is logged and skipped, and the loop keeps running until told to stop', async () => {
    const ctx = docker({ lockAlive: () => true });
    let release: (() => void) | undefined;
    let held: Promise<void> | undefined;
    // Once the start has printed its last line (its own lock is released), another command
    // takes the lock, as a `docker compose run ... new-ca` would.
    const { out } = ctx;
    ctx.out = (line) => {
      out(line);
      if (line.startsWith('clock:')) {
        held = withLock(ctx.layout, () => new Promise<void>((resolve) => (release = resolve)), {
          create: true,
          waitMs: 0,
          now: ctx.now,
          sleep: ctx.sleep,
          alive: () => true
        });
      }
    };
    const skipped = printed(ctx, /renewal skipped this round/);
    const stop = new AbortController();
    const running = sidecar(ctx, [], { readyFile: ready, intervalMs: 20, stop: stop.signal });
    await skipped;
    stop.abort();
    expect(await running).toBe(0);
    expect(ctx.errors.join('\n')).toMatch(
      /renewal skipped this round: .*another pipulse tls command is running/
    );
    release?.();
    await held;
  });
});
