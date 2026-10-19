import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUNTIME_DIR, REFUSE_LINE, hostName } from '@pipulse/tls';
import { loadConfig, refuse, StartupError } from '../src/config.js';

vi.mock('../src/version.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/version.js')>();
  return { ...actual, readVersion: vi.fn(actual.readVersion) };
});
const { readVersion } = await import('../src/version.js');

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const base = (): NodeJS.ProcessEnv => {
  dir = mkdtempSync(join(tmpdir(), 'pipulse-config-'));
  return {
    PIPULSE_DB_PATH: join(dir, 'p.sqlite'),
    PIPULSE_TLS: 'off',
    PIPULSE_TLS_DIR: join(dir, 'tls')
  };
};

describe('loadConfig', () => {
  it('reads the defaults', () => {
    const config = loadConfig(base());
    expect(config.port).toBe(8889);
    expect(config.host).toBe('0.0.0.0');
    expect(config.allowedOrigins).toEqual([]);
    expect(config.allowedHosts).toEqual([]);
    expect(config.inContainer).toBe(false);
    expect(config.hstsSeconds).toBeUndefined();
    expect(config.tls.mode).toBe('http');
    expect(config.auth.protectReads).toBe(false);
  });

  it('reads every setting it owns', () => {
    const config = loadConfig({
      ...base(),
      PIPULSE_HOST: '127.0.0.1',
      PIPULSE_PORT: '0',
      PIPULSE_ALLOWED_ORIGINS: ' https://a.lan , ,https://b.lan ',
      PIPULSE_ALLOWED_HOSTS: 'io.lan',
      PIPULSE_IN_CONTAINER: 'true',
      PIPULSE_HOST_ROOT: '/host',
      PIPULSE_WEB_DIR: '/srv/web',
      PIPULSE_RUNTIME_DIR: '/run/x',
      PIPULSE_ALERTS_FILE: '/a.json',
      PIPULSE_NOTIFY_FILE: '/n.json'
    });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: ['https://a.lan', 'https://b.lan'],
      inContainer: true,
      hostRoot: '/host',
      webDir: '/srv/web',
      runtimeDir: '/run/x',
      alertsFile: '/a.json',
      notifyFile: '/n.json'
    });
    expect(config.allowedHosts).toContain('io.lan');
  });

  it('keeps the database in the working folder unless told otherwise', () => {
    const env = base();
    delete env['PIPULSE_DB_PATH'];
    expect(loadConfig(env).dbPath).toBe('pipulse.sqlite');
    expect(loadConfig({ ...env, PIPULSE_DB_PATH: '/data/p.sqlite' }).dbPath).toBe('/data/p.sqlite');
  });

  it('turns an empty PIPULSE_PORT into 8889 and keeps the rest of the table', () => {
    expect(loadConfig({ ...base(), PIPULSE_PORT: '' }).port).toBe(8889);
  });

  it('puts the TLS warnings in `warnings`, already prefixed, and prints nothing', () => {
    const config = loadConfig({
      ...base(),
      PIPULSE_TLS_CERT: '/x.pem',
      PIPULSE_TLS_KEY: '/x.key'
    });
    expect(config.warnings).toContain(
      '[pipulse] warning: PIPULSE_TLS_CERT/PIPULSE_TLS_KEY are set but HTTPS is off (set PIPULSE_TLS=on)'
    );
  });

  it('leaves nothing behind: no database, no TLS folder, no file at all', () => {
    const env = base();
    loadConfig(env);
    expect(readdirSync(dir)).toEqual([]);
  });
});

