import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseState,
  readTlsConfig,
  RELEASE_DEFAULT,
  REFUSE_LINE,
  REFUSE_LINE_CONTAINER,
  TlsConfigError
} from '../src/config.js';
import { tempDir } from './helpers.js';

const noState = () => undefined;
const state = (text: string) => () => text;
const HTTPS_STATE = '{"version":1,"mode":"https"}';
const LEGACY_STATE = '{"version":1,"mode":"legacy-http"}';

describe('parseState', () => {
  it('accepts exactly version 1 with https or legacy-http', () => {
    expect(parseState(HTTPS_STATE)).toEqual({ mode: 'https' });
    expect(parseState(' {"mode": "legacy-http", "version": 1}\n')).toEqual({ mode: 'legacy-http' });
  });

  it.each([
    ['not JSON', '{', /not valid JSON/],
    ['an array', '[]', /JSON object/],
    ['an unknown key', '{"version":1,"mode":"https","extra":true}', /unknown key: extra/],
    ['a duplicate key', '{"version":1,"mode":"legacy-http","mode":"https"}', /duplicate key/],
    ['another version', '{"version":2,"mode":"https"}', /version must be 1/],
    ['another mode', '{"version":1,"mode":"on"}', /mode must be/],
    ['a missing mode', '{"version":1}', /mode must be/]
  ])('refuses %s', (_name, text, message) => {
    expect(() => parseState(text)).toThrow(TlsConfigError);
    expect(() => parseState(text)).toThrow(message);
  });
});

describe('readTlsConfig mode resolution', () => {
  // The spec's test matrix, one row per case.
  it.each([
    ['6b-1, nothing set', 'http', {}, noState, 'http', 'default'],
    ['6b-2 upgraded pre-6b', 'refuse', {}, state(LEGACY_STATE), 'http', 'state'],
    [
      '6b-2 upgraded, PIPULSE_TLS=on',
      'refuse',
      { PIPULSE_TLS: 'on' },
      state(LEGACY_STATE),
      'https',
      'env'
    ],
    ['6b-2 fresh', 'refuse', {}, state(HTTPS_STATE), 'https', 'state'],
    [
      '6b-2 fresh, PIPULSE_TLS=off',
      'refuse',
      { PIPULSE_TLS: 'off' },
      state(HTTPS_STATE),
      'http',
      'env'
    ],
    ['6b-2 compose (sidecar wrote state)', 'refuse', {}, state(HTTPS_STATE), 'https', 'state']
  ] as const)('%s', (_name, releaseDefault, env, readState, mode, modeReason) => {
    const config = readTlsConfig(env, { releaseDefault, readState });
    expect(config.mode).toBe(mode);
    expect(config.modeReason).toBe(modeReason);
  });

  it('6b-2 docker run with no state refuses with the fix line', () => {
    expect(() => readTlsConfig({}, { releaseDefault: 'refuse', readState: noState })).toThrow(
      REFUSE_LINE
    );
  });

  it('in the image the refusal names the compose file, not the Pi command', () => {
    const env = { PIPULSE_IN_CONTAINER: 'true', PIPULSE_TLS_DIR: '/tls' };
    expect(() => readTlsConfig(env, { releaseDefault: 'refuse', readState: noState })).toThrow(
      REFUSE_LINE_CONTAINER
    );
    expect(REFUSE_LINE_CONTAINER).toContain('compose.yaml');
    expect(REFUSE_LINE_CONTAINER).toContain('PIPULSE_TLS=off');
    expect(REFUSE_LINE_CONTAINER).not.toContain('sudo pipulse');
  });

  it('the fix line names the Pi command and the way out', () => {
    expect(REFUSE_LINE).toBe(
      'no HTTPS certificate is set up: set PIPULSE_TLS_CERT and PIPULSE_TLS_KEY (on a Pi install: sudo pipulse tls init), or PIPULSE_TLS=off'
    );
  });

  it('6b-2: an operator certificate alone means HTTPS when nothing else decides', () => {
    const config = readTlsConfig(
      { PIPULSE_TLS_CERT: '/c.pem', PIPULSE_TLS_KEY: '/k.pem' },
      { releaseDefault: 'refuse', readState: noState }
    );
    expect(config).toMatchObject({
      mode: 'https',
      modeReason: 'default',
      source: { kind: 'operator' }
    });
  });

  it('6b-2: state.json still wins over an operator pair (an upgraded 6b-1 install stays on HTTP)', () => {
    const config = readTlsConfig(
      { PIPULSE_TLS_CERT: '/c.pem', PIPULSE_TLS_KEY: '/k.pem' },
      { releaseDefault: 'refuse', readState: state(LEGACY_STATE) }
    );
    expect(config.mode).toBe('http');
  });

  it('6b-2: PIPULSE_TLS=off still wins over an operator pair', () => {
    const config = readTlsConfig(
      { PIPULSE_TLS: 'off', PIPULSE_TLS_CERT: '/c.pem', PIPULSE_TLS_KEY: '/k.pem' },
      { releaseDefault: 'refuse', readState: noState }
    );
    expect(config.mode).toBe('http');
  });

  it('6b-2: half an operator pair is a pair error, not the fix line', () => {
    expect(() =>
      readTlsConfig(
        { PIPULSE_TLS_CERT: '/c.pem' },
        { releaseDefault: 'refuse', readState: noState }
      )
    ).toThrow('PIPULSE_TLS_CERT and PIPULSE_TLS_KEY must be set together');
  });

  it('the release default is refuse', () => {
    expect(RELEASE_DEFAULT).toBe('refuse');
  });

  it('refuses any PIPULSE_TLS other than on/off', () => {
    expect(() =>
      readTlsConfig({ PIPULSE_TLS: 'yes' }, { releaseDefault: 'http', readState: noState })
    ).toThrow('PIPULSE_TLS must be "on" or "off", not "yes"');
  });

  it('refuses a bad state.json even when PIPULSE_TLS decides the mode', () => {
    expect(() =>
      readTlsConfig(
        { PIPULSE_TLS: 'on' },
        { releaseDefault: 'http', readState: state('{"mode":"x"}') }
      )
    ).toThrow(TlsConfigError);
  });

  it('reads state.json from PIPULSE_TLS_DIR', () => {
    const paths: string[] = [];
    readTlsConfig(
      { PIPULSE_TLS_DIR: '/tls' },
      { releaseDefault: 'http', readState: (p) => (paths.push(p), undefined) }
    );
    expect(paths).toEqual(['/tls/state.json']);
  });

  it('remembers the state mode even when the environment overrides it', () => {
    const config = readTlsConfig(
      { PIPULSE_TLS: 'on' },
      { releaseDefault: 'http', readState: state(LEGACY_STATE) }
    );
    expect(config.stateMode).toBe('legacy-http');
  });
});

