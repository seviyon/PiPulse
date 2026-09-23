import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** A problem with the auth configuration; its message is one line for the operator. */
export class AuthConfigError extends Error {}

export interface PasswordHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

export const DEFAULT_COST = { N: 2 ** 15, r: 8, p: 1 };
/** scrypt needs 128 × N × r bytes; Node's default limit is exactly that for DEFAULT_COST. */
const MAXMEM = 256 * 1024 * 1024;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Async scrypt: runs on the thread pool, so a sign-in never stalls sample collection. */
function derive(
  password: string,
  salt: Buffer,
  length: number,
  cost: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFC so the same password typed on different keyboards hashes the same.
    scrypt(password.normalize('NFC'), salt, length, { ...cost, maxmem: MAXMEM }, (error, key) =>
      error ? reject(error) : resolve(key)
    );
  });
}

export async function hashPassword(password: string, cost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, 32, cost);
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64'), hash.toString('base64')].join(
    '$'
  );
}

export function parsePasswordHash(text: string): PasswordHash {
  const parts = text.trim().split('$');
  const [scheme, n, r, p, salt, hash] = parts;
  const numbers = [n, r, p].map(Number);
  const [N, R, P] = numbers as [number, number, number];
  const saltBytes = Buffer.from(salt ?? '', 'base64');
  const hashBytes = Buffer.from(hash ?? '', 'base64');
  if (
    parts.length !== 6 ||
    scheme !== 'scrypt' ||
    !numbers.every((value) => Number.isInteger(value) && value > 0) ||
    (N & (N - 1)) !== 0 ||
    saltBytes.length < 16 ||
    hashBytes.length < 16
  ) {
    throw new AuthConfigError('is not a PiPulse password hash (make one with hash-password)');
  }
  return { N, r: R, p: P, salt: saltBytes, hash: hashBytes };
}

export function readPasswordHashFile(
  path: string,
  variable = 'PIPULSE_ADMIN_PASSWORD_HASH_FILE'
): PasswordHash {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    throw new AuthConfigError(`${variable} ${path} could not be read: ${code}`);
  }
  try {
    return parsePasswordHash(text);
  } catch (error) {
    throw new AuthConfigError(`${variable} ${path} ${(error as Error).message}`);
  }
}

/** What PiPulse's sign-in runs with, from the environment. */
export interface AuthConfig {
  /** Unset: read-only. */
  passwordHash?: PasswordHash;
  protectReads: boolean;
}

/**
 * Reads PIPULSE_ADMIN_PASSWORD_HASH_FILE and PIPULSE_PROTECT_READS.
 * Throws AuthConfigError (one line for the operator) on a bad value, and on
 * read protection without a password, which would lock everyone out.
 */
export function readAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const protect = env['PIPULSE_PROTECT_READS'];
  if (protect !== undefined && protect !== 'true' && protect !== 'false') {
    throw new AuthConfigError(
      `PIPULSE_PROTECT_READS must be true or false (got ${JSON.stringify(protect)})`
    );
  }
  const protectReads = protect === 'true';
  const path = env['PIPULSE_ADMIN_PASSWORD_HASH_FILE'];
  if (!path) {
    if (protectReads) {
      throw new AuthConfigError(
        'PIPULSE_PROTECT_READS=true needs PIPULSE_ADMIN_PASSWORD_HASH_FILE, or nobody could sign in'
      );
    }
    return { protectReads };
  }
  return { passwordHash: readPasswordHashFile(path), protectReads };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const candidate = await derive(password, stored.salt, stored.hash.length, {
    N: stored.N,
    r: stored.r,
    p: stored.p
  });
  return timingSafeEqual(candidate, stored.hash);
}

/** Why a new password can't be used, or undefined when it can. Never trimmed. */
export function checkNewPassword(first: string, second: string): string | undefined {
  if (first === '') return 'The password is empty.';
  if (first !== second) return 'The two entries did not match.';
  return undefined;
}

export interface Sessions {
  create(): string;
  /** Whether `id` is a live session; a valid check counts as use. */
  valid(id: string | undefined): boolean;
  end(id: string | undefined): void;
}

export const SESSION_TTL_MS = 7 * DAY;

/** In-memory sessions: a restart signs everyone out, and no signing key exists anywhere. */
export function createSessions(options: { now?: () => number; ttlMs?: number } = {}): Sessions {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const lastUse = new Map<string, number>();
  const expired = (at: number) => now() - at > ttlMs;
  return {
    create() {
      for (const [id, at] of lastUse) if (expired(at)) lastUse.delete(id);
      const id = randomBytes(32).toString('base64url');
      lastUse.set(id, now());
      return id;
    },
    valid(id) {
      if (id === undefined) return false;
      const at = lastUse.get(id);
      if (at === undefined) return false;
      if (expired(at)) {
        lastUse.delete(id);
        return false;
      }
      lastUse.set(id, now());
      return true;
    },
    end(id) {
      if (id !== undefined) lastUse.delete(id);
    }
  };
}

export interface LoginLimiter {
  blocked(ip: string): boolean;
  fail(ip: string): void;
  succeed(ip: string): void;
}

export function createLoginLimiter(
  options: { now?: () => number; max?: number; windowMs?: number } = {}
): LoginLimiter {
  const now = options.now ?? Date.now;
  const max = options.max ?? 5;
  const windowMs = options.windowMs ?? 15 * MIN;
  const failures = new Map<string, number[]>();
  const recent = (ip: string) => (failures.get(ip) ?? []).filter((at) => now() - at < windowMs);
  return {
    blocked: (ip) => recent(ip).length >= max,
    fail(ip) {
      failures.set(ip, [...recent(ip), now()]);
    },
    succeed(ip) {
      failures.delete(ip);
    }
  };
}

export const SESSION_COOKIE = 'pipulse_session';

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const COOKIE_ATTRIBUTES = 'HttpOnly; SameSite=Strict; Path=/';

export function sessionCookie(id: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${id}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0${secure ? '; Secure' : ''}`;
}
