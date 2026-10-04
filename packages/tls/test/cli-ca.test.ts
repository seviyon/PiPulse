import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { listBackups, readMeta } from '../src/layout.js';
import { NOW, testContext, type TestContext } from './cli-context.js';
import { tempDir } from './helpers.js';

let dir: string;
let ctx: TestContext;
let tick = 0;
/** A context a few seconds later each time: backups are named by the second. */
const later = () => {
  const next = testContext(dir);
  next.setNow(NOW + ++tick * 5000);
  return next;
};
const fingerprint = () => readMeta(ctx.layout)!.fingerprint;

beforeEach(async () => {
  dir = tempDir();
  ctx = testContext(dir);
  tick = 0;
  expect(await main(['init'], ctx)).toBe(0);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a missing openssl', () => {
  it('stops new-ca and restore-ca by name, with the CA untouched', async () => {
    const before = fingerprint();
    const broken = testContext(dir, { openssl: '/nonexistent/openssl' });
    broken.setNow(NOW + 99_000);
    expect(await main(['new-ca', '--yes'], broken)).toBe(1);
    expect(broken.errors.join('\n')).toMatch(/openssl not found/);
    expect(fingerprint()).toBe(before);
    expect(listBackups(ctx.layout)).toEqual([]);
  });
});

describe('new-ca', () => {
  it('needs --yes or a terminal, and changes nothing without it', async () => {
    const before = fingerprint();
    const run = later();
    expect(await main(['new-ca', '--subnet', '192.168.1.0/24'], run)).toBe(2);
    expect(fingerprint()).toBe(before);
    expect(listBackups(ctx.layout)).toEqual([]);
  });

  it('shows old and new scope, replaces the CA and keeps the old one as a backup', async () => {
    const before = fingerprint();
    const run = later();
    expect(await main(['new-ca', '--subnet', '192.168.1.0/24', '--yes'], run)).toBe(0);
    const text = run.lines.join('\n');
    expect(text).toMatch(/Current CA scope:[\s\S]*IP: {2}127\.0\.0\.1\/32, ::1\/128\n/);
    expect(text).toContain('Accepting 192.168.1.0/24');
    expect(text).toContain('must trust the new one');
    expect(fingerprint()).not.toBe(before);
    expect(listBackups(ctx.layout).map((b) => b.fingerprint)).toEqual([before]);
    expect(readMeta(ctx.layout)!.backups.map((b) => b.fingerprint)).toEqual([before]);
  });

  it('keeps at most two backups: a third change needs --prune-oldest naming the oldest', async () => {
    await main(['new-ca', '--yes'], later());
    await main(['new-ca', '--yes'], later());
    const [oldest, newer] = listBackups(ctx.layout);
    const refused = later();
    expect(await main(['new-ca', '--yes'], refused)).toBe(1);
    expect(refused.errors.join('\n')).toContain(`--prune-oldest ${oldest!.name}`);
    expect(await main(['new-ca', '--yes', '--prune-oldest', newer!.name], later())).toBe(1);
    expect(await main(['new-ca', '--yes', '--prune-oldest', oldest!.name], later())).toBe(0);
    const names = listBackups(ctx.layout).map((b) => b.name);
    expect(names).toHaveLength(2);
    expect(names).not.toContain(oldest!.name);
    expect(readMeta(ctx.layout)!.backups.map((b) => b.name)).toEqual(names);
    for (const backup of readMeta(ctx.layout)!.backups)
      expect(existsSync(join(dir, backup.name))).toBe(true);
  });

  it('after an interrupted prune (three backups) needs both of the oldest named', async () => {
    await main(['new-ca', '--yes'], later());
    await main(['new-ca', '--yes'], later());
    const [oldest, newer] = listBackups(ctx.layout);
    cpSync(join(dir, oldest!.name), join(dir, 'ca.old-20200101T000000Z'), { recursive: true });
    const three = listBackups(ctx.layout).map((b) => b.name);
    expect(three).toHaveLength(3);
    const refused = later();
    expect(
      await main(['new-ca', '--yes', '--prune-oldest', 'ca.old-20200101T000000Z'], refused)
    ).toBe(1);
    expect(refused.errors.join('\n')).toMatch(/exactly the oldest backups/);
    expect(
      await main(
        [
          'new-ca',
          '--yes',
          '--prune-oldest',
          'ca.old-20200101T000000Z',
          '--prune-oldest',
          oldest!.name
        ],
        later()
      )
    ).toBe(0);
    const names = listBackups(ctx.layout).map((b) => b.name);
    expect(names).toHaveLength(2);
    expect(names).toContain(newer!.name);
    expect(readMeta(ctx.layout)!.backups.map((b) => b.name)).toEqual(names);
  });

  it('keeps the current IP subnets on a routine rotation, and drops them only with --subnet none', async () => {
    const withSubnet = testContext(dir);
    await main(['new-ca', '--subnet', '192.168.1.0/24', '--yes'], withSubnet);
    withSubnet.setNow(NOW + 50_000);
    expect(readMeta(ctx.layout)!.constraints.subnets).toEqual(['192.168.1.0/24']);
    const routine = later();
    expect(await main(['new-ca', '--yes'], routine)).toBe(0);
    expect(routine.lines.join('\n')).toContain('Keeping the current IP scope (192.168.1.0/24)');
    expect(readMeta(ctx.layout)!.constraints.subnets).toEqual(['192.168.1.0/24']);
    const mixed = later();
    expect(
      await main(['new-ca', '--subnet', 'none', '--subnet', '10.0.0.0/24', '--yes'], mixed)
    ).toBe(2);
    const [oldest] = listBackups(ctx.layout); // two backups by now: the third change prunes one
    expect(
      await main(['new-ca', '--subnet', 'none', '--yes', '--prune-oldest', oldest!.name], later())
    ).toBe(0);
    expect(readMeta(ctx.layout)!.constraints.subnets).toEqual([]);
  });

  it('refuses a broad single-label --name, accepts a dotted alias', async () => {
    const before = fingerprint();
    const broad = later();
    expect(await main(['new-ca', '--name', 'com', '--yes'], broad)).toBe(1);
    expect(broad.errors.join('\n')).toMatch(/single-label name.*all of \*\.com/);
    expect(fingerprint()).toBe(before);
    expect(await main(['new-ca', '--name', 'pi.local', '--yes'], later())).toBe(0);
    expect(readMeta(ctx.layout)!.constraints.dns).toContain('pi.local');
  });

  it('refuses with an operator certificate configured', async () => {
    const run = later();
    run.env['PIPULSE_TLS_CERT'] = '/x/c';
    run.env['PIPULSE_TLS_KEY'] = '/x/k';
    expect(await main(['new-ca', '--yes'], run)).toBe(1);
  });
});

