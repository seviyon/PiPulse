import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { paths, readState, writeState } from '../src/layout.js';
import { testContext, type TestContext } from './cli-context.js';
import { tempDir } from './helpers.js';

let dir: string;
let ctx: TestContext;
beforeEach(() => {
  dir = tempDir();
  ctx = testContext(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('enable', () => {
  it('refuses without a CA', async () => {
    expect(await main(['enable', '--yes'], ctx)).toBe(1);
    expect(ctx.errors.join('\n')).toContain('sudo pipulse tls init');
  });

  it('switches to HTTPS, restarts, checks health, and says what changed', async () => {
    await main(['init'], ctx);
    const run = testContext(dir);
    expect(await main(['enable', '--yes'], run)).toBe(0);
    expect(readState(ctx.layout)).toBe('https');
    expect(run.restarts).toBe(1);
    const text = run.lines.join('\n');
    expect(text).toContain('https://io:8889');
    expect(text).toContain('Old http:// bookmarks now fail');
    expect(text).toMatch(/CA SHA-256/);
  });

  it('puts the previous mode back when HTTPS does not come up healthy', async () => {
    await main(['init'], ctx);
    writeState(ctx.layout, 'legacy-http');
    let calls = 0;
    const run = testContext(dir, {
      health: async () =>
        calls++ === 0
          ? { code: 2, message: 'TLS verification failed: CERT_HAS_EXPIRED' }
          : { code: 0, message: 'healthy' }
    });
    expect(await main(['enable', '--yes'], run)).toBe(1);
    expect(readState(ctx.layout)).toBe('legacy-http');
    expect(run.restarts).toBe(2);
    expect(run.errors.join('\n')).toMatch(
      /CERT_HAS_EXPIRED[\s\S]*back on legacy-http, which is healthy/
    );
  });

  it('removes state.json again when there was none, and gives up waiting after 30 s', async () => {
    await main(['init'], ctx);
    const run = testContext(dir, { health: async () => ({ code: 1, message: 'not answering' }) });
    expect(await main(['enable', '--yes'], run)).toBe(1);
    expect(existsSync(paths(ctx.layout).state)).toBe(false);
  });

  it('treats a failing restart as a failed switch: the old mode goes back, restarted and checked', async () => {
    await main(['init'], ctx);
    writeState(ctx.layout, 'legacy-http');
    let restarts = 0;
    const run = testContext(dir, {
      restart: async () => {
        if (restarts++ === 0) throw new Error('Job for pipulse.service failed');
      }
    });
    expect(await main(['enable', '--yes'], run)).toBe(1);
    expect(readState(ctx.layout)).toBe('legacy-http');
    expect(restarts).toBe(2);
    expect(run.errors.join('\n')).toMatch(
      /restart failed: Job for pipulse.service failed[\s\S]*back on legacy-http, which is healthy/
    );
  });

  it('refuses while PIPULSE_TLS=off would override it', async () => {
    await main(['init'], ctx);
    const run = testContext(dir);
    run.env['PIPULSE_TLS'] = 'off';
    expect(await main(['enable', '--yes'], run)).toBe(1);
    expect(run.errors.join('\n')).toContain('PIPULSE_TLS=off');
    expect(readState(ctx.layout)).toBeUndefined();
  });

  it('in a container writes the state and asks for a restart instead', async () => {
    await main(['init'], ctx);
    const run = testContext(dir, { inContainer: true });
    expect(await main(['enable', '--yes'], run)).toBe(0);
    expect(run.restarts).toBe(0);
    expect(run.lines.join('\n')).toContain('docker compose restart pipulse');
  });
});

describe('enable over a certificate browsers would refuse', () => {
  const DAY = 86_400_000;

  it('refuses an expired generated certificate and changes nothing', async () => {
    await main(['init'], ctx);
    const later = testContext(dir);
    later.setNow(ctx.now() + 100 * DAY);
    expect(await main(['enable', '--yes'], later)).toBe(1);
    expect(later.errors.join('\n')).toMatch(/the certificate expired on .*renew --force/);
    expect(readState(ctx.layout)).toBeUndefined();
    expect(later.restarts).toBe(0);
  });

  it('refuses a certificate that is not valid yet, pointing at the clock', async () => {
    await main(['init'], ctx);
    const earlier = testContext(dir);
    earlier.setNow(ctx.now() - 10 * DAY);
    expect(await main(['enable', '--yes'], earlier)).toBe(1);
    expect(earlier.errors.join('\n')).toMatch(/not valid until .*clock/);
    expect(readState(ctx.layout)).toBeUndefined();
  });
});

describe('a refused TLS folder', () => {
  it('is not touched by enable or disable (no recovery, no temp-file cleanup)', async () => {
    mkdirSync(join(dir, 'default'));
    const stray = join(dir, '.leaf.pem.0123456789abcdef.tmp');
    writeFileSync(stray, 'x');
    const native = testContext(dir, { defaultTlsDir: join(dir, 'default') });
    expect(await main(['enable', '--yes'], native)).toBe(1);
    // disable only writes state.json (where the server reads it): allowed, but it runs no recovery.
    expect(await main(['disable', '--yes'], native)).toBe(0);
    expect(existsSync(stray)).toBe(true);
  });
});

describe('disable', () => {
  it('needs --allow-insecure when sign-in is configured', async () => {
    writeState(ctx.layout, 'https');
    ctx.env['PIPULSE_ADMIN_PASSWORD_HASH_FILE'] = '/etc/pipulse/admin.hash';
    expect(await main(['disable', '--yes'], ctx)).toBe(1);
    expect(ctx.errors.join('\n')).toContain('--allow-insecure');
    expect(readState(ctx.layout)).toBe('https');
    expect(await main(['disable', '--yes', '--allow-insecure'], ctx)).toBe(0);
    expect(readState(ctx.layout)).toBe('legacy-http');
  });

  it('keeps the certificates and rolls back if HTTP does not come up', async () => {
    await main(['init'], ctx);
    writeState(ctx.layout, 'https');
    const run = testContext(dir, { health: async () => ({ code: 1, message: 'not answering' }) });
    expect(await main(['disable', '--yes'], run)).toBe(1);
    expect(readState(ctx.layout)).toBe('https');
    expect(existsSync(paths(ctx.layout).bundle)).toBe(true);
  });

  it('refuses while PIPULSE_TLS=on would override it', async () => {
    writeState(ctx.layout, 'https');
    ctx.env['PIPULSE_TLS'] = 'on';
    expect(await main(['disable', '--yes'], ctx)).toBe(1);
  });
});
