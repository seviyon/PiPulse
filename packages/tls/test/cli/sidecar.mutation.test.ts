import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, readState } from '../../src/ca/layout.js';
import { withLock } from '../../src/ca/lock.js';
import { UsageError } from '../../src/cli/cli-common.js';
import {
  SIDECAR_INTERVAL_MS,
  sidecar,
  sidecarHealth,
  sidecarStart
} from '../../src/cli/sidecar.js';
import { testContext, type TestContext } from '../cli-context.js';
import { tempDir } from '../helpers.js';

// Tests that pin the behaviour mutation testing showed was unchecked in sidecar.ts.

let dir: string;
let ready: string;
const docker = (overrides = {}): TestContext => {
  const ctx = testContext(join(dir, 'tls'), { inContainer: true, ...overrides });
  ctx.layout = { ...ctx.layout, caRoot: join(dir, 'tls-ca') };
  ctx.env['PIPULSE_DB_PATH'] = join(dir, 'data', 'pipulse.sqlite');
  return ctx;
};
/** Resolves once the context has printed `pattern` `count` times (output or error). */
const printed = (ctx: TestContext, pattern: RegExp, count = 1) =>
  new Promise<void>((resolve) => {
    let seen = 0;
    const { out, err } = ctx;
    const hit = (line: string) => {
      if (pattern.test(line) && ++seen === count) resolve();
    };
    ctx.out = (line) => {
      out(line);
      hit(line);
    };
    ctx.err = (line) => {
      err(line);
      hit(line);
    };
  });
