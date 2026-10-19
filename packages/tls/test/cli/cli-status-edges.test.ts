import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import {
  activeLines,
  collectStatus,
  formatStatus,
  type ActiveView,
  type StatusReport
} from '../../src/cli/cmd-status.js';
import { buildConstraints } from '../../src/ca/constraints.js';
import { runTransaction } from '../../src/ca/journal.js';
import { paths, pub } from '../../src/ca/layout.js';
import { prepareWork, stageNewCa, validateStage } from '../../src/ca/material.js';
import { testContext, type TestContext } from '../cli-context.js';
import { fixturePath, tempDir } from '../helpers.js';

let dir: string;
let ctx: TestContext;
beforeEach(() => {
  dir = tempDir();
  ctx = testContext(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function makeCa() {
  prepareWork(ctx.layout);
  const { constraints } = buildConstraints({ hostname: 'io', names: [], subnets: [] });
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

const operatorContext = (cert: string) => {
  const c = testContext(dir);
  c.env['PIPULSE_TLS_CERT'] = cert;
  c.env['PIPULSE_TLS_KEY'] = fixturePath('leaf.key');
  return c;
};
const text = (report: StatusReport, c: TestContext = ctx) => formatStatus(report, c).join('\n');

describe('status of an operator certificate', () => {
  it('reads the certificate from PIPULSE_TLS_CERT and shows no CA', () => {
    const c = operatorContext(fixturePath('leaf.crt'));
    const report = collectStatus(c);
    expect(report.configured.source).toBe('operator');
    expect(report.configured.caCertFingerprint).toBeNull();
    expect(report.configured.leaf?.verifies).toBeNull();
    const out = text(report, c);
    expect(out).toContain('your certificate (PIPULSE_TLS_CERT/PIPULSE_TLS_KEY)');
    expect(out).not.toContain('CA:        ');
    expect(out).not.toContain('Coverage:');
    expect(out).toContain('Certificate: SHA-256');
    expect(out).not.toContain('the served bundle is leaf.pem');
  });

  it('says "none yet" when the certificate file is not there', () => {
    const report = collectStatus(operatorContext(join(dir, 'missing.crt')));
    expect(report.configured.leaf).toBeNull();
    expect(report.configured.leafProblem).toBeNull();
    expect(text(report)).toContain('Certificate: none yet');
  });

  it('shows why a certificate file cannot be read, or parsed', () => {
    const folder = join(dir, 'a-folder');
    mkdirSync(folder);
    const unreadable = collectStatus(operatorContext(folder));
    expect(unreadable.configured.leafProblem).toMatch(/EISDIR/);
    expect(text(unreadable)).toContain(`Certificate: ${unreadable.configured.leafProblem!}`);

    const garbage = join(dir, 'garbage.crt');
    writeFileSync(garbage, 'not a certificate');
    const unparsable = collectStatus(operatorContext(garbage));
    expect(unparsable.configured.leaf).toBeNull();
    expect(unparsable.configured.leafProblem).toMatch(/PIPULSE_TLS_CERT/);
  });
});

describe('status of a generated CA that is damaged', () => {
  it('flags a leaf that does not verify when ca.crt is gone, without a CA problem', async () => {
    await makeCa();
    rmSync(paths(ctx.layout).publicCa);
    const report = collectStatus(ctx);
    expect(report.configured.leaf?.verifies).toBe(false);
    expect(report.configured.caCertFingerprint).toBeNull();
    expect(report.configured.caProblem).toBeNull();
    const out = text(report);
    expect(out).toContain('; does NOT verify against ca.crt');
    expect(out).toContain("(from ca-meta.json: ca.crt can't be read)");
  });

  it('reports a ca.crt that is not a readable file as a CA problem', async () => {
    await makeCa();
    rmSync(paths(ctx.layout).publicCa);
    mkdirSync(paths(ctx.layout).publicCa);
    const report = collectStatus(ctx);
    expect(report.configured.caProblem).toMatch(/EISDIR/);
    expect(report.configured.leaf?.verifies).toBe(false);
  });

  it('shows an unreadable ca-meta.json as the CA line', async () => {
    await makeCa();
    writeFileSync(paths(ctx.layout).meta, 'not json');
    const report = collectStatus(ctx);
    expect(report.configured.ca).toBeNull();
    expect(report.configured.caProblem).not.toBeNull();
    expect(text(report)).toContain(`CA:        ${report.configured.caProblem!}`);
  });

  it('says an unfinished CA change is pending, also when txn.json cannot be parsed', async () => {
    writeFileSync(paths(ctx.layout).txn, 'not json');
    const report = collectStatus(ctx);
    expect(report.configured.journal).toBe('pending');
    expect(text(report)).toContain('Journal:   an unfinished CA change is pending');
  });

  it('ignores a renew-status.json it cannot parse', () => {
    writeFileSync(paths(ctx.layout).renewStatus, 'not json');
    const report = collectStatus(ctx);
    expect(report.renewal).toBeNull();
    expect(text(report)).toMatch(/Last renewal\n {2}none recorded/);
  });

  it('lists backups with a shortened fingerprint', async () => {
    await makeCa();
    const report = collectStatus(ctx);
    report.configured.ca!.backups = [
      { name: 'ca.old-20260101T000000Z', fingerprint: 'AA:'.repeat(32).slice(0, -1), createdAt: 1 }
    ];
    expect(text(report)).toContain(
      `Backups:   ca.old-20260101T000000Z (SHA-256 ${'AA:'.repeat(8).slice(0, 23)}…)`
    );
  });

  it('names a TLS folder that is not the native one', async () => {
    await makeCa();
    const off = testContext(dir, { defaultTlsDir: '/etc/pipulse/tls' });
    expect(text(collectStatus(off), off)).toMatch(/problem: PIPULSE_TLS_DIR=/);
  });
});

describe('the mode line', () => {
  it('reports a PIPULSE_TLS that is neither on nor off, and keeps refusing', () => {
    ctx.env['PIPULSE_TLS'] = 'maybe';
    const report = collectStatus(ctx);
    expect(report.configured.effective).toBe('refuse');
    expect(report.configured.problem).toContain('PIPULSE_TLS must be "on" or "off"');
    expect(report.configured.override).toBeNull();
    expect(text(report)).toContain('problem: PIPULSE_TLS must be "on" or "off"');
  });

  it('points to sudo when a problem mentions unreadable files', () => {
    const report = collectStatus(ctx);
    report.configured.leafProblem = 'EACCES: permission denied';
    expect(text(report)).toContain('Some files are not readable by this user');
    report.configured.leafProblem = 'x is not readable';
    expect(text(report)).toContain('Some files are not readable by this user');
    report.configured.leafProblem = 'something else';
    expect(text(report)).not.toContain('Some files are not readable');
  });
});

describe('validity, clock and renewal lines', () => {
  const withLeaf = async (validity: 'expired' | 'not-yet-valid' | 'expiring-soon' | 'valid') => {
    await makeCa();
    const report = collectStatus(ctx);
    report.configured.leaf!.validity = validity;
    return text(report);
  };
  it('says EXPIRED with the date', async () => {
    expect(await withLeaf('expired')).toMatch(/EXPIRED on \d{4}-\d\d-\d\d \d\d:\d\d/);
  });
  it('asks whether the clock is right for a certificate that is not valid yet', async () => {
    expect(await withLeaf('not-yet-valid')).toMatch(
      /not valid until \d{4}-\d\d-\d\d.* \(is the clock right\?\)/
    );
  });
  it('says renewal is due when expiring soon, and not otherwise', async () => {
    expect(await withLeaf('expiring-soon')).toContain('days left), renewal due');
    expect(await withLeaf('valid')).not.toContain('renewal due');
  });

  it('describes each clock state', () => {
    const report = collectStatus(ctx);
    const clock = (state: StatusReport['configured']['clock']) => {
      report.configured.clock = state;
      return text(report);
    };
    expect(clock({ state: 'synced', trust: false })).toContain('Clock:     synchronized');
    expect(clock({ state: 'unsynced', trust: false })).toContain(
      'not synchronized yet (renewal waits)'
    );
    expect(clock({ state: 'unknown', trust: true })).toContain('trusted (PIPULSE_TLS_CLOCK=trust)');
    expect(clock({ state: 'unknown', trust: false })).toContain(
      'set PIPULSE_TLS_CLOCK=trust if chrony or ntpd keeps it right'
    );
  });

  it('describes each renewal result, with its reason when there is one', () => {
    const report = collectStatus(ctx);
    const renewal = (
      result: 'renewed' | 'not-due' | 'waiting-clock' | 'failed',
      reason?: string
    ) => {
      report.renewal = {
        version: 1,
        lastAttempt: ctx.now(),
        result,
        ...(reason ? { reason } : {})
      };
      return text(report);
    };
    expect(renewal('renewed')).toMatch(/Last renewal\n {2}\d{4}-\d\d-\d\d \d\d:\d\d UTC: renewed$/);
    expect(renewal('not-due')).toContain(': not due');
    expect(renewal('waiting-clock')).toContain(': waiting for clock synchronization');
    expect(renewal('failed', 'EPERM: rename')).toContain(': FAILED (EPERM: rename)');
  });
});

describe('what the running server reports', () => {
  const running = (overrides: object = {}): ActiveView => ({
    state: 'running',
    status: {
      version: 1,
      transport: 'https',
      certificate: {
        source: 'operator',
        fingerprint: 'AA:BB',
        class: 'valid',
        notAfter: Date.UTC(2027, 0, 1),
        reload: { state: 'ok', lastError: null, lastAttempt: 1 }
      },
      pid: 42,
      startTime: '1',
      bootId: 'b',
      writtenAt: 1,
      ...overrides
    }
  });

  it('shows the served certificate and its reload state', () => {
    expect(activeLines(running())).toEqual([
      '  HTTPS, pid 42',
      '  serving SHA-256 AA:BB (operator, valid, valid until 2027-01-01 00:00 UTC)',
      '  reload: ok'
    ]);
  });

  it('shows the last reload error, with control characters replaced', () => {
    const view = running();
    if (view.state === 'running' && view.status.certificate)
      view.status.certificate.reload = {
        state: 'failing',
        lastError: 'bad\u001b[31m cert',
        lastAttempt: 1
      };
    const lines = activeLines(view);
    expect(lines[2]).toMatch(/^ {2}reload: failing: bad.*\[31m cert$/);
    expect(lines[2]).not.toContain('\u001b');
  });

  it('shows plain HTTP with no certificate lines', () => {
    expect(activeLines(running({ transport: 'http', certificate: null }))).toEqual([
      '  HTTP, pid 42'
    ]);
  });

  it('shows each way the server can be absent or unreadable', () => {
    expect(activeLines({ state: 'not-running', reason: 'stale-pid' })).toEqual([
      '  not running (stale-pid)'
    ]);
    expect(activeLines({ state: 'status-file-corrupt', problem: 'x is too large' })).toEqual([
      '  status-file-corrupt: x is too large'
    ]);
    expect(activeLines({ state: 'unknown', problem: 'x: EACCES' })).toEqual([
      '  unknown: x: EACCES'
    ]);
  });
});

describe('status arguments', () => {
  it('rejects an option it does not know', async () => {
    expect(await main(['status', '--bogus'], ctx)).toBe(2);
  });
});
