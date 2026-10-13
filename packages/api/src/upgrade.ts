import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  rmSync,
  writeSync
} from 'node:fs';

/**
 * The server's side of the Updates tab's opt-in "Install updates" button. The server is
 * unprivileged and its unit forbids privilege, so it cannot run apt: it rings a doorbell (a
 * small file in its own data folder) that a systemd path unit hands to a root helper
 * (packaging/pipulse-upgrade.sh). The helper decides for itself whether to act, from root-owned
 * configuration, and reports back through files this module only reads.
 */
export const REQUEST_PATH = '/var/lib/pipulse/upgrade-request';
export const STATUS_PATH = '/var/lib/pipulse-updates/upgrade-status.json';
export const LOG_PATH = '/var/lib/pipulse-updates/upgrade.log';
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const REBOOT_REQUIRED_PATH = '/run/reboot-required';
const HELPER_UNITS = [
  '/lib/systemd/system/pipulse-upgrade.path',
  '/usr/lib/systemd/system/pipulse-upgrade.path',
  '/etc/systemd/system/pipulse-upgrade.path'
];
/** The helper ignores a request older than this (packaging/pipulse-upgrade.sh MAX_AGE). */
export const REQUEST_FRESH_MS = 120_000;
/** The helper refuses a second run this soon after one (packaging/pipulse-upgrade.sh COOLDOWN). */
export const COOLDOWN_MS = 600_000;
/** A `running` status older than this is a helper that died without saying so. */
export const MAX_RUN_MS = 6 * 3_600_000;
const LOG_LINES = 40;
const LOG_LINE_CHARS = 200;
const LOG_READ_BYTES = 8192;
const STATUS_MAX_BYTES = 4096;

export type UpgradeUnavailable = 'container' | 'off' | 'no-sign-in' | 'not-installed';
export type UpgradeState = 'idle' | 'requested' | 'running' | 'done' | 'failed' | 'interrupted';

export type UpgradeView =
  | { available: false; reason: UpgradeUnavailable }
  | {
      available: true;
      state: UpgradeState;
      /** Which command the helper was running (or ran last): `update` or `upgrade`. */
      step: 'update' | 'upgrade' | null;
      startedAt: number | null;
      finishedAt: number | null;
      exitCode: number | null;
      /** The system asks for a reboot (/run/reboot-required exists). */
      rebootRequired: boolean;
      /** The last lines of the helper's log, control characters removed. */
      log: string[];
    };

export interface UpgradeOptions {
  /** PIPULSE_ALLOW_UPGRADE=true. */
  allowed: boolean;
  /** An admin password is configured (the helper checks this too). */
  signInConfigured: boolean;
  inContainer: boolean;
  now?: () => number;
  requestPath?: string;
  statusPath?: string;
  logPath?: string;
  bootIdPath?: string;
  rebootRequiredPath?: string;
  /** Whether the helper's units are installed (tests). */
  helperInstalled?: () => boolean;
}

export type RequestResult = { ok: true } | { ok: false; status: 403 | 409 | 500; error: string };

export interface Upgrade {
  view(): UpgradeView;
  /** Rings the doorbell, unless an upgrade is running or already requested. */
  request(): RequestResult;
}

interface Status {
  state: 'running' | 'done' | 'failed';
  step: 'update' | 'upgrade';
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  bootId: string;
}

/** The last `max` bytes of a file (the log can be large while an upgrade runs). */
const readSmall = (path: string, max: number): string | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const size = fstatSync(fd).size;
    const length = Math.min(size, max);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const seconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 1e11
    ? value * 1000
    : null;

/** The helper's status file, checked field by field: it is data, not trusted structure. */
export function parseStatus(text: string | undefined): Status | undefined {
  if (text === undefined || text.length > STATUS_MAX_BYTES) return undefined;
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    raw = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const state = raw['state'];
  const step = raw['step'];
  const startedAt = seconds(raw['startedAt']);
  if (state !== 'running' && state !== 'done' && state !== 'failed') return undefined;
  if (step !== 'update' && step !== 'upgrade') return undefined;
  if (startedAt === null) return undefined;
  const code = raw['exitCode'];
  const bootId = raw['bootId'];
  return {
    state,
    step,
    startedAt,
    finishedAt: seconds(raw['finishedAt']),
    exitCode:
      typeof code === 'number' && Number.isInteger(code) && code >= 0 && code < 256 ? code : null,
    bootId: typeof bootId === 'string' && /^[0-9a-f-]{0,64}$/.test(bootId) ? bootId : ''
  };
}

