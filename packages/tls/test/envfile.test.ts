import { describe, expect, it } from 'vitest';
import { parseEnvFile, settingsEnv } from '../src/envfile.js';

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines the way systemd and install.sh do: last wins, quotes removed', () => {
    const text = [
      '# comment',
      '; also a comment',
      '',
      'PIPULSE_PORT=8889',
      'PIPULSE_TLS_NAMES="io.lan, io.local"',
      "PIPULSE_TLS_CLOCK='trust'",
      'PIPULSE_PORT=9000',
      'not a setting',
      '1BAD=x',
      'PIPULSE_HOST = 0.0.0.0\r'
    ].join('\n');
    expect(parseEnvFile(text)).toEqual({
      PIPULSE_PORT: '9000',
      PIPULSE_TLS_NAMES: 'io.lan, io.local',
      PIPULSE_TLS_CLOCK: 'trust',
      PIPULSE_HOST: '0.0.0.0'
    });
  });
  it('never evaluates anything', () => {
    expect(parseEnvFile('A=$(reboot)\nB=`id`')).toEqual({ A: '$(reboot)', B: '`id`' });
  });
});

describe('settingsEnv', () => {
  it('uses the file for anything the environment does not set', () => {
    const env = settingsEnv(
      { PIPULSE_TLS_DIR: '/tmp/tls' },
      { read: () => 'PIPULSE_TLS_DIR=/etc/x\nPIPULSE_TLS_NAMES=io.lan' }
    );
    expect(env['PIPULSE_TLS_DIR']).toBe('/tmp/tls');
    expect(env['PIPULSE_TLS_NAMES']).toBe('io.lan');
  });
  it('works without the file (the renew unit hides /etc/pipulse; systemd already loaded it)', () => {
    const env = settingsEnv(
      { PIPULSE_TLS_NAMES: 'a' },
      {
        read: () => {
          throw Object.assign(new Error('hidden'), { code: 'ENOENT' });
        }
      }
    );
    expect(env['PIPULSE_TLS_NAMES']).toBe('a');
  });
  const failing = (code: string) => ({
    read: () => {
      throw Object.assign(new Error('boom'), { code });
    }
  });
  it('refuses an unreadable file when nothing in the environment says what to do', () => {
    expect(() => settingsEnv({}, failing('EACCES'))).toThrow(/can't read .*EACCES/);
    expect(() => settingsEnv({ PATH: '/usr/bin' }, failing('EPERM'))).toThrow(/EPERM/);
  });
  it('accepts a hidden file when systemd or Docker already loaded PIPULSE_TLS', () => {
    expect(settingsEnv({ PIPULSE_TLS: 'off' }, failing('EACCES'))['PIPULSE_TLS']).toBe('off');
  });
  it('never swallows other read errors, even with PIPULSE_TLS set', () => {
    expect(() => settingsEnv({ PIPULSE_TLS: 'off' }, failing('EIO'))).toThrow(/EIO/);
    expect(() => settingsEnv({ PIPULSE_TLS: 'off' }, failing('EISDIR'))).toThrow(/EISDIR/);
  });
});
