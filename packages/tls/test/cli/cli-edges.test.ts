import { X509Certificate } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askYesNo, defaultContext, lockFor, main } from '../../src/cli.js';
import { initChoosesMode } from '../../src/cli/cmd-init.js';
import { asCaller } from '../../src/cli/cmd-export.js';
import { readClock } from '../../src/settings/clock.js';
import { collectStatus, formatStatus } from '../../src/cli/cmd-status.js';
import { paths, readMeta, readState, writeState } from '../../src/ca/layout.js';
import { testContext, type TestContext } from '../cli-context.js';
import { fixture, tempDir } from '../helpers.js';

// Findings F1-F11 of the 2026-10-13 review of the CLI layer.
const DAY = 86_400_000;
let dir: string;
let ctx: TestContext;
beforeEach(() => {
  dir = tempDir();
  ctx = testContext(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A context over an operator certificate whose TLS folder is `tls` (not made yet). */
function operator(tls: string, overrides: Parameters<typeof testContext>[1] = {}) {
  const cert = join(dir, 'op.crt');
  const key = join(dir, 'op.key');
  const ca = join(dir, 'op-ca.crt');
  writeFileSync(cert, fixture('leaf.crt') + fixture('intermediate.crt'), { mode: 0o644 });
  writeFileSync(key, fixture('leaf.key'), { mode: 0o600 });
  writeFileSync(ca, fixture('root-ca.crt'), { mode: 0o644 });
  const base = testContext(dir);
  return testContext(dir, {
    layout: { ...base.layout, tlsDir: tls, caRoot: tls },
    defaultTlsDir: tls,
    env: {
      PIPULSE_TLS_DIR: tls,
      PIPULSE_TLS_CERT: cert,
      PIPULSE_TLS_KEY: key,
      PIPULSE_TLS_CA: ca,
      PIPULSE_DB_PATH: join(dir, 'pipulse.db')
    },
    ...overrides
  });
}

describe('F1: init --mode auto with an operator certificate and no TLS folder', () => {
  it('makes the folder, writes state.json and releases the lock', async () => {
    const tls = join(dir, 'tls');
    const run = operator(tls);
    expect(await main(['init', '--mode', 'auto', '--first-install'], run)).toBe(0);
    expect(readState(run.layout)).toBe('https');
    expect(existsSync(join(tls, '.pipulse-tls.lock'))).toBe(false);
  });
});

describe('F2: a clock that ran ahead and came back', () => {
  const realClock = (run: TestContext) =>
    Object.assign(run, {
      clock: () =>
        readClock({
          timesyncDir: '/x',
          now: run.now(),
          trust: false,
          exists: () => true
        })
    });

  it('replaces a leaf dated in the future instead of waiting for a clock that is fine', async () => {
    await main(['init'], ctx);
    const ahead = realClock(testContext(dir));
    ahead.setNow(ctx.now() + 100 * DAY);
    expect(await main(['renew', '--force'], ahead)).toBe(0); // issued while the clock was wrong
    const bad = new X509Certificate(readFileSync(paths(ctx.layout).leafCrt));
    expect(new Date(bad.validFrom).getTime()).toBeGreaterThan(ctx.now() + 99 * DAY);

    const back = realClock(testContext(dir)); // NTP corrects the clock; timesyncd says synced
    expect(await main(['renew'], back)).toBe(0);
    expect(back.lines.join('\n')).not.toContain('waiting for clock');
    expect(back.lines.join('\n')).toMatch(/renewed \(.*dated in the future/);
    const fixed = new X509Certificate(readFileSync(paths(ctx.layout).leafCrt));
    expect(new Date(fixed.validFrom).getTime()).toBeLessThanOrEqual(ctx.now());
  });

  it('init replaces it too, and does not call the clock unsynced', async () => {
    await main(['init'], ctx);
    const ahead = realClock(testContext(dir));
    ahead.setNow(ctx.now() + 100 * DAY);
    await main(['renew', '--force'], ahead);
    const back = realClock(testContext(dir));
    expect(await main(['init'], back)).toBe(0);
    expect(back.lines.join('\n')).toContain('issued a certificate');
  });

  it('status says the certificate is not valid yet, not that the clock is unsynced', async () => {
    await main(['init'], ctx);
    const ahead = realClock(testContext(dir));
    ahead.setNow(ctx.now() + 100 * DAY);
    await main(['renew', '--force'], ahead);
    const back = realClock(testContext(dir));
    const text = formatStatus(collectStatus(back), back).join('\n');
    expect(text).toContain('synchronized');
    expect(text).not.toContain('not synchronized yet');
    expect(text).toContain('not valid until');
  });
});

describe('F3: names given to new-ca', () => {
  const sans = () => new X509Certificate(readFileSync(paths(ctx.layout).leafCrt)).subjectAltName!;

  it('reach the certificate, and a rotation keeps them unless told `--name none`', async () => {
    await main(['init'], ctx);
    expect(await main(['new-ca', '--name', 'pi.lan', '--yes'], testContext(dir))).toBe(0);
    expect(readMeta(ctx.layout)!.constraints.dns).toContain('pi.lan');
    expect(sans()).toContain('DNS:pi.lan');

    const keep = testContext(dir);
    expect(await main(['new-ca', '--yes'], keep)).toBe(0);
    expect(readMeta(ctx.layout)!.constraints.dns).toContain('pi.lan');
    expect(keep.lines.join('\n')).toContain('Keeping the current names');
    expect(sans()).toContain('DNS:pi.lan');

    const drop = testContext(dir);
    expect(
      await main(['new-ca', '--name', 'none', '--yes', '--prune-oldest', oldest()], drop)
    ).toBe(0);
    expect(readMeta(ctx.layout)!.constraints.dns).not.toContain('pi.lan');
  });

  function oldest(): string {
    return readMeta(ctx.layout)!.backups[0]!.name;
  }

  it('refuses `--name none` together with another name', async () => {
    await main(['init'], ctx);
    expect(await main(['new-ca', '--name', 'none', '--name', 'a.lan', '--yes'], ctx)).toBe(2);
  });
});

describe('F4: a folder PiPulse did not make is not re-owned', () => {
  it('disable over an operator certificate leaves the folder mode alone', async () => {
    const foreign = join(dir, 'ssl');
    mkdirSync(foreign, { mode: 0o755 });
    chmodSync(foreign, 0o755);
    const run = operator(foreign, { defaultTlsDir: join(dir, 'not-this-one') });
    expect(await main(['disable', '--yes'], run)).toBe(0);
    expect(readState(run.layout)).toBe('legacy-http');
    expect(statSync(foreign).mode & 0o7777).toBe(0o755);
  });
});

describe('F6: end of input at a prompt', () => {
  it('answers no instead of leaving the command hanging', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = askYesNo('Replace the CA?', input, output);
    input.end();
    expect(await answer).toBe(false);
  });

  it('still reads y and yes', async () => {
    const input = new PassThrough();
    const answer = askYesNo('ok?', input, new PassThrough());
    input.write('Yes\n');
    expect(await answer).toBe(true);
  });
});

describe('F7: status wording', () => {
  it('does not say HTTPS is ready when there is no CA', async () => {
    writeState(ctx.layout, 'legacy-http');
    const text = formatStatus(collectStatus(ctx), ctx).join('\n');
    expect(text).not.toContain('HTTPS is ready');
    expect(text).toContain('no CA yet');
  });

  it('says HTTPS is ready when a CA is there', async () => {
    await main(['init'], ctx);
    writeState(ctx.layout, 'legacy-http');
    expect(formatStatus(collectStatus(ctx), ctx).join('\n')).toContain('HTTPS is ready');
  });
});

describe('F8: a damaged state.json', () => {
  it('names the file, and enable/disable replace it', async () => {
    await main(['init'], ctx);
    writeFileSync(paths(ctx.layout).state, '{', { mode: 0o640 });
    const run = testContext(dir);
    expect(await main(['disable', '--yes'], run)).toBe(0);
    expect(run.errors.join('\n')).toContain(paths(ctx.layout).state);
    expect(readState(ctx.layout)).toBe('legacy-http');
  });
});

describe('F9: enable over an operator certificate that only fails verification', () => {
  it('warns and stays on HTTPS, as the installer does', async () => {
    const run = operator(join(dir, 'tls'), {
      health: async () => ({
        code: 2,
        message: 'TLS verification failed: UNABLE_TO_GET_ISSUER_CERT'
      })
    });
    expect(await main(['enable', '--yes'], run)).toBe(0);
    expect(readState(run.layout)).toBe('https');
    expect(run.restarts).toBe(1);
    expect(run.errors.join('\n')).toContain('UNABLE_TO_GET_ISSUER_CERT');
  });
});

describe('F10: a failure after the new CA is in place', () => {
  it('warns, still prints the new CA, and does not look like a failed rotation', async () => {
    await main(['init'], ctx);
    await main(['new-ca', '--yes'], testContext(dir));
    await main(['new-ca', '--yes'], testContext(dir));
    const target = readMeta(ctx.layout)!.backups[0]!.name;
    const failing = testContext(dir, {
      hook: (point, path) => {
        if (point === 'remove' && path.endsWith(target)) throw new Error('disk trouble');
      }
    });
    expect(await main(['new-ca', '--yes', '--prune-oldest', target], failing)).toBe(0);
    expect(failing.errors.join('\n')).toMatch(/warning: .*disk trouble/);
    expect(failing.lines.join('\n')).toContain('CA SHA-256 fingerprint');
  });
});

describe('F11: waits are measured on the monotonic clock', () => {
  it('enable does not give up early when the wall clock steps forward during the health wait', async () => {
    await main(['init'], ctx);
    writeState(ctx.layout, 'legacy-http');
    let calls = 0;
    let mono = 0;
    const run = testContext(dir, {
      monotonic: () => mono,
      sleep: async (ms) => {
        mono += ms;
      },
      health: async () => {
        calls++;
        run.setNow(run.now() + DAY); // NTP steps the wall clock a day on every probe
        return calls < 4 ? { code: 1, message: 'starting' } : { code: 0, message: 'healthy' };
      }
    });
    expect(await main(['enable', '--yes'], run)).toBe(0);
    expect(readState(run.layout)).toBe('https');
  });
});

describe('F5: export-ca --out is written with the caller’s rights', () => {
  const fake = () => {
    const calls: string[] = [];
    return {
      calls,
      proc: {
        geteuid: () => 0,
        getgroups: () => [0, 4],
        setgroups: (g: number[]) => calls.push(`groups ${g.join(',')}`),
        setegid: (g: number) => calls.push(`egid ${g}`),
        seteuid: (u: number) => calls.push(`euid ${u}`)
      }
    };
  };

  it('drops to SUDO_UID/SUDO_GID (and its own groups) around the work, then returns to root', () => {
    const { calls, proc } = fake();
    const result = asCaller(
      { SUDO_UID: '1000', SUDO_GID: '1001' },
      () => {
        calls.push('work');
        return 7;
      },
      proc
    );
    expect(result).toBe(7);
    expect(calls).toEqual([
      'groups 1001',
      'egid 1001',
      'euid 1000',
      'work',
      'euid 0',
      'egid 0',
      'groups 0,4'
    ]);
  });

  it('returns to root when the work throws', () => {
    const { calls, proc } = fake();
    expect(() =>
      asCaller(
        { SUDO_UID: '1000', SUDO_GID: '1000' },
        () => {
          throw new Error('boom');
        },
        proc
      )
    ).toThrow('boom');
    expect(calls.slice(-3)).toEqual(['euid 0', 'egid 0', 'groups 0,4']);
  });

  it('does nothing without sudo, for root’s own uid, or when not root', () => {
    for (const [env, euid] of [
      [{}, 0],
      [{ SUDO_UID: '0', SUDO_GID: '0' }, 0],
      [{ SUDO_UID: '1000', SUDO_GID: '1000' }, 1000],
      [{ SUDO_UID: 'abc', SUDO_GID: '1' }, 0]
    ] as const) {
      const { calls, proc } = fake();
      asCaller(env, () => calls.push('work'), { ...proc, geteuid: () => euid });
      expect(calls).toEqual(['work']);
    }
  });
});

describe('initChoosesMode', () => {
  it('is exactly true for a valid --mode and exactly false for everything else', () => {
    expect(initChoosesMode(['--mode', 'auto'])).toBe(true);
    expect(initChoosesMode(['--mode=auto'])).toBe(true);
    expect(initChoosesMode(['--mode=bogus'])).toBe(true);
    expect(initChoosesMode([])).toBe(false);
    expect(initChoosesMode(['--yes', '--quiet'])).toBe(false);
    // what init refuses is no mode request, and it never throws from here
    expect(initChoosesMode(['--mode'])).toBe(false);
    expect(initChoosesMode(['--nope', '--mode=auto'])).toBe(false);
    expect(initChoosesMode(['stray', '--mode=auto'])).toBe(false);
  });
});

describe('lockFor with init --mode', () => {
  it('locks over an operator certificate (it writes state.json)', () => {
    expect(lockFor('init', operator(join(dir, 'tls')), ['--mode', 'auto'])).toEqual({
      create: true
    });
    expect(lockFor('init', operator(join(dir, 'tls')), [])).toBeUndefined();
  });

  it('does not lock, or make the folder, when the TLS folder is refused', () => {
    const refused = testContext(dir, { defaultTlsDir: join(dir, 'elsewhere') });
    expect(lockFor('init', refused, ['--mode', 'auto'])).toBeUndefined();
  });

  it('locks in the default folder', () => {
    expect(lockFor('init', ctx, ['--mode', 'auto'])).toEqual({ create: true });
  });

  it('recognises --mode however it is spelled, over an operator certificate', () => {
    const op = operator(join(dir, 'tls'));
    const locked = { create: true };
    expect(lockFor('init', op, ['--mode=auto'])).toEqual(locked);
    expect(lockFor('init', op, ['--yes', '--mode=auto', '--first-install'])).toEqual(locked);
    expect(lockFor('init', op, ['--subnet=10.0.0.0/24', '--mode', 'auto'])).toEqual(locked);
  });

  it('does not take other arguments for --mode', () => {
    const op = operator(join(dir, 'tls'));
    // arguments init itself refuses write nothing; "--mode" as a value or after `--` is no option
    expect(lockFor('init', op, ['--subnet', '--mode'])).toBeUndefined();
    expect(lockFor('init', op, ['--', '--mode=auto'])).toBeUndefined();
    expect(lockFor('init', op, ['--unknown', '--mode=auto'])).toBeUndefined();
    expect(lockFor('init', op, ['--yes'])).toBeUndefined();
    // a --mode without its value is a usage error before anything is written
    expect(lockFor('init', op, ['--mode'])).toBeUndefined();
  });

  it('only init treats --mode as a request for a mode', () => {
    const op = operator(join(dir, 'tls'));
    for (const command of ['renew', 'new-ca', 'restore-ca']) {
      expect(lockFor(command, op, ['--mode=auto'])).toBeUndefined();
      expect(lockFor(command, op, ['--mode', 'auto'])).toBeUndefined();
    }
    expect(lockFor('enable', op, ['--mode=auto'])).toEqual({ create: true });
  });

  it('keeps the refused-folder rule for the = spelling', () => {
    const refused = testContext(dir, { defaultTlsDir: join(dir, 'elsewhere') });
    expect(lockFor('init', refused, ['--mode=auto'])).toBeUndefined();
  });
});

describe('remaining branches of the review fixes', () => {
  it('an operator folder that does not exist yet is made (and only made)', async () => {
    const foreign = join(dir, 'made-for-state');
    const run = operator(foreign, { defaultTlsDir: join(dir, 'not-this-one') });
    expect(await main(['disable', '--yes'], run)).toBe(0);
    expect(statSync(foreign).isDirectory()).toBe(true);
    expect(readState(run.layout)).toBe('legacy-http');
  });

  it('asCaller keeps root’s groups as [0] when the platform cannot list them', () => {
    const calls: string[] = [];
    asCaller({ SUDO_UID: '1000', SUDO_GID: '1000' }, () => undefined, {
      geteuid: () => 0,
      setgroups: (g) => calls.push(`groups ${g.join(',')}`),
      setegid: () => undefined,
      seteuid: () => undefined
    });
    expect(calls.at(-1)).toBe('groups 0');
  });

  it('export-ca --out says when the file exists, or the folder is missing', async () => {
    await main(['init'], ctx);
    const taken = join(dir, 'taken.crt');
    writeFileSync(taken, 'x');
    const exists = testContext(dir);
    expect(await main(['export-ca', '--out', taken], exists)).toBe(1);
    expect(exists.errors.join('\n')).toContain('it already exists');
    const missing = testContext(dir);
    expect(await main(['export-ca', '--out', join(dir, 'no', 'such', 'a.crt')], missing)).toBe(1);
    expect(missing.errors.join('\n')).toMatch(/can't write .*ENOENT/);
  });

  it('status reports a journal it may not read as "can’t check", not as pending', async () => {
    await main(['init'], ctx);
    const txn = paths(ctx.layout).txn;
    writeFileSync(txn, '{}', { mode: 0o000 });
    chmodSync(txn, 0o000);
    try {
      const report = collectStatus(ctx);
      if (process.getuid?.() === 0) return; // root reads it anyway
      expect(report.configured.journal).toBe('unreadable');
      expect(formatStatus(report, ctx).join('\n')).toContain("can't check");
    } finally {
      chmodSync(txn, 0o600);
    }
  });

  it('the real context has a monotonic clock and asks on the terminal', async () => {
    const real = defaultContext();
    const a = real.monotonic!();
    expect(real.monotonic!()).toBeGreaterThanOrEqual(a);
    expect(typeof real.ask).toBe('function');
  });
});

describe('new-ca after the host was renamed', () => {
  const metaDns = () => readMeta(ctx.layout)!.constraints.dns;
  const renamed = (hostname: string, overrides: Parameters<typeof testContext>[1] = {}) =>
    testContext(dir, { hostname: () => hostname, ...overrides });

  it('drops the old host name and its .local, and says so', async () => {
    await main(['init'], ctx);
    expect(metaDns()).toEqual(['io', 'io.local', 'localhost']);
    const after = renamed('ganymede');
    expect(await main(['new-ca', '--yes'], after)).toBe(0);
    expect(metaDns()).toEqual(['ganymede', 'ganymede.local', 'localhost']);
    expect(after.lines.join('\n')).toContain('ganymede');
    expect(after.lines.join('\n')).toContain('dropping the old host name io');
    expect(
      new X509Certificate(readFileSync(paths(ctx.layout).leafCrt)).subjectAltName
    ).not.toContain('io.local');
  });

  it('does the same for a dotted host name', async () => {
    const first = renamed('pi.lan');
    await main(['init'], first);
    expect(metaDns()).toEqual(['pi.lan', 'pi.lan.local', 'localhost']);
    expect(await main(['new-ca', '--yes'], renamed('pi2.lan'))).toBe(0);
    expect(metaDns()).toEqual(['pi2.lan', 'pi2.lan.local', 'localhost']);
  });

  it('keeps an alias the operator added with --name, and lets --name bring the old host back', async () => {
    await main(['init'], ctx);
    expect(await main(['new-ca', '--name', 'nas.lan', '--yes'], testContext(dir))).toBe(0);
    expect(await main(['new-ca', '--yes'], renamed('ganymede'))).toBe(0);
    expect(metaDns()).toEqual(['ganymede', 'ganymede.local', 'localhost', 'nas.lan']);
    const oldest = readMeta(ctx.layout)!.backups[0]!.name; // two backups exist: the third rotation needs one pruned
    expect(
      await main(
        ['new-ca', '--name', 'io.lan', '--yes', '--prune-oldest', oldest],
        renamed('ganymede')
      )
    ).toBe(0);
    expect(metaDns()).toContain('io.lan');
  });

  it('says why a host name the CA cannot hold is refused, and changes nothing', async () => {
    await main(['init'], ctx);
    const before = readFileSync(paths(ctx.layout).publicCa, 'utf8');
    const bad = renamed('bad_host'); // an underscore is not allowed in a DNS name
    expect(await main(['new-ca', '--yes'], bad)).toBe(1);
    expect(bad.errors.join('\n')).toContain('not creating a CA');
    expect(readFileSync(paths(ctx.layout).publicCa, 'utf8')).toBe(before);
  });

  it('says nothing about a host that kept its name', async () => {
    await main(['init'], ctx);
    const same = testContext(dir);
    expect(await main(['new-ca', '--yes'], same)).toBe(0);
    expect(same.lines.join('\n')).not.toContain('dropping the old host name');
  });

  it('says it keeps a name that was asked for again, and says nothing when there are none to keep', async () => {
    await main(['init'], ctx);
    expect(await main(['new-ca', '--name', 'nas.lan', '--yes'], testContext(dir))).toBe(0);
    const again = testContext(dir);
    expect(await main(['new-ca', '--name', 'nas.lan', '--yes'], again)).toBe(0);
    expect(again.lines.join('\n')).toContain('Keeping the current names (nas.lan)');

    const other = tempDir();
    await main(['init'], testContext(other));
    const none = testContext(other);
    expect(await main(['new-ca', '--yes'], none)).toBe(0);
    expect(none.lines.join('\n')).not.toContain('Keeping the current names');
    rmSync(other, { recursive: true, force: true });
  });

  it('compares the host with the name the CA stores, not with the raw system name', async () => {
    await main(['init'], ctx);
    const trailingDot = renamed('IO.'); // what os.hostname() may give: upper case, a trailing dot
    expect(await main(['new-ca', '--yes'], trailingDot)).toBe(0);
    expect(trailingDot.lines.join('\n')).not.toContain('dropping the old host name');
    expect(metaDns()).toEqual(['io', 'io.local', 'localhost']);
  });

  it('does not say it drops the old host name when --name asks for it', async () => {
    await main(['init'], renamed('pi.lan'));
    const asked = renamed('pi2.lan');
    expect(await main(['new-ca', '--name', 'pi.lan', '--yes'], asked)).toBe(0);
    expect(asked.lines.join('\n')).not.toContain('dropping the old host name');
    expect(metaDns()).toContain('pi.lan');
    expect(metaDns()).not.toContain('pi.lan.local');
  });
});

describe('new-ca after a rename, with the old host asked for in another spelling', () => {
  it.each([' PI.LAN ', 'pi.lan.'])(
    'does not say it drops the old host for --name %j',
    async (spelling) => {
      await main(['init'], testContext(dir, { hostname: () => 'pi.lan' }));
      const asked = testContext(dir, { hostname: () => 'pi2.lan' });
      expect(await main(['new-ca', '--name', spelling, '--yes'], asked)).toBe(0);
      expect(asked.lines.join('\n')).not.toContain('dropping the old host name');
    }
  );

  it('reports something thrown that is not an Error as text', async () => {
    await main(['init'], ctx);
    let calls = 0;
    const odd = testContext(dir, {
      hostname: () => {
        if (++calls > 1) throw 'odd failure';
        return 'io';
      }
    });
    expect(await main(['new-ca', '--yes'], odd)).toBe(1);
    expect(odd.errors.join('\n')).toContain('not creating a CA: odd failure');
  });
});

describe('a name that is refused as a public suffix', () => {
  it('says where it came from and how to get past it', async () => {
    await main(['init'], ctx);
    const refused = testContext(dir, {
      env: { PIPULSE_TLS_DIR: dir, PIPULSE_TLS_NAMES: 'github.io' }
    });
    expect(await main(['new-ca', '--yes'], refused)).toBe(1);
    const text = refused.errors.join('\n');
    expect(text).toContain('github.io is a public suffix');
    expect(text).toContain('PIPULSE_TLS_NAMES');
    expect(text).toContain('--name none');
  });

  it('says nothing about where it came from for any other refusal', async () => {
    await main(['init'], ctx);
    const other = testContext(dir, { env: { PIPULSE_TLS_DIR: dir, PIPULSE_TLS_NAMES: 'com' } });
    expect(await main(['new-ca', '--yes'], other)).toBe(1);
    expect(other.errors.join('\n')).not.toContain('--name none');
  });
});

describe('the scope new-ca prints before replacing a CA', () => {
  it('shows the current scope as its DNS and IP lines only, then the new scope', async () => {
    await main(['init'], ctx);
    const rotation = testContext(dir);
    expect(await main(['new-ca', '--yes'], rotation)).toBe(0);
    const at = rotation.lines.indexOf('Current CA scope:');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rotation.lines[at + 1]).toMatch(/^ {2}DNS: io, io\.local, localhost/);
    expect(rotation.lines[at + 2]).toMatch(/^ {2}IP: {2}127\.0\.0\.1\/32/);
    expect(rotation.lines[at + 3]).toBe('New CA scope:');
  });
});