/** Control characters (apt draws progress with carriage returns and escapes) and bidi marks. */
const isHidden = (char: string): boolean => {
  const code = char.codePointAt(0)!;
  return (
    (code < 0x20 && code !== 0x09) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
};

/** The tail of the log as short plain lines. */
export function tailLines(text: string | undefined): string[] {
  if (text === undefined) return [];
  const lines = text.split('\n').map((line) =>
    Array.from(line)
      .filter((char) => !isHidden(char))
      .join('')
      .slice(0, LOG_LINE_CHARS)
  );
  // The first line of a tail is usually cut in half.
  if (text.length >= LOG_READ_BYTES) lines.shift();
  return lines.filter((line) => line.trim() !== '').slice(-LOG_LINES);
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

export function createUpgrade(options: UpgradeOptions): Upgrade {
  const now = options.now ?? Date.now;
  const requestPath = options.requestPath ?? REQUEST_PATH;
  const statusPath = options.statusPath ?? STATUS_PATH;
  const logPath = options.logPath ?? LOG_PATH;
  const helperInstalled = options.helperInstalled ?? (() => HELPER_UNITS.some(exists));

  const unavailable = (): UpgradeUnavailable | undefined => {
    if (options.inContainer) return 'container';
    if (!options.allowed) return 'off';
    if (!options.signInConfigured) return 'no-sign-in';
    if (!helperInstalled()) return 'not-installed';
    return undefined;
  };

  /** A doorbell rung less than REQUEST_FRESH_MS ago and not yet taken. */
  const requestPending = (): boolean => {
    try {
      return now() - lstatSync(requestPath).mtimeMs <= REQUEST_FRESH_MS;
    } catch {
      return false;
    }
  };

  const view: Upgrade['view'] = () => {
    const reason = unavailable();
    if (reason) return { available: false, reason };
    const status = parseStatus(readSmall(statusPath, STATUS_MAX_BYTES + 1));
    const bootId = readSmall(options.bootIdPath ?? BOOT_ID_PATH, 64)?.trim() ?? '';
    let state: UpgradeState = status?.state ?? 'idle';
    // The machine restarted while it said running: nothing is running any more.
    if (
      status?.state === 'running' &&
      (bootId === '' || status.bootId !== bootId || now() - status.startedAt > MAX_RUN_MS)
    )
      state = 'interrupted';
    if (state !== 'running' && requestPending()) state = 'requested';
    return {
      available: true,
      state,
      step: status?.step ?? null,
      startedAt: status?.startedAt ?? null,
      finishedAt: status?.finishedAt ?? null,
      exitCode: status?.exitCode ?? null,
      rebootRequired: exists(options.rebootRequiredPath ?? REBOOT_REQUIRED_PATH),
      log: status ? tailLines(readSmall(logPath, LOG_READ_BYTES)) : []
    };
  };

  return {
    view,
    request() {
      const current = view();
      if (!current.available)
        return { ok: false, status: 403, error: 'upgrading from here is not turned on' };
      if (current.state === 'running' || current.state === 'requested')
        return { ok: false, status: 409, error: 'an upgrade is already running' };
      if (
        current.finishedAt !== null &&
        now() >= current.finishedAt &&
        now() - current.finishedAt < COOLDOWN_MS
      )
        return {
          ok: false,
          status: 409,
          error: 'the last upgrade ended a moment ago: wait a few minutes before the next'
        };
      try {
        // An old, untaken request (the helper ignores it) is ours to clear.
        rmSync(requestPath, { force: true });
        const fd = openSync(
          requestPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        );
        try {
          writeSync(fd, 'upgrade\n');
        } finally {
          closeSync(fd);
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          status: 500,
          error: `could not ask for the upgrade: ${(error as Error).message}`
        };
      }
    }
  };
}
