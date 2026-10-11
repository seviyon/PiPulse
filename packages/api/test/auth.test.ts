import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AuthConfigError,
  checkNewPassword,
  clearedSessionCookie,
  clientKey,
  createLoginLimiter,
  createSessions,
  hashPassword,
  parsePasswordHash,
  readCookie,
  readAuthConfig,
  readPasswordHashFile,
  sessionCookie,
  verifyPassword
} from '../src/auth.js';

/** Cheap enough for tests; production uses DEFAULT_COST. */
const CHEAP = { N: 1024, r: 8, p: 1 };
const DAY = 86_400_000;

describe('password hashes', () => {
  it('verifies the right password only, byte for byte', async () => {
    const stored = parsePasswordHash(await hashPassword(' Contraseña ', CHEAP));
    expect(await verifyPassword(' Contraseña ', stored)).toBe(true);
    // The same word written with a combining accent: NFC makes them equal.
    expect(await verifyPassword(' Contraseña ', stored)).toBe(true);
    expect(await verifyPassword('Contraseña', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('writes the documented format with the default cost', async () => {
    const line = await hashPassword('x');
    expect(line).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
  });

  it('reads a hash file with a CRLF or trailing newline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipulse-'));
    const path = join(dir, 'hash');
    writeFileSync(path, `${await hashPassword('pw', CHEAP)}\r\n`);
    expect(await verifyPassword('pw', readPasswordHashFile(path))).toBe(true);
  });

  it('explains a missing or malformed file in one line naming the variable and path', () => {
    expect(() => readPasswordHashFile('/nonexistent/hash')).toThrow(
      /^PIPULSE_ADMIN_PASSWORD_HASH_FILE \/nonexistent\/hash could not be read: ENOENT$/
    );
    const path = join(mkdtempSync(join(tmpdir(), 'pipulse-')), 'hash');
    writeFileSync(path, 'hunter2\n');
    expect(() => readPasswordHashFile(path)).toThrow(AuthConfigError);
    expect(() => readPasswordHashFile(path)).toThrow(/is not a PiPulse password hash/);
    expect(() => parsePasswordHash('scrypt$1000$8$1$AAAA$AAAA')).toThrow(AuthConfigError);
  });

  it('refuses scrypt parameters that exceed the memory limit when the file is read, not at every sign-in', () => {
    // Node's scrypt throws "memory limit exceeded" for these: the service would start and then
    // answer every sign-in with a 500 carrying OpenSSL's text.
    const tail = `${Buffer.alloc(16, 1).toString('base64')}$${Buffer.alloc(32, 2).toString('base64')}`;
    for (const [N, r, p] of [
      [2 ** 20, 8, 1],
      [2 ** 15, 8, 1_000_000],
      [2 ** 15, 1 << 20, 1],
      [2 ** 18, 8, 1]
    ]) {
      expect(() => parsePasswordHash(`scrypt$${N}$${r}$${p}$${tail}`)).toThrow(
        /is not a PiPulse password hash|too much memory/
      );
    }
    expect(() => parsePasswordHash(`scrypt$${2 ** 20}$8$1$${tail}`)).toThrow(/too much memory/);
    // What hash-password makes today is fine, and so is a cheaper file from tests or older runs.
    expect(parsePasswordHash(`scrypt$${2 ** 15}$8$1$${tail}`).N).toBe(2 ** 15);
    expect(parsePasswordHash(`scrypt$${2 ** 14}$8$4$${tail}`).p).toBe(4);
  });

  it('refuses an empty or mismatched new password', () => {
    expect(checkNewPassword('', '')).toMatch(/empty/);
    expect(checkNewPassword('a', 'b')).toMatch(/did not match/);
    expect(checkNewPassword('same', 'same')).toBeUndefined();
  });
});

describe('sessions', () => {
  it('creates unguessable ids that expire seven days after last use', () => {
    let now = 0;
    const sessions = createSessions({ now: () => now });
    const id = sessions.create();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessions.create()).not.toBe(id);
    now = 6 * DAY;
    expect(sessions.valid(id)).toBe(true); // refreshes last use
    now = 12 * DAY;
    expect(sessions.valid(id)).toBe(true);
    now = 19 * DAY + 1;
    expect(sessions.valid(id)).toBe(false);
    expect(sessions.valid(undefined)).toBe(false);
    expect(sessions.valid('forged')).toBe(false);
  });

  it('ends a session', () => {
    const sessions = createSessions();
    const id = sessions.create();
    sessions.end(id);
    expect(sessions.valid(id)).toBe(false);
  });
});

