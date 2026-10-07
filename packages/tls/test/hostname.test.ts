import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { hostName } from '../src/hostname.js';

describe('hostName', () => {
  it('prefers PIPULSE_HOSTNAME', () => {
    expect(hostName({ PIPULSE_HOSTNAME: 'io', PIPULSE_HOST_ROOT: '/host' }, () => 'other\n')).toBe(
      'io'
    );
  });
  it('reads the mounted host file', () => {
    const read = (path: string) => (path === '/host/etc/hostname' ? 'Io\n' : '');
    expect(hostName({ PIPULSE_HOST_ROOT: '/host' }, read)).toBe('Io');
  });
  it('falls back when the file is missing or not a name', () => {
    const missing = () => {
      throw new Error('ENOENT');
    };
    expect(hostName({ PIPULSE_HOST_ROOT: '/host' }, missing)).toBe(hostname());
    expect(hostName({ PIPULSE_HOST_ROOT: '/host' }, () => 'a b\n')).toBe(hostname());
    expect(hostName({ PIPULSE_HOSTNAME: '../x' }, missing)).toBe(hostname());
  });
});
