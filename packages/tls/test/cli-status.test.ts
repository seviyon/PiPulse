import { X509Certificate } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, ignoreClosedPipe, lockFor, main } from '../src/cli.js';
import { collectStatus, formatStatus } from '../src/cmd-status.js';
import { REFUSE_LINE } from '../src/config.js';
import { buildConstraints } from '../src/constraints.js';
import { runTransaction } from '../src/journal.js';
import { paths, pub, writeState } from '../src/layout.js';
import { prepareWork, stageNewCa, validateStage } from '../src/material.js';
import { testContext, type TestContext } from './cli-context.js';
import { tempDir } from './helpers.js';

let dir: string;
let ctx: TestContext;
beforeEach(() => {
  dir = tempDir();
  ctx = testContext(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function makeCa(subnets: string[] = []) {
  prepareWork(ctx.layout);
  const { constraints } = buildConstraints({ hostname: 'io', names: [], subnets });
  await runTransaction(ctx.layout, {
    kind: 'init',
    now: ctx.now(),
    stage: async (dirs) => {
      await stageNewCa(ctx, dirs, constraints, []);
    },
    validate: (dirs) => {
      validateStage(dirs, pub(ctx.layout));
    }
  });
}

describe('main', () => {
  it('prints usage and exits 2 for an unknown or missing command', async () => {
    expect(await main(['frobnicate'], ctx)).toBe(2);
    expect(ctx.errors.join('\n')).toMatch(/unknown command: frobnicate[\s\S]*usage: pipulse tls/);
    expect(await main([], ctx)).toBe(2);
  });
  it('refuses root-only commands without root, and says how', async () => {
    const user = testContext(dir, { isRoot: false });
    expect(await main(['init'], user)).toBe(1);
    expect(user.errors).toEqual(['pipulse tls init needs root: sudo pipulse tls init']);
  });
});

describe('lockFor', () => {
  it('knows only real commands: prototype keys are not commands', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])
      expect(lockFor(name, ctx)).toBeUndefined();
    expect(lockFor(undefined, ctx)).toBeUndefined();
    expect(lockFor('status', ctx)).toBeUndefined();
    expect(lockFor('init', ctx)).toEqual({ create: true });
    expect(lockFor('renew', ctx)).toEqual({ create: false });
  });
  it('locks enable and disable even with an operator certificate; the CA commands then need none', () => {
    const operator = testContext(dir, {
      env: { PIPULSE_TLS_DIR: dir, PIPULSE_TLS_CERT: '/c.pem', PIPULSE_TLS_KEY: '/k.pem' }
    });
    expect(lockFor('enable', operator)).toEqual({ create: true });
    expect(lockFor('disable', operator)).toEqual({ create: true });
    expect(lockFor('init', operator)).toBeUndefined();
    expect(lockFor('renew', operator)).toBeUndefined();
  });
  it('a command like "constructor" never creates the TLS folder', async () => {
    const missing = join(dir, 'tls');
    const c = testContext(dir, {
      layout: { ...ctx.layout, tlsDir: missing, caRoot: missing },
      defaultTlsDir: missing
    });
    expect(await main(['constructor'], c)).toBe(2);
    expect(await main(['toString'], c)).toBe(2);
    expect(() => statSync(missing)).toThrow(/ENOENT/);
  });
});

describe('a reader that closes the pipe early', () => {
  it('drops the write and lets the command finish; other stream errors still throw', () => {
    const stream = new PassThrough();
    ignoreClosedPipe(stream);
    expect(() =>
      stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    ).not.toThrow();
    expect(() =>
      stream.emit('error', Object.assign(new Error('destroyed'), { code: 'ERR_STREAM_DESTROYED' }))
    ).not.toThrow();
    expect(() =>
      stream.emit('error', Object.assign(new Error('disk'), { code: 'ENOSPC' }))
    ).toThrow('disk');
  });
});

describe('cli entry', () => {
  it('prints help without building a context, and a settings failure as one line', async () => {
    const boom = () => {
      throw new Error("can't read /etc/pipulse/pipulse.env (EIO): fix it");
    };
    const errors: string[] = [];
    const out: string[] = [];
    expect(
      await cli(
        ['help'],
        boom,
        (l) => errors.push(l),
        (l) => out.push(l)
      )
    ).toBe(0);
    expect(
      await cli(
        ['--help'],
        boom,
        (l) => errors.push(l),
        (l) => out.push(l)
      )
    ).toBe(0);
    expect(errors).toEqual([]);
    expect(out).toHaveLength(2);
    expect(await cli(['status'], boom, (l) => errors.push(l))).toBe(1);
    expect(errors).toEqual(["pipulse tls: can't read /etc/pipulse/pipulse.env (EIO): fix it"]);
  });
});

