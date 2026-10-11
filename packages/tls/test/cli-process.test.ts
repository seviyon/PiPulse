import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { testContext, type TestContext } from './cli-context.js';
import { tempDir } from './helpers.js';

let dir: string;
let ctx: TestContext;
beforeEach(() => {
  dir = tempDir();
  ctx = testContext(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('help and the sidecar commands, through main', () => {
  it('prints the usage for help and --help, exit 0', async () => {
    for (const word of ['help', '--help']) {
      const run = testContext(dir);
      expect(await main([word], run)).toBe(0);
      expect(run.lines.join('\n')).toMatch(/usage: pipulse tls/);
    }
  });

  it('dispatches sidecar-init, sidecar-health and sidecar', async () => {
    expect(await main(['sidecar-init'], ctx)).toBe(0);
    expect(ctx.lines.join('\n')).toMatch(/root:pipulse 2750/);
    const health = testContext(dir);
    expect(await main(['sidecar-health'], health)).toBe(1); // no ready file yet
    const run = testContext(dir);
    expect(await main(['sidecar', '--bogus'], run)).toBe(2); // refused before it starts
  });
});

// The entry point itself: wired only when the file is run, so it needs a real process.
const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
describe.skipIf(!existsSync(entry))('the built command, as a process', () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        PIPULSE_TLS_DIR: join(dir, 'tls'),
        PIPULSE_RUNTIME_DIR: join(dir, 'run')
      }
    });

  it('prints help and exits 0 without needing any settings', () => {
    const result = run('help');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/usage: pipulse tls/);
  });

  it('turns an unknown command into the usage and exit status 2', () => {
    const result = run('frobnicate');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown command: frobnicate[\s\S]*usage: pipulse tls/);
  });

  it('exits 1 with one line, not a stack trace, for a root-only command without root', () => {
    if (process.getuid?.() === 0) return;
    const result = run('init');
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split('\n')).toEqual([
      'pipulse tls init needs root: sudo pipulse tls init'
    ]);
  });

  it('ends a context problem (no pipulse group, as on a machine PiPulse is not installed on) as one line', () => {
    const result = run('export-ca');
    if (result.status === 0) return; // the group exists here: nothing to provoke
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toMatch(/^pipulse tls: /);
  });

  it('is not killed by a reader that closes the pipe early', () => {
    const result = spawnSync(
      'sh',
      ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} help | head -n 1`],
      {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '', PIPULSE_TLS_DIR: join(dir, 'tls') }
      }
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/usage: pipulse tls/);
  });
});