/** Another command holds the TLS lock until the returned function is called. */
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
beforeEach(() => {
  dir = tempDir();
  for (const d of ['tls', 'tls-ca', 'data']) mkdirSync(join(dir, d));
  ready = join(dir, 'ready');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('the sidecar interval', () => {
  it('is six hours', () => {
    expect(SIDECAR_INTERVAL_MS).toBe(6 * 3_600_000);
  });
});

describe('the ready file', () => {
  it('holds the time it was written and is private, with TLS on and with it off', async () => {
    for (const off of [false, true]) {
      const ctx = docker();
      if (off) ctx.env['PIPULSE_TLS'] = 'off';
      expect(await sidecarStart(ctx, ready)).toBe(0);
      expect(readFileSync(ready, 'utf8')).toBe(`${ctx.now()}\n`);
      expect(statSync(ready).mode & 0o777).toBe(0o600);
      rmSync(ready);
      rmSync(dir, { recursive: true, force: true });
      dir = tempDir();
      for (const d of ['tls', 'tls-ca', 'data']) mkdirSync(join(dir, d));
      ready = join(dir, 'ready');
    }
  });
});

describe('PIPULSE_TLS=off', () => {
  it('says nothing about a skipped preparation when the preparation worked', async () => {
    const ctx = docker();
    ctx.env['PIPULSE_TLS'] = 'off';
    expect(await sidecarStart(ctx, ready)).toBe(0);
    expect(ctx.errors).toEqual([]);
    // Nothing was issued, so there are no CA facts or clock to report.
    expect(ctx.lines.filter((l) => /^CA SHA-256|^clock:/.test(l))).toEqual([]);
  });

  it('says it starts although the HTTPS material was not prepared, when init cannot take the lock', async () => {
    const unlock = await holdLock(docker());
    try {
      const ctx = docker({ lockAlive: () => true });
      ctx.env['PIPULSE_TLS'] = 'off';
      expect(await sidecarStart(ctx, ready)).toBe(0);
      expect(ctx.errors).toContain(
        'warning: PIPULSE_TLS=off, so the server starts although the HTTPS material was not prepared (see above)'
      );
    } finally {
      await unlock();
    }
  });
});

describe('a start that cannot prepare the material, on a plain-HTTP volume', () => {
  it('still starts, because plain HTTP needs nothing', async () => {
    const first = docker();
    first.env['PIPULSE_TLS'] = 'off';
    await sidecarStart(first, ready);
    expect(readState(first.layout)).toBe('legacy-http');
    const unlock = await holdLock(docker());
    try {
      const ctx = docker({ lockAlive: () => true });
      expect(await sidecarStart(ctx, ready)).toBe(0);
      expect(ctx.errors.join('\n')).toContain('starts with what is already in /tls');
      expect(existsSync(ready)).toBe(true);
    } finally {
      await unlock();
    }
  });
});

describe('a certificate problem that is not degraded stops the start', () => {
  it('lets an error from printing the CA facts through', async () => {
    const ctx = docker();
    const { out } = ctx;
    ctx.out = (line) => {
      if (line.startsWith('CA SHA-256 fingerprint:')) throw new Error('cannot print');
      out(line);
    };
    await expect(sidecarStart(ctx, ready)).rejects.toThrow('cannot print');
    expect(existsSync(ready)).toBe(false);
  });
});

describe('the clock line', () => {
  const line = async (trust: string | undefined) => {
    const ctx = docker();
    if (trust !== undefined) ctx.env['PIPULSE_TLS_CLOCK'] = trust;
    await sidecarStart(ctx, ready);
    return ctx.lines.find((l) => l.startsWith('clock:'));
  };

  it('says the state, and that it is trusted only when PIPULSE_TLS_CLOCK is trust', async () => {
    expect(await line(undefined)).toBe('clock: synced');
    expect(await line('trust')).toBe('clock: synced (PIPULSE_TLS_CLOCK=trust)');
    expect(await line('  trust  ')).toBe('clock: synced (PIPULSE_TLS_CLOCK=trust)');
    expect(await line('other')).toBe('clock: synced');
  });
});

describe('the renewal loop', () => {
  it('renews again after each interval and stops when told to', async () => {
    const ctx = docker();
    const stop = new AbortController();
    const twice = printed(ctx, /^not due/, 2);
    const running = sidecar(ctx, [], { readyFile: ready, intervalMs: 20, stop: stop.signal });
    await twice;
    stop.abort();
    expect(await running).toBe(0);
  });

  it('wakes at once when told to stop in the middle of a long wait, and cancels its timer', async () => {
    const real = globalThis.setTimeout;
    const made: unknown[] = [];
    const cleared: unknown[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const handle = real(fn, ms);
      if (ms === 600_000) made.push(handle);
      return handle;
    }) as typeof setTimeout);
    const realClear = globalThis.clearTimeout;
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: never) => {
      cleared.push(handle);
      realClear(handle);
    }) as typeof clearTimeout);
    const ctx = docker();
    const stop = new AbortController();
    const waiting = printed(ctx, /^not due/);
    const running = sidecar(ctx, [], { readyFile: ready, intervalMs: 600_000, stop: stop.signal });
    await waiting;
    // Let the loop reach its wait: aborting first would only exercise the already-aborted path.
    await vi.waitFor(() => expect(made).toHaveLength(1));
    stop.abort();
    expect(await running).toBe(0);
    expect(made).toHaveLength(1);
    expect(cleared).toContain(made[0]);
    // Stopped means stopped: no further renewal round after the signal.
    expect(ctx.lines.filter((l) => l.startsWith('not due'))).toHaveLength(1);
  });

  it('with a stop signal already given, renews once and returns', async () => {
    const stop = new AbortController();
    stop.abort();
    const ctx = docker();
    expect(
      await sidecar(ctx, [], { readyFile: ready, intervalMs: 600_000, stop: stop.signal })
    ).toBe(0);
    expect(ctx.lines.some((l) => l.startsWith('not due'))).toBe(true);
  });

  it('rejects an option it does not know before it starts anything', async () => {
    const stop = new AbortController();
    stop.abort();
    const ctx = docker();
    await expect(
      sidecar(ctx, ['--bogus'], { readyFile: ready, intervalMs: 20, stop: stop.signal })
    ).rejects.toBeInstanceOf(UsageError);
    expect(existsSync(ready)).toBe(false);
  });

  it('with TLS off, idles until told to stop instead of returning', async () => {
    const ctx = docker();
    ctx.env['PIPULSE_TLS'] = 'off';
    const stop = new AbortController();
    const idle = printed(ctx, /nothing to renew/);
    let finished = false;
    const running = sidecar(ctx, [], { readyFile: ready, intervalMs: 20, stop: stop.signal }).then(
      (code) => ((finished = true), code)
    );
    await idle;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(finished).toBe(false);
    stop.abort();
    expect(await running).toBe(0);
  });
});

describe('sidecarHealth says what is wrong', () => {
  it('is not ready without the ready file, whatever the material looks like', async () => {
    const ctx = docker();
    await sidecarStart(ctx, ready);
    rmSync(ready);
    const probe = docker();
    expect(sidecarHealth(probe, ready)).toBe(1);
    expect(probe.errors).toEqual(['not ready yet']);
  });

  it('names the missing CA certificate and the unusable leaf', async () => {
    const ctx = docker();
    await sidecarStart(ctx, ready);
    const noLeaf = docker();
    rmSync(paths(noLeaf.layout).bundle);
    expect(sidecarHealth(noLeaf, ready)).toBe(1);
    expect(noLeaf.errors).toEqual(['no usable certificate']);

    const noCa = docker();
    rmSync(paths(noCa.layout).publicCa);
    expect(sidecarHealth(noCa, ready)).toBe(1);
    expect(noCa.errors).toHaveLength(1);
    expect(noCa.errors[0]).toMatch(/^no CA certificate: /);
  });
});
