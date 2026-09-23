import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AuthConfigError,
  checkNewPassword,
  clearedSessionCookie,
  createLoginLimiter,
  createSessions,
  hashPassword,
  parsePasswordHash,
  readCookie,
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