describe('status', () => {
  describe('a newer certificate on disk than the one served', () => {
    const served = (
      reload: { state: 'ok' | 'failing'; lastError: string | null },
      renewal?: { result: 'failed' | 'renewed'; reason?: string }
    ) => {
      const report = collectStatus(ctx);
      if (renewal)
        report.renewal = {
          version: 1,
          lastAttempt: ctx.now(),
          result: renewal.result,
          ...(renewal.reason ? { reason: renewal.reason } : {})
        };
      report.active = {
        state: 'running',
        status: {
          version: 1,
          transport: 'https',
          certificate: {
            source: 'generated',
            fingerprint: 'AA:BB',
            class: 'valid',
            notAfter: ctx.now() + 1e9,
            reload: { ...reload, lastAttempt: ctx.now() }
          },
          pid: 1,
          startTime: '1',
          bootId: 'b',
          writtenAt: ctx.now()
        }
      };
      return formatStatus(report, ctx).join('\n');
    };
    it('promises pickup within two minutes only while the reload is ok', async () => {
      await makeCa();
      expect(served({ state: 'ok', lastError: null })).toContain(
        'the server picks it up within about two minutes'
      );
    });
    it('does not promise pickup when the last renewal failed after writing leaf.crt', async () => {
      // The renewal wrote leaf.crt but failed before leaf.pem: the served file never changes, the
      // reloader never runs, so the reload stays "ok" and nothing is going to pick it up.
      await makeCa();
      const text = served(
        { state: 'ok', lastError: null },
        { result: 'failed', reason: 'EPERM: operation not permitted' }
      );
      expect(text).not.toContain('within about two minutes');
      expect(text).toContain('the served certificate was not replaced');
      expect(text).toContain('the next successful renewal repairs it');
    });
    it('still promises pickup after a renewal that succeeded', async () => {
      await makeCa();
      expect(served({ state: 'ok', lastError: null }, { result: 'renewed' })).toContain(
        'the server picks it up within about two minutes'
      );
    });
    it('says it was not applied, and why to look above, when the reload is failing', async () => {
      await makeCa();
      const text = served({ state: 'failing', lastError: 'the replacement is expired' });
      expect(text).toContain('reload: failing: the replacement is expired');
      expect(text).toContain('was not applied');
      expect(text).toContain('retried every 10 minutes');
      expect(text).not.toContain('within about two minutes');
    });
  });
  describe('the tls-installed marker', () => {
    const running = (transport: 'https' | 'http') => {
      ctx.env['PIPULSE_DB_PATH'] = join(dir, 'pipulse.sqlite');
      const report = collectStatus(ctx);
      report.active = {
        state: 'running',
        status: {
          version: 1,
          transport,
          certificate: null,
          pid: 1,
          startTime: '1',
          bootId: 'b',
          writtenAt: ctx.now()
        }
      };
      return formatStatus(report, ctx).join('\n');
    };
    it('is reported missing while the server serves HTTPS, naming the path', () => {
      expect(running('https')).toContain(
        `problem: ${join(dir, 'tls-installed')} is missing although the server serves HTTPS: see journalctl -u pipulse`
      );
    });
    it.skipIf(process.getuid?.() === 0)(
      'a data folder this user cannot enter is "can\'t check", not "missing" and not a crash',
      () => {
        const data = join(dir, 'data');
        mkdirSync(data);
        ctx.env['PIPULSE_DB_PATH'] = join(data, 'pipulse.sqlite');
        const report = collectStatus(ctx);
        report.active = {
          state: 'running',
          status: {
            version: 1,
            transport: 'https',
            certificate: null,
            pid: 1,
            startTime: '1',
            bootId: 'b',
            writtenAt: ctx.now()
          }
        };
        chmodSync(data, 0o000);
        try {
          const text = formatStatus(report, ctx).join('\n');
          expect(text).toContain(`can't check ${join(data, 'tls-installed')} (EACCES)`);
          expect(text).not.toContain('is missing although');
        } finally {
          chmodSync(data, 0o700);
        }
      }
    );
    it('is silent when it is there, and when the server serves HTTP', () => {
      writeFileSync(join(dir, 'tls-installed'), '2026-10-05T00:00:00.000Z\n');
      expect(running('https')).not.toContain('tls-installed');
      rmSync(join(dir, 'tls-installed'));
      expect(running('http')).not.toContain('tls-installed');
    });
  });

  it('shows the running server from the status file, and "not running" without one', async () => {
    ctx.env['PIPULSE_RUNTIME_DIR'] = join(dir, 'run');
    await main(['status'], ctx);
    expect(ctx.lines.join('\n')).toMatch(
      /Active \(the running server\)\n {2}not running \(missing\)/
    );
  });
  it('describes an install with nothing generated yet', async () => {
    expect(await main(['status'], ctx)).toBe(0);
    const text = ctx.lines.join('\n');
    expect(text).toContain(`Configured (${dir})`);
    // The release default is to refuse: status says so and prints the fix line.
    expect(text).toMatch(/Mode: +PiPulse would refuse to start — not chosen \(no state\.json\)/);
    expect(text).toContain(`problem: ${REFUSE_LINE}`);
    expect(text).toContain('none yet (sudo pipulse tls init)');
    expect(text).toMatch(/Last renewal\n {2}none recorded/);
  });

  it('shows the CA fingerprint, scope, coverage and certificate', async () => {
    await makeCa();
    writeState(ctx.layout, 'legacy-http');
    await main(['status'], ctx);
    const text = ctx.lines.join('\n');
    const fp = new X509Certificate(readFileSync(paths(ctx.layout).publicCa)).fingerprint256;
    expect(text).toContain(`CA:        SHA-256 ${fp}`);
    expect(text).toContain('HTTPS is ready: sudo pipulse tls enable');
    expect(text).toContain('DNS access: covered (io, io.local, localhost)');
    expect(text).toContain('IP access: not covered');
    expect(text).toContain('How to change scope: sudo pipulse tls new-ca --subnet 192.168.1.0/24');
    expect(text).toMatch(/names: io, io\.local, localhost, 127\.0\.0\.1, ::1/);
    expect(text).toMatch(/valid \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d \(89 days left\)/);
  });

  it('prints the fingerprint of ca.crt’s own bytes, and flags ca-meta.json describing another CA', async () => {
    await makeCa();
    const meta = JSON.parse(readFileSync(paths(ctx.layout).meta, 'utf8'));
    const real = new X509Certificate(readFileSync(paths(ctx.layout).publicCa)).fingerprint256;
    const wrong = real.replace(/^../, real.startsWith('AA') ? 'BB' : 'AA');
    writeFileSync(paths(ctx.layout).meta, JSON.stringify({ ...meta, fingerprint: wrong }));
    await main(['status'], ctx);
    const text = ctx.lines.join('\n');
    expect(text).toContain(`CA:        SHA-256 ${real}`);
    expect(text).toContain(`ca-meta.json describes a different CA (SHA-256 ${wrong}) than ca.crt`);
    expect(text).toContain('the served bundle is leaf.pem and may differ');
  });

  it('says when PIPULSE_TLS overrides state.json', async () => {
    writeState(ctx.layout, 'https');
    ctx.env['PIPULSE_TLS'] = 'off';
    await main(['status'], ctx);
    expect(ctx.lines.join('\n')).toMatch(
      /Mode: +HTTP — PIPULSE_TLS=off in the settings \(overrides state\.json\)/
    );
  });

  it('reports a corrupt state.json instead of guessing', async () => {
    writeFileSync(join(dir, 'state.json'), '{"version":1}');
    await main(['status'], ctx);
    expect(ctx.lines.join('\n')).toMatch(/state\.json is unreadable/);
  });

  it('gives the Docker scope command inside a container', async () => {
    await makeCa();
    const docker = testContext(dir, { inContainer: true });
    await main(['status'], docker);
    expect(docker.lines.join('\n')).toContain(
      'How to change scope: docker compose run --rm pipulse-tls pipulse tls new-ca --subnet 192.168.1.0/24 --yes'
    );
  });

  it('--json has the same facts', async () => {
    await makeCa(['192.168.1.0/24']);
    await main(['status', '--json'], ctx);
    const report = JSON.parse(ctx.lines.join('\n'));
    expect(report.configured.ca.constraints.subnets).toEqual(['192.168.1.0/24']);
    expect(report.configured.leaf.sans.ip).toContain('192.168.1.35');
    expect(report.configured.clock).toEqual({ state: 'synced', trust: false });
  });
});