describe('the lock', () => {
  it('two pipulse tls commands never overlap: the second is refused while the first holds the lock', async () => {
    const first = main(['new-ca', '--yes'], later()); // takes the lock before its first await
    const second = later();
    expect(await main(['renew', '--force'], second)).toBe(1);
    expect(second.errors.join('\n')).toContain('another pipulse tls command is running');
    expect(await first).toBe(0);
    expect(await main(['renew', '--force'], later())).toBe(0);
    expect(existsSync(join(dir, '.pipulse-tls.lock'))).toBe(false);
  });
});

describe('restore-ca', () => {
  it('brings a backup back; the replaced CA becomes a backup and the restored folder goes', async () => {
    const first = fingerprint();
    await main(['new-ca', '--subnet', '192.168.1.0/24', '--yes'], later());
    const second = fingerprint();
    const [backup] = listBackups(ctx.layout);
    const run = later();
    expect(await main(['restore-ca', join(dir, backup!.name), '--yes'], run)).toBe(0);
    expect(fingerprint()).toBe(first);
    expect(existsSync(join(dir, backup!.name))).toBe(false);
    expect(listBackups(ctx.layout).map((b) => b.fingerprint)).toEqual([second]);
  });

  it('refuses a name that is not a backup, and a missing one', async () => {
    expect(await main(['restore-ca', '../etc', '--yes'], later())).toBe(2);
    expect(await main(['restore-ca', 'ca.old-20200101T000000Z', '--yes'], later())).toBe(1);
  });
});