describe('sessions, the cookie that carries them', () => {
  it('asks for the cookie to be sent again once a day, so it lives as long as the session', () => {
    let now = 0;
    const sessions = createSessions({ now: () => now });
    const id = sessions.create();
    expect(sessions.cookieDue(id)).toBe(false); // it was just sent with the sign-in
    now = DAY - 1;
    expect(sessions.cookieDue(id)).toBe(false);
    now = DAY;
    expect(sessions.cookieDue(id)).toBe(true);
    expect(sessions.cookieDue(id)).toBe(false); // once per day, not on every request
    now = 2 * DAY;
    expect(sessions.cookieDue(id)).toBe(true);
    expect(sessions.cookieDue('forged')).toBe(false);
    expect(sessions.cookieDue(undefined)).toBe(false);
  });
});

describe('clientKey', () => {
  it('is the address for IPv4, and the /64 for IPv6, so one host cannot rotate addresses', () => {
    expect(clientKey('10.0.0.2')).toBe('10.0.0.2');
    expect(clientKey('::ffff:10.0.0.2')).toBe('10.0.0.2');
    expect(clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(clientKey('2001:db8:1:2::1'));
    expect(clientKey('2001:DB8:1:2::1')).toBe(clientKey('2001:db8:1:2:0:0:0:1'));
    expect(clientKey('2001:db8:1:3::1')).not.toBe(clientKey('2001:db8:1:2::1'));
    expect(clientKey('fe80::1%eth0')).toBe(clientKey('fe80::2'));
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
  });

  it('leaves what is not an address alone', () => {
    expect(clientKey('unknown')).toBe('unknown');
  });
});

describe('createLoginLimiter', () => {
  it('blocks an address after five failures in 15 minutes, per address', () => {
    let now = 0;
    const limiter = createLoginLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) limiter.fail('10.0.0.2');
    expect(limiter.blocked('10.0.0.2')).toBe(true);
    expect(limiter.blocked('10.0.0.3')).toBe(false);
    now = 15 * 60_000;
    expect(limiter.blocked('10.0.0.2')).toBe(false);
  });

  it('forgets failures after a success', () => {
    const limiter = createLoginLimiter();
    for (let i = 0; i < 4; i++) limiter.fail('ip');
    limiter.succeed('ip');
    limiter.fail('ip');
    expect(limiter.blocked('ip')).toBe(false);
  });
});

describe('cookies', () => {
  it('reads one cookie from a header', () => {
    expect(readCookie('a=1; pipulse_session=abc; b=2', 'pipulse_session')).toBe('abc');
    expect(readCookie(undefined, 'pipulse_session')).toBeUndefined();
    expect(readCookie('xpipulse_session=abc', 'pipulse_session')).toBeUndefined();
  });

  it('sets and clears the session cookie, Secure only over HTTPS', () => {
    expect(sessionCookie('id', false)).toBe(
      'pipulse_session=id; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800'
    );
    expect(sessionCookie('id', true)).toMatch(/; Secure$/);
    expect(clearedSessionCookie(false)).toBe(
      'pipulse_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
    );
  });
});

describe('readAuthConfig', () => {
  it('is read-only with public reads by default', () => {
    expect(readAuthConfig({})).toEqual({ protectReads: false });
  });

  it('reads the hash file and read protection', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pipulse-')), 'hash');
    writeFileSync(path, await hashPassword('pw', CHEAP));
    const config = readAuthConfig({
      PIPULSE_ADMIN_PASSWORD_HASH_FILE: path,
      PIPULSE_PROTECT_READS: 'true'
    });
    expect(config.protectReads).toBe(true);
    expect(await verifyPassword('pw', config.passwordHash!)).toBe(true);
  });

  it('refuses a bad PIPULSE_PROTECT_READS value', () => {
    expect(() => readAuthConfig({ PIPULSE_PROTECT_READS: 'maybe' })).toThrow(
      /^PIPULSE_PROTECT_READS must be true or false \(got "maybe"\)$/
    );
  });

  it('refuses read protection without a password, which would lock everyone out', () => {
    expect(() => readAuthConfig({ PIPULSE_PROTECT_READS: 'true' })).toThrow(
      /^PIPULSE_PROTECT_READS=true needs PIPULSE_ADMIN_PASSWORD_HASH_FILE/
    );
  });
});

describe('createLoginLimiter, memory', () => {
  it('forgets addresses whose failures have all aged out, so the map cannot grow forever', () => {
    let now = 0;
    const limiter = createLoginLimiter({ now: () => now });
    for (let i = 0; i < 1000; i++) limiter.fail(`10.1.${i >> 8}.${i & 255}`);
    expect(limiter.tracked()).toBe(1000);
    now = 15 * 60_000 + 1;
    limiter.fail('10.9.9.9');
    expect(limiter.tracked()).toBe(1);
  });
});
