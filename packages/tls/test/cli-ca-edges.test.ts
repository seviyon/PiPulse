import { cpSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { listBackups, paths, readMeta } from '../src/layout.js';
import { NOW, testContext, type TestContext } from './cli-context.js';
import { tempDir } from './helpers.js';

let dir: string;
let tick = 0;
/** A context a few seconds later each time: backups are named by the second. */
const later = (overrides: Parameters<typeof testContext>[1] = {}) => {
  const next = testContext(dir, overrides);
  next.setNow(NOW + ++tick * 5000);
  return next;
};
const fingerprint = () => readMeta(testContext(dir).layout)!.fingerprint;
const errorsOf = (run: TestContext) => run.errors.join('\n');
const unsynced = { clock: () => ({ state: 'unsynced' as const, synced: false }) };

beforeEach(() => {
  dir = tempDir();
  tick = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('new-ca without a CA yet', () => {
  it('makes the first CA with no current scope to show and no IP scope by default', async () => {
    const run = later();
    expect(await main(['new-ca', '--yes'], run)).toBe(0);
    const text = run.lines.join('\n');
    expect(text).not.toContain('Current CA scope:');
    expect(text).not.toContain('must trust the new one');
    expect(readMeta(run.layout)!.constraints.subnets).toEqual([]);
    expect(listBackups(run.layout)).toEqual([]);
  });

  it('takes its IP subnets from PIPULSE_TLS_SUBNETS when no --subnet is given', async () => {
    const run = later();
    run.env['PIPULSE_TLS_SUBNETS'] = '192.168.1.0/24';
    expect(await main(['new-ca', '--yes'], run)).toBe(0);
    expect(readMeta(run.layout)!.constraints.subnets).toEqual(['192.168.1.0/24']);
  });
});

describe('new-ca refusals', () => {
  beforeEach(async () => {
    expect(await main(['init'], testContext(dir))).toBe(0);
  });

  it('will not replace an incomplete CA, and says how to recover', async () => {
    unlinkSync(join(dir, 'ca', 'ca.key'));
    const run = later();
    expect(await main(['new-ca', '--yes'], run)).toBe(1);
    expect(errorsOf(run)).toMatch(/the CA is incomplete: .*is missing ca\.key/);
    expect(errorsOf(run)).toContain('to recover:');
  });

  it('rejects --prune-oldest when there are not two backups', async () => {
    const before = fingerprint();
    const run = later();
    expect(await main(['new-ca', '--yes', '--prune-oldest', 'ca.old-20200101T000000Z'], run)).toBe(
      1
    );
    expect(errorsOf(run)).toContain('--prune-oldest is only needed when two backups exist');
    expect(fingerprint()).toBe(before);
  });

  it('refuses a TLS folder that is not the native one', async () => {
    const before = fingerprint();
    const run = later({ defaultTlsDir: '/etc/pipulse/tls' });
    expect(await main(['new-ca', '--yes'], run)).toBe(1);
    expect(errorsOf(run)).toMatch(/not replacing the CA: PIPULSE_TLS_DIR=/);
    expect(fingerprint()).toBe(before);
  });

  it('changes nothing when the question is answered no', async () => {
    const before = fingerprint();
    const run = later({ tty: true, ask: async () => false });
    expect(await main(['new-ca'], run)).toBe(1);
    expect(errorsOf(run)).toContain('nothing changed');
    expect(fingerprint()).toBe(before);
    expect(listBackups(run.layout)).toEqual([]);
  });

  it('does not issue on an unsynced clock, and leaves the CA alone', async () => {
    const before = fingerprint();
    const run = later(unsynced);
    expect(await main(['new-ca', '--yes'], run)).toBe(1);
    expect(errorsOf(run)).toMatch(/not issuing: the clock is not synchronized yet/);
    expect(fingerprint()).toBe(before);
    expect(listBackups(run.layout)).toEqual([]);
  });
});

describe('restore-ca refusals', () => {
  let backupName: string;
  let active: string;
  beforeEach(async () => {
    expect(await main(['init'], testContext(dir))).toBe(0);
    expect(await main(['new-ca', '--yes'], later())).toBe(0);
    active = fingerprint();
    backupName = listBackups(testContext(dir).layout)[0]!.name;
  });

  it('needs exactly one backup name', async () => {
    expect(await main(['restore-ca', '--yes'], later())).toBe(2);
    expect(await main(['restore-ca', backupName, backupName, '--yes'], later())).toBe(2);
  });

  it('refuses with an operator certificate configured', async () => {
    const run = later();
    run.env['PIPULSE_TLS_CERT'] = '/x/c';
    run.env['PIPULSE_TLS_KEY'] = '/x/k';
    expect(await main(['restore-ca', backupName, '--yes'], run)).toBe(1);
    expect(errorsOf(run)).toContain('there is no managed CA to restore');
  });

  it('refuses a TLS folder that is not the native one', async () => {
    const run = later({ defaultTlsDir: '/etc/pipulse/tls' });
    expect(await main(['restore-ca', backupName, '--yes'], run)).toBe(1);
    expect(errorsOf(run)).toMatch(/not restoring the CA: PIPULSE_TLS_DIR=/);
    expect(fingerprint()).toBe(active);
  });

  it('says why a backup that is damaged cannot be restored', async () => {
    unlinkSync(join(dir, backupName, 'ca.key'));
    const run = later();
    expect(await main(['restore-ca', backupName, '--yes'], run)).toBe(1);
    expect(errorsOf(run)).toMatch(/can't be restored: .*is missing ca\.key/);
    expect(fingerprint()).toBe(active);
  });

  it('will not restore over an incomplete active CA', async () => {
    unlinkSync(join(dir, 'ca', 'ca.key'));
    const run = later();
    expect(await main(['restore-ca', backupName, '--yes'], run)).toBe(1);
    expect(errorsOf(run)).toMatch(/the active CA is incomplete \(.*\); move .* aside by hand/);
  });

  it('says so, and changes nothing, when the backup is already the active CA', async () => {
    const copy = 'ca.old-20200101T000000Z';
    cpSync(join(dir, 'ca'), join(dir, copy), { recursive: true });
    const run = later();
    expect(await main(['restore-ca', copy, '--yes'], run)).toBe(0);
    expect(run.lines).toContain(`${copy} is already the active CA`);
    expect(fingerprint()).toBe(active);
    expect(listBackups(run.layout).map((b) => b.name)).toContain(backupName);
  });

  it('changes nothing when the question is answered no', async () => {
    const run = later({ tty: true, ask: async () => false });
    expect(await main(['restore-ca', backupName], run)).toBe(1);
    expect(errorsOf(run)).toContain('nothing changed');
    expect(fingerprint()).toBe(active);
    expect(paths(run.layout).caDir).toBe(join(dir, 'ca'));
  });

  it('does not issue on an unsynced clock, and leaves the CA alone', async () => {
    const run = later(unsynced);
    expect(await main(['restore-ca', backupName, '--yes'], run)).toBe(1);
    expect(errorsOf(run)).toMatch(/not issuing: the clock is not synchronized yet/);
    expect(fingerprint()).toBe(active);
  });
});