// Every refusal, as the running server prints it after "[pipulse] ". Copied from Step 1's output.
const REFUSALS: Array<{ name: string; env: Record<string, string>; message: RegExp }> = [
  {
    name: 'a port that is not a number',
    env: { PIPULSE_PORT: 'abc' },
    message: /^PIPULSE_PORT must be a port number from 0 to 65535, not "abc"$/
  },
  {
    name: 'an allowed host that is not a host name',
    env: { PIPULSE_ALLOWED_HOSTS: 'bad_name' },
    message:
      /^PIPULSE_ALLOWED_HOSTS: "bad_name" is not a host name \(no ports, schemes or wildcards\)$/
  },
  {
    name: 'raw retention of 10m (minutes or months?)',
    env: { PIPULSE_RETENTION_RAW: '10m' },
    message:
      /^PIPULSE_RETENTION_RAW must be a duration like 30s, 5min, 36h, 14d, 2w, 1y or forever \(got "10m"\)$/
  },
  {
    name: 'one-minute retention that is not a duration',
    env: { PIPULSE_RETENTION_1M: 'nope' },
    message:
      /^PIPULSE_RETENTION_1M must be a duration like 30s, 5min, 36h, 14d, 2w, 1y or forever \(got "nope"\)$/
  },
  {
    name: 'PIPULSE_PROTECT_READS that is not a boolean',
    env: { PIPULSE_PROTECT_READS: 'maybe' },
    message: /^PIPULSE_PROTECT_READS must be true or false \(got "maybe"\)$/
  },
  {
    name: 'a password hash file that cannot be read',
    env: { PIPULSE_ADMIN_PASSWORD_HASH_FILE: '/nonexistent' },
    message: /^PIPULSE_ADMIN_PASSWORD_HASH_FILE \/nonexistent could not be read: ENOENT$/
  },
  {
    name: 'PIPULSE_TLS that is neither on nor off',
    env: { PIPULSE_TLS: 'bogus' },
    message: /^PIPULSE_TLS must be "on" or "off", not "bogus"$/
  },
  {
    name: 'an HSTS duration of forever (HTTPS on)',
    env: { PIPULSE_TLS: 'on', PIPULSE_TLS_HSTS: 'forever' },
    message: /^PIPULSE_TLS_HSTS must be a finite duration, not forever$/
  }
];

