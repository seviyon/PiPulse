import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { paths, readState, writeState } from '../src/ca/layout.js';
import { testContext, type TestContext } from './cli-context.js';
import { fixturePath, tempDir } from './helpers.js';

let dir: string;
let ctx: TestContext;
beforeEach(async () => {
  dir = tempDir();
  ctx = testContext(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const errors = (run: TestContext) => run.errors.join('\n');

describe('enable, refusals before anything changes', () => {
  beforeEach(async () => {
    expect(await main(['init'], ctx)).toBe(0);
  });

  it('refuses an incomplete CA and says what is missing', async () => {
    rmSync(paths(ctx.layout).caConstraints);
    const run = testContext(dir);
    expect(await main(['enable', '--yes'], run)).toBe(1);
    expect(errors(run)).toMatch(/the CA is incomplete: .*is missing constraints\.json/);
    expect(readState(run.layout)).not.toBe('https');
  });

  it('refuses a certificate that is missing, pointing at renew --force', async () => {
    rmSync(paths(ctx.layout).bundle);
    const run = testContext(dir);
    expect(await main(['enable', '--yes'], run)).toBe(1);
    expect(errors(run)).toContain(
      'the certificate is not usable (missing): run sudo pipulse tls renew --force'
    );
  });

  it('refuses a certificate the file policy rejects, with the reason', async () => {
    chmodSync(paths(ctx.layout).bundle, 0o644);
    const run = testContext(dir);
    expect(await main(['enable', '--yes'], run)).toBe(1);
    expect(errors(run)).toMatch(/the certificate is not usable \(.*broader than 640/);
  });

  it('refuses an operator certificate that cannot be loaded', async () => {
    const garbage = join(dir, 'garbage.crt');
    writeFileSync(garbage, 'not a certificate');
    const run = testContext(dir);
    run.env['PIPULSE_TLS_CERT'] = garbage;
    run.env['PIPULSE_TLS_KEY'] = fixturePath('leaf.key');
    expect(await main(['enable', '--yes'], run)).toBe(1);
    expect(errors(run)).toMatch(/your certificate can't be served: /);
  });

  it('lists the accepted subnets in the summary when the CA has some', async () => {
    expect(await main(['new-ca', '--subnet', '192.168.1.0/24', '--yes'], ctx)).toBe(0);
    const run = testContext(dir);
    expect(await main(['enable', '--yes'], run)).toBe(0);
    expect(run.lines.join('\n')).toContain('IP scope: 192.168.1.0/24');
  });
});

describe('a settings value that blocks the switch', () => {
  beforeEach(async () => {
    expect(await main(['init'], ctx)).toBe(0);
  });

  it('is reported and the previous state put back, not applied', async () => {
    writeState(ctx.layout, 'legacy-http');
    const run = testContext(dir);
    run.env['PIPULSE_TLS'] = 'maybe';
    expect(await main(['enable', '--yes'], run)).toBe(1);
    expect(errors(run)).toContain('not switching: PIPULSE_TLS must be "on" or "off"');
    expect(readState(run.layout)).toBe('legacy-http');
    expect(run.restarts).toBe(0);
  });

  it('is reported for an install already on https whose settings are unreadable', async () => {
    writeState(ctx.layout, 'https');
    const run = testContext(dir);
    run.env['PIPULSE_TLS'] = 'maybe';
    expect(await main(['enable', '--yes'], run)).toBe(1);
    expect(errors(run)).toContain('not switching: PIPULSE_TLS must be "on" or "off"');
    expect(readState(run.layout)).toBe('https');
  });

  it('notices settings that still resolve to the other mode', async () => {
    writeState(ctx.layout, 'legacy-http');
    const run = testContext(dir);
    run.env['PIPULSE_TLS'] = 'OFF'; // not the exact "off" that enable refuses up front
    const code = await main(['enable', '--yes'], run);
    expect(code).toBe(1);
    expect(errors(run)).toMatch(/not switching: /);
    expect(readState(run.layout)).toBe('legacy-http');
  });
});

describe('a switch whose rollback also fails', () => {
  it('says the restart failed both times, then reports the result of the check', async () => {
    expect(await main(['init'], ctx)).toBe(0);
    writeState(ctx.layout, 'legacy-http');
    const run = testContext(dir, {
      restart: async () => {
        throw new Error('systemctl is not answering');
      }
    });
    expect(await main(['enable', '--yes'], run)).toBe(1);
    const text = errors(run);
    expect(text).toContain('restart failed: systemctl is not answering');
    expect(text).toContain('putting legacy-http back');
    expect(text).toContain('back on legacy-http, which is healthy');
    expect(readState(run.layout)).toBe('legacy-http');
  });
});

describe('disable', () => {
  beforeEach(async () => {
    expect(await main(['init'], ctx)).toBe(0);
    writeState(ctx.layout, 'https');
  });

  it('changes nothing when the question is answered no', async () => {
    const run = testContext(dir, { tty: true, ask: async () => false });
    expect(await main(['disable'], run)).toBe(1);
    expect(errors(run)).toContain('nothing changed');
    expect(readState(run.layout)).toBe('https');
    expect(run.restarts).toBe(0);
  });

  it('in a container writes the state and does not claim a restart happened', async () => {
    const run = testContext(dir, { inContainer: true });
    expect(await main(['disable', '--yes'], run)).toBe(0);
    expect(readState(run.layout)).toBe('legacy-http');
    expect(run.lines.join('\n')).not.toContain('HTTPS is off:');
    expect(run.lines.join('\n')).toContain('restart the server container');
  });
});
