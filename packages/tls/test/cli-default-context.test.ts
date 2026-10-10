import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultContext } from '../src/cli.js';

// The context the real `pipulse tls` command runs with. Everything here is the thin glue to
// the operating system, so each piece is checked against the real thing, without side effects.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('defaultContext', () => {
  it('reads the layout lazily, from PIPULSE_TLS_DIR', () => {
    vi.stubEnv('PIPULSE_TLS_DIR', '/etc/example/tls');
    vi.stubEnv('PIPULSE_TLS_CA_DIR', '');
    const ctx = defaultContext(); // nothing is looked up yet
    try {
      expect(ctx.layout.tlsDir).toBe('/etc/example/tls');
      expect(ctx.layout.caRoot).toBe('/etc/example/tls');
    } catch (error) {
      // A machine without the pipulse group (a Mac, a fresh container) says so.
      expect((error as Error).message).toMatch(/no "pipulse" group/);
    }
  });

  it('refuses a relative TLS folder only when the layout is used, so --help still works', () => {
    vi.stubEnv('PIPULSE_TLS_DIR', 'relative/tls');
    const ctx = defaultContext();
    expect(() => ctx.layout).toThrow(/must be an absolute path/);
  });

  it('knows whether it runs in a container and as root', () => {
    vi.stubEnv('PIPULSE_IN_CONTAINER', 'true');
    expect(defaultContext().inContainer).toBe(true);
    vi.stubEnv('PIPULSE_IN_CONTAINER', 'false');
    const ctx = defaultContext();
    expect(ctx.inContainer).toBe(false);
    expect(ctx.isRoot).toBe(process.getuid?.() === 0);
  });

  it('writes lines to stdout and stderr', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const ctx = defaultContext();
    ctx.out('to stdout');
    ctx.err('to stderr');
    expect(out).toHaveBeenCalledWith('to stdout\n');
    expect(err).toHaveBeenCalledWith('to stderr\n');
  });

  it('has a working clock, host name, sleep and interface lookup', async () => {
    const ctx = defaultContext();
    expect(Math.abs(ctx.now() - Date.now())).toBeLessThan(1000);
    expect(ctx.hostname().length).toBeGreaterThan(0);
    const started = Date.now();
    await ctx.sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(typeof ctx.interfaces()).toBe('object');
    expect(Array.isArray(ctx.addresses())).toBe(true);
    expect(['string', 'undefined']).toContain(typeof ctx.candidate?.());
  });

  it('judges the clock from the timesync folder it is given, or trusts it on request', () => {
    vi.stubEnv('PIPULSE_TLS_TIMESYNC_DIR', '/nonexistent/timesync');
    vi.stubEnv('PIPULSE_TLS_CLOCK', 'trust');
    expect(defaultContext().clock(undefined).synced).toBe(true);
    vi.stubEnv('PIPULSE_TLS_CLOCK', '');
    expect(defaultContext().clock(undefined).synced).toBe(false);
  });

  it('fails the restart when systemctl is not there (the command then says so)', async () => {
    await expect(defaultContext().restart()).rejects.toBeDefined();
  });

  it('loads the health check only when asked', async () => {
    const ctx = defaultContext();
    await expect(
      ctx.health({ host: '127.0.0.1', port: 1, tls: false } as never)
    ).resolves.toBeDefined();
  });
});
