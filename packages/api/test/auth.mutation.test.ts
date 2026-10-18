import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthConfigError,
  SESSION_TTL_MS,
  clientKey,
  createSessions,
  hashPassword,
  parsePasswordHash,
  readAuthConfig,
  readCookie,
  verifyPassword
} from '../src/auth.js';

const SALT = Buffer.alloc(16, 1).toString('base64');
const HASH = Buffer.alloc(32, 2).toString('base64');
const line = (N: unknown, r: unknown, p: unknown, salt = SALT, hash = HASH, scheme = 'scrypt') =>
  `${scheme}$${N}$${r}$${p}$${salt}$${hash}`;

describe('parsePasswordHash, every check on its own', () => {
  it('accepts the baseline line used by the cases below', () => {
    expect(parsePasswordHash(line(1024, 8, 1)).N).toBe(1024);
  });

  it('refuses a line with more than six fields', () => {
    expect(() => parsePasswordHash(`${line(1024, 8, 1)}$extra`)).toThrow(AuthConfigError);
  });

  it('refuses another scheme', () => {
    expect(() => parsePasswordHash(line(1024, 8, 1, SALT, HASH, 'bcrypt'))).toThrow(
      AuthConfigError
    );
  });

  it('trims whitespace around the line, leading included', () => {
    expect(parsePasswordHash(` ${line(1024, 8, 1)}`).N).toBe(1024);
    expect(parsePasswordHash(`${line(1024, 8, 1)}\n`).p).toBe(1);
  });

  it('refuses parameters that are not positive integers', () => {
    for (const [N, r, p] of [
      ['x', 8, 1],
      [1024, 'x', 1],
      [1024, 8, 'x'],
      [0, 8, 1],
      [1024, 0, 1],
      [1024, 8, 0],
      [1024, 1.5, 1],
      [1024, 8, 1.5],
      [1024, -8, 1],
      [1024, 8, -1]
    ]) {
      expect(() => parsePasswordHash(line(N, r, p)), `${N} ${r} ${p}`).toThrow(AuthConfigError);
    }
  });

  it('refuses an N that is not a power of two', () => {
    expect(() => parsePasswordHash(line(1000, 8, 1))).toThrow(AuthConfigError);
    expect(() => parsePasswordHash(line(1025, 8, 1))).toThrow(AuthConfigError);
  });

  it('wants a salt and a hash of at least 16 bytes each, exactly 16 being enough', () => {
    const short = Buffer.alloc(15, 1).toString('base64');
    expect(() => parsePasswordHash(line(1024, 8, 1, short))).toThrow(AuthConfigError);
    expect(() => parsePasswordHash(line(1024, 8, 1, SALT, short))).toThrow(AuthConfigError);
    const parsed = parsePasswordHash(
      line(1024, 8, 1, SALT, Buffer.alloc(16, 2).toString('base64'))
    );
    expect(parsed.hash.length).toBe(16);
    expect(parsed.salt.length).toBe(16);
  });

  it('allows a file that needs exactly the memory limit, and refuses one byte-block more', () => {
    // 128 * r * (p + N + 2) = 2^28 for N=4, p=2, r=2^18.
    expect(parsePasswordHash(line(4, 2 ** 18, 2)).r).toBe(2 ** 18);
    expect(() => parsePasswordHash(line(4, 2 ** 18, 3))).toThrow(/too much memory/);
  });
});

describe('verifyPassword with the default cost', () => {
  it('lifts scrypt memory limit above Node default, so the production cost verifies', async () => {
    const stored = parsePasswordHash(await hashPassword('pw'));
    expect(stored.N).toBe(2 ** 15);
    expect(await verifyPassword('pw', stored)).toBe(true);
    expect(await verifyPassword('pW', stored)).toBe(false);
    // Twice the default cost needs 64 MiB, beyond Node's own 32 MiB limit.
    const heavy = parsePasswordHash(await hashPassword('pw', { N: 2 ** 16, r: 8, p: 1 }));
    expect(await verifyPassword('pw', heavy)).toBe(true);
  });
});

describe('verifyPassword, the cost in the file', () => {
  it('derives with the file cost, matching an independent scrypt', async () => {
    const salt = Buffer.alloc(16, 7);
    const key = scryptSync('pw', salt, 32, { N: 1024, r: 8, p: 2 });
    const stored = parsePasswordHash(
      line(1024, 8, 2, salt.toString('base64'), key.toString('base64'))
    );
    expect(await verifyPassword('pw', stored)).toBe(true);
  });
});

describe('readAuthConfig, PIPULSE_PROTECT_READS=false', () => {
  it('is a valid value meaning public reads', () => {
    expect(readAuthConfig({ PIPULSE_PROTECT_READS: 'false' })).toEqual({ protectReads: false });
    expect(() => readAuthConfig({ PIPULSE_PROTECT_READS: '' })).toThrow(/true or false/);
  });
});

describe('sessions, edges', () => {
  it('is valid at exactly seven days after last use, not a millisecond later', () => {
    let now = 0;
    const sessions = createSessions({ now: () => now });
    const id = sessions.create();
    now = SESSION_TTL_MS;
    expect(sessions.valid(id)).toBe(true);
    now = SESSION_TTL_MS + SESSION_TTL_MS + 1; // last use was refreshed to SESSION_TTL_MS
    expect(sessions.valid(id)).toBe(false);
  });

  it('drops an expired session for good when it is looked at, even if the clock goes back', () => {
    let now = 0;
    const sessions = createSessions({ now: () => now });
    const id = sessions.create();
    now = SESSION_TTL_MS + 1;
    expect(sessions.valid(id)).toBe(false);
    now = 0;
    expect(sessions.valid(id)).toBe(false);
  });

  it('drops expired sessions when a new one is made, even if the clock goes back', () => {
    let now = 0;
    const sessions = createSessions({ now: () => now });
    const old = sessions.create();
    now = SESSION_TTL_MS + 1;
    sessions.create();
    now = 0;
    expect(sessions.valid(old)).toBe(false);
  });
});

describe('clientKey, exact keys', () => {
  it('spells the /64 from the first four groups', () => {
    expect(clientKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('fe80::abcd:1')).toBe('fe80:0:0:0::/64');
  });

  it('unwraps an IPv4-mapped address only when the whole text is one', () => {
    expect(clientKey('::ffff:10.0.0.12')).toBe('10.0.0.12');
    expect(clientKey('::FFFF:192.168.100.200')).toBe('192.168.100.200');
    expect(clientKey('abcd::ffff:1.2.3.4')).not.toBe('1.2.3.4');
    expect(clientKey('::ffff:1.2.3.4.5')).not.toBe('1.2.3.4');
  });
});

describe('readCookie, edges', () => {
  it('ignores a part with no equals sign or no name', () => {
    expect(readCookie('pipulse_sessionX', 'pipulse_session')).toBeUndefined();
    expect(readCookie('=abc', '')).toBeUndefined();
  });

  it('trims the value', () => {
    expect(readCookie('a=1; pipulse_session= abc ; b=2', 'pipulse_session')).toBe('abc');
  });
});