describe('export-ca', () => {
  it('prints exactly the public ca.crt, and its fingerprint with trust steps on stderr', async () => {
    await makeCa();
    expect(await main(['export-ca'], ctx)).toBe(0);
    const pem = readFileSync(paths(ctx.layout).publicCa, 'utf8');
    expect(`${ctx.lines.join('\n')}\n`).toBe(pem);
    const errors = ctx.errors.join('\n');
    expect(errors).toContain(`SHA-256 ${new X509Certificate(pem).fingerprint256}`);
    expect(errors).toMatch(/trust this certificate authority/i);
    expect(errors).toContain('security.enterprise_roots.enabled');
  });
  it('--out writes a 0644 file and never overwrites one', async () => {
    await makeCa();
    const out = join(dir, 'pipulse-ca.crt');
    expect(await main(['export-ca', '--out', out], ctx)).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o644);
    expect(await main(['export-ca', '--out', out], ctx)).toBe(1);
  });
  it('--out is 0644 even under the CLI umask 077, and never follows a symlink', async () => {
    await makeCa();
    const out = join(dir, 'under-umask.crt');
    const old = process.umask(0o077);
    try {
      expect(await main(['export-ca', '--out', out], ctx)).toBe(0);
      const target = join(dir, 'victim');
      writeFileSync(target, 'keep');
      symlinkSync(target, join(dir, 'link.crt'));
      expect(await main(['export-ca', '--out', join(dir, 'link.crt')], ctx)).toBe(1);
      expect(readFileSync(target, 'utf8')).toBe('keep');
    } finally {
      process.umask(old);
    }
    expect(statSync(out).mode & 0o777).toBe(0o644);
  });
  it('explains that there is no CA yet', async () => {
    expect(await main(['export-ca'], ctx)).toBe(1);
    expect(ctx.errors.join('\n')).toContain('sudo pipulse tls init');
  });
});
