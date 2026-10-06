import { X509Certificate } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { IPV6_RENEW_AFTER_MS, renewDue } from '../src/cmd-renew.js';
import { CLOCK_FLOOR_MS } from '../src/clock.js';
import { decideInitialMode } from '../src/cmd-init.js';
import { paths, readMeta, readRenewStatus, readState, writeState } from '../src/layout.js';
import { NOW, testContext, type TestContext } from './cli-context.js';
import { tempDir } from './helpers.js';

const DAY = 86_400_000;
let dir: string;
let ctx: TestContext;
beforeEach(() => {
  dir = tempDir();
  ctx = testContext(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const leafCert = () => new X509Certificate(readFileSync(paths(ctx.layout).leafCrt));
const mode = (path: string) => statSync(path).mode & 0o7777;

describe('init', () => {
  it('makes a names-only CA and a leaf with the spec’s modes, and prints the fingerprint', async () => {
    expect(await main(['init'], ctx)).toBe(0);
    const p = paths(ctx.layout);
    expect(mode(p.caKey)).toBe(0o600);
    expect(mode(p.caDir)).toBe(0o700);
    expect(mode(p.bundle)).toBe(0o640);
    expect(mode(p.publicCa)).toBe(0o644);
    expect(mode(dir)).toBe(0o2750);
    expect(existsSync(p.state)).toBe(false);
    const meta = readMeta(ctx.layout)!;
    expect(meta.constraints.subnets).toEqual([]);
    expect(ctx.lines).toContain(`CA SHA-256 fingerprint: ${meta.fingerprint}`);
    expect(ctx.lines.join('\n')).toContain('IP access (https://<address>:8889) is not covered');
    expect(leafCert().subjectAltName).not.toContain('192.168.1.35');
  });

  it('is idempotent: a second run keeps the CA and says there is nothing to do', async () => {
    await main(['init'], ctx);
    const first = readMeta(ctx.layout)!.fingerprint;
    const leaf = leafCert().fingerprint256;
    const again = testContext(dir);
    expect(await main(['init'], again)).toBe(0);
    expect(readMeta(ctx.layout)!.fingerprint).toBe(first);
    expect(leafCert().fingerprint256).toBe(leaf);
    expect(again.lines.join('\n')).toContain('nothing to do');
  });

  it('never regenerates a partial CA', async () => {
    await main(['init'], ctx);
    unlinkSync(paths(ctx.layout).caKey);
    const again = testContext(dir);
    expect(await main(['init'], again)).toBe(1);
    expect(again.errors.join('\n')).toMatch(/incomplete[\s\S]*restore-ca/);
    expect(existsSync(paths(ctx.layout).caCert)).toBe(true);
  });

  it('asks before accepting a subnet: --yes or a terminal', async () => {
    expect(await main(['init', '--subnet', '192.168.1.0/24'], ctx)).toBe(2);
    expect(existsSync(paths(ctx.layout).caDir)).toBe(false);
    const asked: string[] = [];
    const tty = testContext(dir, { tty: true, ask: async (q) => (asked.push(q), false) });
    expect(await main(['init', '--subnet', '192.168.1.0/24'], tty)).toBe(1);
    expect(tty.lines.join('\n')).toContain('Accepting 192.168.1.0/24 allows this CA');
    expect(asked).toEqual(['Create this CA?']);
    expect(await main(['init', '--subnet', '192.168.1.0/24', '--yes'], testContext(dir))).toBe(0);
    expect(readMeta(ctx.layout)!.constraints.subnets).toEqual(['192.168.1.0/24']);
    expect(leafCert().subjectAltName).toContain('192.168.1.35');
  });

  it('refuses a bad subnet without creating anything', async () => {
    expect(await main(['init', '--subnet', '10.0.0.0/8', '--yes'], ctx)).toBe(1);
    expect(ctx.errors.join('\n')).toContain('broader than /16');
    expect(existsSync(paths(ctx.layout).caDir)).toBe(false);
  });

  it('does nothing when an operator certificate is configured', async () => {
    ctx.env['PIPULSE_TLS_CERT'] = '/x/cert.pem';
    ctx.env['PIPULSE_TLS_KEY'] = '/x/key.pem';
    expect(await main(['init'], ctx)).toBe(0);
    expect(ctx.lines).toContain(
      'operator certificate in use (PIPULSE_TLS_CERT/PIPULSE_TLS_KEY); managed CA not created'
    );
    expect(existsSync(paths(ctx.layout).caDir)).toBe(false);
  });

  it('waits for an unsynced clock, then refuses without issuing', async () => {
    const early = testContext(dir, { clock: () => ({ state: 'unsynced', synced: false }) });
    expect(await main(['init'], early)).toBe(1);
    expect(early.errors.join('\n')).toContain('the clock is not synchronized yet');
    expect(early.now() - NOW).toBeGreaterThanOrEqual(60_000);
    expect(existsSync(paths(ctx.layout).caDir)).toBe(false);
  });

  it('issues with an unknown clock past the floor, with a warning (chrony hosts, containers)', async () => {
    const chrony = testContext(dir, { clock: () => ({ state: 'unknown', synced: false }) });
    expect(NOW).toBeGreaterThan(CLOCK_FLOOR_MS);
    expect(await main(['init'], chrony)).toBe(0);
    expect(chrony.errors.join('\n')).toContain('PIPULSE_TLS_CLOCK=trust');
  });

  it('replaces an expired leaf instead of saying there is nothing to do', async () => {
    await main(['init'], ctx);
    const before = leafCert();
    const later = testContext(dir);
    later.setNow(before.validToDate.getTime() + DAY);
    expect(await main(['init'], later)).toBe(0);
    expect(later.errors.join('\n')).toMatch(/replacing the certificate: it expired on/);
    expect(leafCert().fingerprint256).not.toBe(before.fingerprint256);
    // and a valid one names its date
    const again = testContext(dir);
    again.setNow(later.now());
    expect(await main(['init'], again)).toBe(0);
    expect(again.lines.join('\n')).toMatch(
      /certificate is valid until \d{4}-\d\d-\d\d\); nothing to do/
    );
  });

  it('replaces a leaf that does not verify', async () => {
    await main(['init'], ctx);
    const before = leafCert().fingerprint256;
    writeFileSync(paths(ctx.layout).bundle, 'garbage', { mode: 0o640 });
    const again = testContext(dir);
    expect(await main(['init'], again)).toBe(0);
    expect(leafCert().fingerprint256).not.toBe(before);
  });
});

describe('renew', () => {
  const status = () => readRenewStatus(paths(ctx.layout).renewStatus);

  it('without a CA says how to make one and records nothing', async () => {
    expect(await main(['renew'], ctx)).toBe(0);
    expect(ctx.lines.join('\n')).toContain('sudo pipulse tls init');
    expect(status()).toBeUndefined();
  });

  it('is not due on a fresh leaf, and records that', async () => {
    await main(['init'], ctx);
    expect(await main(['renew'], ctx)).toBe(0);
    expect(status()?.result).toBe('not-due');
  });

  it('waits for the clock and records waiting-clock, even with --force', async () => {
    await main(['init'], ctx);
    const before = leafCert().fingerprint256;
    const unsynced = testContext(dir, { clock: () => ({ state: 'unsynced', synced: false }) });
    expect(await main(['renew', '--force'], unsynced)).toBe(0);
    expect(status()?.result).toBe('waiting-clock');
    expect(leafCert().fingerprint256).toBe(before);
  });

  it('renews 30 days before expiry', async () => {
    await main(['init'], ctx);
    const notAfter = leafCert().validToDate.getTime();
    const later = testContext(dir);
    later.setNow(notAfter - 30 * DAY);
    expect(await main(['renew'], later)).toBe(0);
    expect(status()?.result).toBe('renewed');
    expect(leafCert().validToDate.getTime()).toBeGreaterThan(notAfter);
  });

  it('renews early for a new default-route address the CA covers, never for one it does not', async () => {
    await main(['init', '--subnet', '192.168.1.0/24', '--yes'], ctx);
    const moved = testContext(dir, { addresses: () => ['192.168.1.36'] });
    expect(await main(['renew'], moved)).toBe(0);
    expect(status()?.reason).toContain('192.168.1.36');
    expect(leafCert().subjectAltName).toContain('192.168.1.36');
    const away = testContext(dir, { addresses: () => ['10.0.0.7'] });
    expect(await main(['renew'], away)).toBe(0);
    expect(status()?.result).toBe('not-due');
  });

  it('a failed renewal is recorded and keeps the old leaf', async () => {
    await main(['init'], ctx);
    const before = leafCert().fingerprint256;
    const broken = testContext(dir, { openssl: join(dir, 'no-such-openssl') });
    expect(await main(['renew', '--force'], broken)).toBe(1);
    expect(status()?.result).toBe('failed');
    expect(leafCert().fingerprint256).toBe(before);
  });

  it('does not reissue every hour once the CA itself is about to expire', async () => {
    await main(['init'], ctx);
    const caEnd = new X509Certificate(
      readFileSync(paths(ctx.layout).publicCa)
    ).validToDate.getTime();
    const late = testContext(dir);
    late.setNow(caEnd - 10 * DAY);
    expect(await main(['renew'], late)).toBe(0); // the 90-day leaf is long expired: renewed, capped at the CA
    expect(status()?.result).toBe('renewed');
    expect(leafCert().validToDate.getTime()).toBe(caEnd);
    const fingerprint = leafCert().fingerprint256;
    late.setNow(late.now() + 3_600_000);
    expect(await main(['renew'], late)).toBe(0);
    expect(status()).toMatchObject({ result: 'not-due' });
    expect(status()?.reason).toContain('sudo pipulse tls new-ca');
    expect(leafCert().fingerprint256).toBe(fingerprint);
  });

  it('without a CA but with a served certificate or a chosen mode, records a failure', async () => {
    await main(['init'], ctx);
    expect(await main(['renew'], ctx)).toBe(0);
    expect(status()?.result).toBe('not-due');
    rmSync(paths(ctx.layout).caDir, { recursive: true });
    expect(await main(['renew'], ctx)).toBe(1);
    expect(status()).toMatchObject({ result: 'failed' });
    expect(status()?.reason).toContain('there is no CA');
  });

  it('a legacy-http install with no CA is "not set up", never a failure (the hourly timer runs everywhere)', async () => {
    writeState(ctx.layout, 'legacy-http');
    expect(await main(['renew'], ctx)).toBe(0);
    expect(ctx.lines.join('\n')).toContain('sudo pipulse tls init');
    expect(status()).toBeUndefined();
  });

  it('a state that chose https with no CA is a failure, and so is an unreadable state', async () => {
    writeState(ctx.layout, 'https');
    expect(await main(['renew'], ctx)).toBe(1);
    expect(status()).toMatchObject({ result: 'failed' });
    writeFileSync(paths(ctx.layout).state, 'garbage', { mode: 0o640 });
    expect(await main(['renew'], ctx)).toBe(1);
    expect(status()).toMatchObject({ result: 'failed' });
  });

  it('records a corrupt journal as a failure instead of leaving the last good result', async () => {
    await main(['init'], ctx);
    expect(await main(['renew'], ctx)).toBe(0);
    expect(status()?.result).toBe('not-due');
    writeFileSync(paths(ctx.layout).txn, '{ not json', { mode: 0o600 });
    expect(await main(['renew'], ctx)).toBe(1);
    expect(status()).toMatchObject({ result: 'failed' });
    expect(status()?.reason).toContain('txn.json');
  });

  it('never renews an operator certificate', async () => {
    ctx.env['PIPULSE_TLS_CERT'] = '/x/cert.pem';
    ctx.env['PIPULSE_TLS_KEY'] = '/x/key.pem';
    expect(await main(['renew'], ctx)).toBe(0);
    expect(status()).toMatchObject({ result: 'not-due', reason: 'operator certificate' });
  });
});

describe('a missing or wrong openssl', () => {
  it('init says so by name and makes nothing', async () => {
    const run = testContext(dir, { openssl: '/nonexistent/openssl' });
    expect(await main(['init'], run)).toBe(1);
    expect(run.errors.join('\n')).toMatch(/openssl not found: sudo apt install openssl/);
    expect(existsSync(paths(run.layout).caDir)).toBe(false);
  });
  it('renew records the failure by name and keeps the certificate', async () => {
    expect(await main(['init'], ctx)).toBe(0);
    const before = readFileSync(paths(ctx.layout).bundle, 'utf8');
    const broken = testContext(dir, { openssl: '/nonexistent/openssl' });
    expect(await main(['renew', '--force'], broken)).toBe(1);
    expect(readRenewStatus(paths(ctx.layout).renewStatus)).toMatchObject({
      result: 'failed',
      reason: expect.stringContaining('openssl not found')
    });
    expect(readFileSync(paths(ctx.layout).bundle, 'utf8')).toBe(before);
  });
});

describe('the TLS folder on a native install (ruling R15)', () => {
  // The temp folder stands in for a non-default PIPULSE_TLS_DIR: the default is /etc/pipulse/tls.
  // A second temp folder plays the default one (/etc/pipulse/tls).
  const native = (overrides = {}) => {
    mkdirSync(join(dir, 'default'), { recursive: true });
    return testContext(dir, { defaultTlsDir: join(dir, 'default'), ...overrides });
  };

  it('refuses init, new-ca, restore-ca and enable, naming the setting and the reason', async () => {
    for (const command of [
      ['init'],
      ['new-ca', '--yes'],
      ['restore-ca', 'ca.old-20260101T000000Z', '--yes'],
      ['enable', '--yes']
    ]) {
      const run = native();
      expect(await main(command, run)).toBe(1);
      expect(run.errors.join('\n')).toMatch(
        /PIPULSE_TLS_DIR=.*the one folder the renewal service may write/
      );
    }
    expect(existsSync(paths(ctx.layout).caDir)).toBe(false);
  });

  it('renew records the refusal in the default folder, and exits non-zero even when it can’t', async () => {
    const renewal = native();
    expect(await main(['renew'], renewal)).toBe(1);
    expect(readRenewStatus(join(dir, 'default', 'renew-status.json'))).toMatchObject({
      result: 'failed',
      reason: expect.stringContaining('PIPULSE_TLS_DIR')
    });
    expect(readRenewStatus(paths(ctx.layout).renewStatus)).toBeUndefined();
    const nowhere = testContext(dir, { defaultTlsDir: join(dir, 'no-such-folder') });
    expect(await main(['renew'], nowhere)).toBe(1);
    expect(nowhere.errors.join('\n')).toMatch(
      /could not record the failure[\s\S]*renewal failed: PIPULSE_TLS_DIR=/
    );
  });

  it('refuses a separate CA folder natively', async () => {
    const run = native({ defaultTlsDir: dir });
    run.layout = { ...run.layout, caRoot: join(dir, 'elsewhere') };
    expect(await main(['init'], run)).toBe(1);
    expect(run.errors.join('\n')).toContain('PIPULSE_TLS_CA_DIR');
  });

  it('allows any folder in a container, and never cares with an operator certificate', async () => {
    expect(await main(['init'], native({ inContainer: true }))).toBe(0);
    const operator = native();
    operator.env['PIPULSE_TLS_CERT'] = '/x/cert.pem';
    operator.env['PIPULSE_TLS_KEY'] = '/x/key.pem';
    expect(await main(['renew'], operator)).toBe(0);
    expect(await main(['init'], operator)).toBe(0);
  });

  it('status names the problem', async () => {
    const run = native();
    await main(['status'], run);
    expect(run.lines.join('\n')).toMatch(/problem: PIPULSE_TLS_DIR=/);
  });
});

describe('renewDue', () => {
  const ok = (over: Partial<{ notBefore: number; notAfter: number; ip: string[] }> = {}) => ({
    kind: 'ok' as const,
    fingerprint: 'F',
    notBefore: NOW - 3_600_000,
    notAfter: NOW + 60 * DAY,
    sans: { dns: ['io'], ip: over.ip ?? [] },
    ...over
  });
  const wanted = (ip: string[]) => ({ dns: ['io'], ip });

  it('treats the CA’s end as a limit, not a reason', () => {
    const leaf = ok({ notAfter: NOW + 10 * DAY });
    expect(renewDue({ leaf, now: NOW, wanted: wanted([]) })).toContain('expires');
    expect(renewDue({ leaf, now: NOW, wanted: wanted([]), caNotAfter: NOW + 10 * DAY })).toBe(
      undefined
    );
    expect(renewDue({ leaf, now: NOW, wanted: wanted([]), caNotAfter: NOW - 1 })).toContain(
      'the CA expired'
    );
  });

  it('adds a new IPv4 address at once, a new IPv6 address only once the leaf is a day old', () => {
    const fresh = ok();
    expect(renewDue({ leaf: fresh, now: NOW, wanted: wanted(['192.168.1.36']) })).toContain(
      '192.168.1.36'
    );
    expect(renewDue({ leaf: fresh, now: NOW, wanted: wanted(['2001:db8::1']) })).toBeUndefined();
    expect(
      renewDue({
        leaf: fresh,
        now: NOW + IPV6_RENEW_AFTER_MS + 3_600_000,
        wanted: wanted(['2001:db8::1'])
      })
    ).toContain('2001:db8::1');
  });
});

describe('decideInitialMode', () => {
  it.each([
    [{ previousInstall: false, dbExists: false, markerExists: false }, 'https'],
    [{ previousInstall: true, dbExists: false, markerExists: false }, 'legacy-http'],
    [{ previousInstall: true, dbExists: true, markerExists: false }, 'legacy-http'],
    [{ previousInstall: false, dbExists: true, markerExists: false }, 'legacy-http'],
    [{ previousInstall: false, dbExists: true, markerExists: true }, 'https'],
    [{ previousInstall: true, dbExists: true, markerExists: true }, 'https']
  ])('%j → %s', (input, expected) => {
    expect(decideInitialMode(input)).toBe(expected);
  });
});

describe('init --mode auto', () => {
  const withDb = (context: TestContext, marker = false) => {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'pipulse.sqlite'), '');
    if (marker) writeFileSync(join(dir, 'data', 'tls-installed'), '');
    context.env['PIPULSE_DB_PATH'] = join(dir, 'data', 'pipulse.sqlite');
    return context;
  };

  it('fresh install: makes the CA, then selects https', async () => {
    expect(await main(['init', '--mode', 'auto', '--first-install'], ctx)).toBe(0);
    expect(readState(ctx.layout)).toBe('https');
  });

  it('upgrade: prepares a names-only CA and stays on HTTP, honouring a subnet setting', async () => {
    ctx.env['PIPULSE_TLS_SUBNETS'] = '192.168.1.0/24';
    expect(await main(['init', '--mode', 'auto', '--yes'], withDb(ctx))).toBe(0);
    expect(readState(ctx.layout)).toBe('legacy-http');
    expect(readMeta(ctx.layout)!.constraints.subnets).toEqual(['192.168.1.0/24']);
    expect(ctx.lines.join('\n')).toContain('sudo pipulse tls enable');
  });

  it('an upgrade with an operator certificate does not say HTTPS is "not switched on"', async () => {
    ctx.env['PIPULSE_TLS_CERT'] = '/etc/pipulse/cert.pem';
    ctx.env['PIPULSE_TLS_KEY'] = '/etc/pipulse/key.pem';
    expect(await main(['init', '--mode', 'auto', '--yes'], withDb(ctx))).toBe(0);
    expect(readState(ctx.layout)).toBe('legacy-http');
    expect(ctx.lines.join('\n')).not.toContain('not switched on');
  });

  it('never touches an existing state.json', async () => {
    await main(['init', '--mode', 'auto', '--first-install'], ctx);
    const again = testContext(dir);
    expect(await main(['init', '--mode', 'auto'], withDb(again))).toBe(0);
    expect(readState(ctx.layout)).toBe('https');
  });

  it('PIPULSE_TLS=off makes no CA: a first run records legacy-http, an existing state stays', async () => {
    ctx.env['PIPULSE_TLS'] = 'off';
    expect(await main(['init', '--mode', 'auto', '--first-install'], ctx)).toBe(0);
    expect(readState(ctx.layout)).toBe('legacy-http');
    expect(existsSync(join(dir, 'ca'))).toBe(false);
    expect(existsSync(join(dir, 'ca-meta.json'))).toBe(false);
    expect(ctx.lines.join('\n')).not.toContain('SHA-256');
    writeState(ctx.layout, 'https');
    expect(await main(['init', '--mode', 'auto'], withDb(ctx))).toBe(0);
    expect(readState(ctx.layout)).toBe('https');
    expect(existsSync(join(dir, 'ca'))).toBe(false);
  });

  it('a lost TLS folder on data that served HTTPS goes back to https, with a warning', async () => {
    const run = withDb(testContext(dir), true);
    expect(await main(['init', '--mode', 'auto'], run)).toBe(0);
    expect(readState(ctx.layout)).toBe('https');
    expect(run.errors.join('\n')).toContain('every device must trust the new CA');
  });

  it('an upgrade whose material fails still selects legacy-http; a fresh install fails with no state', async () => {
    const broken = withDb(testContext(dir, { openssl: join(dir, 'no-openssl') }));
    expect(await main(['init', '--mode', 'auto'], broken)).toBe(0);
    expect(readState(ctx.layout)).toBe('legacy-http');
    expect(broken.errors.join('\n')).toContain('HTTPS is not prepared');
    rmSync(join(dir, 'state.json'));
    rmSync(join(dir, 'data'), { recursive: true });
    const fresh = testContext(dir, { openssl: join(dir, 'no-openssl') });
    expect(await main(['init', '--mode', 'auto', '--first-install'], fresh)).toBe(1);
    expect(readState(ctx.layout)).toBeUndefined();
  });

  it('--quiet leaves out the CA fingerprint block; a bad --mode is a usage error', async () => {
    const quiet = testContext(dir);
    await main(['init', '--mode', 'auto', '--first-install', '--quiet'], quiet);
    expect(quiet.lines.join('\n')).not.toContain('SHA-256');
    expect(await main(['init', '--mode', 'manual'], testContext(dir))).not.toBe(0);
  });
});