describe('loadConfig refuses with one line', () => {
  for (const { name, env, message } of REFUSALS) {
    it(name, () => {
      let error: unknown;
      try {
        loadConfig({ ...base(), ...env });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(StartupError);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain('\n');
    });
  }

  it('refuses a release default with neither a certificate nor PIPULSE_TLS=off', () => {
    const env = base();
    delete env['PIPULSE_TLS'];
    expect(() => loadConfig(env)).toThrow(REFUSE_LINE);
  });
});

describe('PIPULSE_TLS_HSTS', () => {
  const fixtures = resolve(import.meta.dirname, '../../tls/test/fixtures');
  const https = (): NodeJS.ProcessEnv => ({
    ...base(),
    PIPULSE_TLS: 'on',
    PIPULSE_TLS_CERT: join(fixtures, 'leaf.crt'),
    PIPULSE_TLS_KEY: join(fixtures, 'leaf.key')
  });

  it('is whole seconds, with HTTPS on', () => {
    expect(loadConfig({ ...https(), PIPULSE_TLS_HSTS: '2d' }).hstsSeconds).toBe(172800);
    expect(loadConfig({ ...https(), PIPULSE_TLS_HSTS: '90s' }).hstsSeconds).toBe(90);
  });

  it('is absent when unset or blank', () => {
    expect(loadConfig(https()).hstsSeconds).toBeUndefined();
    expect(loadConfig({ ...https(), PIPULSE_TLS_HSTS: '  ' }).hstsSeconds).toBeUndefined();
  });

  it('is ignored with a warning when HTTPS is off', () => {
    const config = loadConfig({ ...base(), PIPULSE_TLS_HSTS: '1d' });
    expect(config.hstsSeconds).toBeUndefined();
    expect(config.warnings).toContain('[pipulse] PIPULSE_TLS_HSTS is ignored: HTTPS is off');
  });

  it('refuses a duration that is not a duration', () => {
    expect(() => loadConfig({ ...https(), PIPULSE_TLS_HSTS: 'soon' })).toThrow(
      /^PIPULSE_TLS_HSTS must be a duration/
    );
  });
});

describe('refuse', () => {
  it('turns an Error into a StartupError with its message', () => {
    expect(() =>
      refuse(() => {
        throw new Error('bad');
      })
    ).toThrow(expect.objectContaining({ name: 'StartupError', message: 'bad' }));
  });

  it('turns anything else thrown into its text', () => {
    expect(() =>
      refuse(() => {
        throw 'plain text';
      })
    ).toThrow(expect.objectContaining({ name: 'StartupError', message: 'plain text' }));
  });

  it('passes a result through', () => {
    expect(refuse(() => 7)).toBe(7);
  });
});

describe('loadConfig, the details', () => {
  const warningsFor = (extra: Record<string, string>) =>
    loadConfig({ ...base(), ...extra }).warnings;
  const UNUSED =
    '[pipulse] warning: PIPULSE_TLS_CERT/PIPULSE_TLS_KEY are set but HTTPS is off (set PIPULSE_TLS=on)';

  it('has no warnings by default', () => {
    expect(loadConfig(base()).warnings).toEqual([]);
  });

  it('prefixes the TLS settings warnings', () => {
    const env = base();
    mkdirSync(env['PIPULSE_TLS_DIR']!, { recursive: true });
    writeFileSync(join(env['PIPULSE_TLS_DIR']!, 'state.json'), 'not json');
    const warnings = loadConfig(env).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^\[pipulse\] warning: .*state\.json \(PIPULSE_TLS_DIR\): .*; ignoring it because PIPULSE_TLS=off$/
    );
  });

  it.each([
    // One of the two alone is refused earlier ("must be set together"), so `||` vs `&&` cannot show.
    ['both', { PIPULSE_TLS_CERT: '/x.pem', PIPULSE_TLS_KEY: '/x.key' }]
  ])('warns that %s is set while HTTPS is off', (_, extra) => {
    expect(warningsFor(extra)).toEqual([UNUSED]);
  });

  it.each([
    ['blank values', { PIPULSE_TLS_CERT: '  ', PIPULSE_TLS_KEY: '\t' }],
    ['none', {}]
  ])('does not warn about %s', (_, extra) => {
    expect(warningsFor(extra)).toEqual([]);
  });

  it('does not warn about a certificate and key that HTTPS uses', () => {
    const fixtures = resolve(import.meta.dirname, '../../tls/test/fixtures');
    expect(
      warningsFor({
        PIPULSE_TLS: 'on',
        PIPULSE_TLS_CERT: join(fixtures, 'leaf.crt'),
        PIPULSE_TLS_KEY: join(fixtures, 'leaf.key')
      })
    ).not.toContain(UNUSED);
  });

  it("adds the host's own names and PIPULSE_TLS_NAMES to a list that is set, and nothing to one that is not", () => {
    const set = loadConfig({
      ...base(),
      PIPULSE_ALLOWED_HOSTS: 'io.lan',
      PIPULSE_TLS_NAMES: 'pi.example'
    }).allowedHosts;
    expect(set).toEqual(
      expect.arrayContaining([
        'io.lan',
        hostName().toLowerCase(),
        `${hostName().toLowerCase()}.local`,
        'pi.example'
      ])
    );
    expect(loadConfig(base()).allowedHosts).toEqual([]);
  });

  it("serves the dashboard from the web package's build by default", () => {
    expect(loadConfig(base()).webDir).toBe(resolve(import.meta.dirname, '../../web/dist'));
  });

  it('has no hstsSeconds key unless HSTS is on', () => {
    expect(loadConfig(base())).not.toHaveProperty('hstsSeconds');
  });

  it('keeps the runtime folder from the environment, trimmed, and falls back for a blank one', () => {
    expect(loadConfig({ ...base(), PIPULSE_RUNTIME_DIR: '  /run/x  ' }).runtimeDir).toBe('/run/x');
    expect(loadConfig({ ...base(), PIPULSE_RUNTIME_DIR: '   ' }).runtimeDir).toBe(
      DEFAULT_RUNTIME_DIR
    );
    expect(loadConfig(base()).runtimeDir).toBe(DEFAULT_RUNTIME_DIR);
  });

  it('reads the release version from the app root, three levels above the package source', () => {
    loadConfig(base());
    const root = resolve(import.meta.dirname, '../../..');
    expect(resolve(vi.mocked(readVersion).mock.calls.at(-1)![0])).toBe(root);
  });
});
