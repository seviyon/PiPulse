import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { paths, readMeta, readState, writeRenewStatus } from '../src/layout.js';
import { sidecar, sidecarHealth, sidecarStart } from '../src/sidecar.js';
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
  it('is unhealthy before ready, healthy after, unhealthy when renewal failed', async () => {
    const ctx = docker();
    expect(sidecarHealth(ctx, ready)).toBe(1);
    await sidecarStart(ctx, ready);
    expect(sidecarHealth(ctx, ready)).toBe(0);
    writeRenewStatus(ctx.layout, {
      version: 1,
      lastAttempt: ctx.now(),
      result: 'waiting-clock',
      reason: 'clock unknown'
    });
    expect(sidecarHealth(ctx, ready)).toBe(0);
    writeRenewStatus(ctx.layout, {
      version: 1,
      lastAttempt: ctx.now(),
      result: 'failed',
      reason: 'x'
    });
    expect(sidecarHealth(ctx, ready)).toBe(1);
  });

  it('is unhealthy once the leaf has expired', async () => {
    const ctx = docker();
    await sidecarStart(ctx, ready);
    ctx.setNow(ctx.now() + 100 * 86_400_000);
    expect(sidecarHealth(ctx, ready)).toBe(1);
  });
});

describe('sidecar loop', () => {
  it('starts, renews once, and stops when told to', async () => {
    const ctx = docker();
    const stop = new AbortController();
    const running = sidecar(ctx, [], { readyFile: ready, intervalMs: 50, stop: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 200));
    stop.abort();
    expect(await running).toBe(0);
    expect(existsSync(paths(ctx.layout).renewStatus)).toBe(true);
  });
});
