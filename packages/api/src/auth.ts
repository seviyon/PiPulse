import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseAddress } from '@pipulse/tls';

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
  // What scrypt allocates (OpenSSL: 128·r·p for the blocks and 128·r·(N+2) for the table). A file
  // that needs more than MAXMEM would start the service and then fail every sign-in.
  if (128 * R * (P + N + 2) > MAXMEM) {
    throw new AuthConfigError(
      'asks scrypt for too much memory (make a new one with hash-password)'
    );
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
  /**
   * Whether the browser's cookie for `id` should be sent again (a day after the last time):
   * the session slides with use, so its cookie must too, or a daily user is signed out when
   * the first one expires. True at most once a day.
   */
  cookieDue(id: string | undefined): boolean;
  end(id: string | undefined): void;
}

export const SESSION_TTL_MS = 7 * DAY;
const COOKIE_REFRESH_MS = DAY;

/** In-memory sessions: a restart signs everyone out, and no signing key exists anywhere. */
export function createSessions(options: { now?: () => number; ttlMs?: number } = {}): Sessions {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const sessions = new Map<string, { used: number; cookie: number }>();
  const expired = (at: number) => now() - at > ttlMs;
  return {
    create() {
      for (const [id, entry] of sessions) if (expired(entry.used)) sessions.delete(id);
      const id = randomBytes(32).toString('base64url');
      sessions.set(id, { used: now(), cookie: now() });
      return id;
    },
    valid(id) {
      if (id === undefined) return false;
      const entry = sessions.get(id);
      if (entry === undefined) return false;
      if (expired(entry.used)) {
        sessions.delete(id);
        return false;
      }
      entry.used = now();
      return true;
    },
    cookieDue(id) {
      const entry = id === undefined ? undefined : sessions.get(id);
      if (entry === undefined || now() - entry.cookie < COOKIE_REFRESH_MS) return false;
      entry.cookie = now();
      return true;
    },
    end(id) {
      if (id !== undefined) sessions.delete(id);
    }
  };
}

export interface LoginLimiter {
  blocked(ip: string): boolean;
  fail(ip: string): void;
  succeed(ip: string): void;
  /** How many addresses have failures on record. */
  tracked(): number;
}

/**
 * What the sign-in limit counts by: the address for IPv4, and the /64 for IPv6, where a single
 * host owns billions of addresses and could otherwise rotate through them for a fresh budget.
 */
export function clientKey(ip: string): string {
  const bare = ip.split('%')[0]!.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped) return mapped[1]!;
  if (!bare.includes(':')) return ip;
  try {
    const address = parseAddress(bare);
    const groups = Array.from({ length: 4 }, (_, i) =>
      ((address.bytes[2 * i]! << 8) | address.bytes[2 * i + 1]!).toString(16)
    );
    return `${groups.join(':')}::/64`;
  } catch {
    return ip;
  }
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
      // Addresses that only ever failed would otherwise stay on record forever.
      for (const key of failures.keys()) if (recent(key).length === 0) failures.delete(key);
      failures.set(ip, [...recent(ip), now()]);
    },
    succeed(ip) {
      failures.delete(ip);
    },
    tracked: () => failures.size
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
