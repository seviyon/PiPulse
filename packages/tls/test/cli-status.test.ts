import { X509Certificate } from 'node:crypto';
import { readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, ignoreClosedPipe, lockFor, main } from '../src/cli.js';
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
  it('describes an install with nothing generated yet', async () => {
    expect(await main(['status'], ctx)).toBe(0);
    const text = ctx.lines.join('\n');
    expect(text).toContain(`Configured (${dir})`);
    expect(text).toMatch(/Mode: +HTTP — not chosen \(no state\.json\)/);
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