describe('readTlsConfig state.json read errors', () => {
  const failing = (code: string) => () => {
    throw Object.assign(new Error(`${code}: boom`), { code });
  };

  it('with PIPULSE_TLS set, an unreadable state.json warns and is ignored', () => {
    const config = readTlsConfig(
      { PIPULSE_TLS: 'off', PIPULSE_TLS_DIR: '/etc/pipulse/tls' },
      { releaseDefault: 'http', readState: failing('EACCES') }
    );
    expect(config.mode).toBe('http');
    expect(config.stateMode).toBeUndefined();
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain('/etc/pipulse/tls/state.json');
    expect(config.warnings[0]).toContain('EACCES');
  });

  it('with PIPULSE_TLS unset, an unreadable state.json refuses naming the path and PIPULSE_TLS_DIR', () => {
    const read = () =>
      readTlsConfig(
        { PIPULSE_TLS_DIR: '/etc/pipulse/tls' },
        { releaseDefault: 'http', readState: failing('EACCES') }
      );
    expect(read).toThrow(TlsConfigError);
    expect(read).toThrow(
      /\/etc\/pipulse\/tls\/state\.json can't be read \(EACCES\).*PIPULSE_TLS_DIR/
    );
  });

  it('a missing state.json is not a problem, with or without PIPULSE_TLS', () => {
    for (const env of [{}, { PIPULSE_TLS: 'off' }]) {
      const config = readTlsConfig(env, { releaseDefault: 'http', readState: failing('ENOENT') });
      expect(config.warnings).toEqual([]);
      expect(config.stateMode).toBeUndefined();
    }
  });

  it('a readable but invalid state.json still refuses when PIPULSE_TLS is set, naming the file', () => {
    expect(() =>
      readTlsConfig(
        { PIPULSE_TLS: 'off', PIPULSE_TLS_DIR: '/t' },
        { releaseDefault: 'http', readState: state('{') }
      )
    ).toThrow(/\/t\/state\.json \(PIPULSE_TLS_DIR\): state\.json is not valid JSON/);
  });

  it.skipIf(process.getuid?.() === 0)('through the real reader: chmod 000 behaves the same', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'state.json');
      writeFileSync(file, HTTPS_STATE);
      chmodSync(file, 0o000);
      const config = readTlsConfig(
        { PIPULSE_TLS: 'off', PIPULSE_TLS_DIR: dir },
        { releaseDefault: 'http' }
      );
      expect(config.warnings[0]).toContain('EACCES');
      expect(config.stateMode).toBeUndefined();
      expect(() => readTlsConfig({ PIPULSE_TLS_DIR: dir }, { releaseDefault: 'http' })).toThrow(
        /can't be read \(EACCES\)/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readTlsConfig certificate source', () => {
  const read = (env: NodeJS.ProcessEnv) =>
    readTlsConfig({ PIPULSE_TLS: 'on', ...env }, { releaseDefault: 'http', readState: noState });

  it('uses the operator files when both are set', () => {
    expect(
      read({ PIPULSE_TLS_CERT: '/c.pem', PIPULSE_TLS_KEY: '/k.pem', PIPULSE_TLS_CA: '/ca.pem' })
        .source
    ).toEqual({
      kind: 'operator',
      certPath: '/c.pem',
      keyPath: '/k.pem',
      caPath: '/ca.pem'
    });
    expect(read({ PIPULSE_TLS_CERT: '/c.pem', PIPULSE_TLS_KEY: '/k.pem' }).source).toEqual({
      kind: 'operator',
      certPath: '/c.pem',
      keyPath: '/k.pem'
    });
  });

  it('refuses one of the pair without the other, in either mode', () => {
    expect(() => read({ PIPULSE_TLS_CERT: '/c.pem' })).toThrow(
      'PIPULSE_TLS_CERT and PIPULSE_TLS_KEY must be set together'
    );
    expect(() =>
      readTlsConfig({ PIPULSE_TLS_KEY: '/k.pem' }, { releaseDefault: 'http', readState: noState })
    ).toThrow('must be set together');
  });

  it('falls back to the generated files in the TLS directory', () => {
    expect(read({ PIPULSE_TLS_DIR: '/tls' }).source).toEqual({
      kind: 'generated',
      bundlePath: '/tls/leaf.pem',
      caPath: '/tls/ca.crt'
    });
  });

  it('has no source in HTTP mode', () => {
    expect(
      readTlsConfig({}, { releaseDefault: 'http', readState: noState }).source
    ).toBeUndefined();
  });
});

describe('readTlsConfig other settings', () => {
  const read = (env: NodeJS.ProcessEnv) =>
    readTlsConfig(env, { releaseDefault: 'http', readState: noState });

  it('has safe defaults', () => {
    expect(read({})).toMatchObject({
      requireValid: false,
      names: [],
      clockTrust: false,
      dir: '/etc/pipulse/tls',
      timesyncDir: '/run/systemd/timesync'
    });
  });

  it('parses the optional settings', () => {
    expect(
      read({
        PIPULSE_TLS_REQUIRE_VALID_CERT: 'true',
        PIPULSE_TLS_NAMES: ' Pi.Lan , io.example ,',
        PIPULSE_TLS_CLOCK: 'trust',
        PIPULSE_TLS_TIMESYNC_DIR: '/host-timesync'
      })
    ).toMatchObject({
      requireValid: true,
      names: ['pi.lan', 'io.example'],
      clockTrust: true,
      timesyncDir: '/host-timesync'
    });
  });

  it('refuses unknown values', () => {
    expect(() => read({ PIPULSE_TLS_REQUIRE_VALID_CERT: 'yes' })).toThrow(
      'PIPULSE_TLS_REQUIRE_VALID_CERT must be "true" or "false"'
    );
    expect(() => read({ PIPULSE_TLS_CLOCK: 'always' })).toThrow(
      'PIPULSE_TLS_CLOCK must be "trust" or unset'
    );
  });
});
