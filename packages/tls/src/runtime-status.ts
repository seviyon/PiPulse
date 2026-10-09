import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './files.js';
import { FINGERPRINT } from './layout.js';
import { processIdentity } from './proc.js';
import type { ChainClass } from './inspect.js';
import type { ReloadState } from './reload.js';

export const DEFAULT_RUNTIME_DIR = '/run/pipulse';
export const RUNTIME_FILE = 'tls-status.json';

/** What the running server serves, for `pipulse tls status` (no HTTP, no session). */
export interface RuntimeStatus {
  version: 1;
  transport: 'https' | 'http';
  certificate: null | {
    source: 'operator' | 'generated';
    fingerprint: string;
    class: ChainClass;
    notAfter: number;
    reload: ReloadState;
  };
  pid: number;
  /** /proc/<pid>/stat field 22 (start time in clock ticks since boot): tells a reused pid apart. */
  startTime: string;
  bootId: string;
  /**
   * When the file was last rewritten: at startup and after each reload attempt only, so it
   * can be old while the server is healthy. Never a heartbeat or a liveness signal.
   */
  writtenAt: number;
}

export type RuntimeView =
  | { state: 'running'; status: RuntimeStatus }
  | { state: 'not-running'; reason: 'missing' | 'stale-boot' | 'stale-pid' | 'pid-reused' }
  | { state: 'status-file-corrupt'; problem: string }
  | { state: 'unknown'; problem: string };

/** A status file is a few hundred bytes; anything near this is not one. */
const MAX_STATUS_BYTES = 16 * 1024;

class StatusFileProblem extends Error {}

/**
 * Reads the file the service wrote, as root. The service owns the directory, so the path
 * can be swapped after the lstat above (a FIFO or /dev/zero would hang or exhaust a root
 * command): open without following links or blocking, then judge the descriptor itself.
 */
function readText(path: string, expectUid?: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new StatusFileProblem(`${path} is not a regular file`);
    if ((stat.mode & 0o002) !== 0) throw new StatusFileProblem(`${path} is writable by everyone`);
    if (expectUid !== undefined && stat.uid !== expectUid) {
      throw new StatusFileProblem(`${path} is owned by uid ${stat.uid}, not the service`);
    }
    if (stat.size > MAX_STATUS_BYTES) throw new StatusFileProblem(`${path} is too large`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

// proc.ts has it (the lock uses it too); re-exported here for the server and the tests.
export { processIdentity } from './proc.js';

export function writeRuntimeStatus(dir: string, status: RuntimeStatus): void {
  writeAtomic(join(dir, RUNTIME_FILE), `${JSON.stringify(status)}\n`, { mode: 0o640 });
}

const CLASSES: readonly ChainClass[] = [
  'valid',
  'degraded-incomplete-chain',
  'degraded-san',
  'degraded-untrusted'
];
const MAX_TEXT = 200;
const SHORT_TEXT = /^[\w.:-]{1,128}$/;

/**
 * Text from the status file that is printed on an administrator's terminal: the file is
 * written by the unprivileged service user, so no control character (ESC, CR, a newline
 * that fakes a line) may reach the screen.
 */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates every field and returns a copy built from the validated values only, so an
 * unknown or malformed field in the file never reaches a caller or the terminal.
 */
function parseRuntimeStatus(content: string): RuntimeStatus {
  const value: unknown = JSON.parse(content);
  if (!isObject(value) || value['version'] !== 1) throw new Error('unexpected content');
  const { transport, pid, startTime, bootId, writtenAt } = value;
  const cert = value['certificate'];
  if (transport !== 'https' && transport !== 'http') throw new Error('unexpected content');
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1)
    throw new Error('unexpected content');
  if (typeof startTime !== 'string' || !SHORT_TEXT.test(startTime))
    throw new Error('unexpected content');
  if (typeof bootId !== 'string' || !SHORT_TEXT.test(bootId)) throw new Error('unexpected content');
  if (typeof writtenAt !== 'number' || !Number.isFinite(writtenAt))
    throw new Error('unexpected content');
  let certificate: RuntimeStatus['certificate'] = null;
  if (cert !== null) {
    if (!isObject(cert)) throw new Error('unexpected content');
    const { source, fingerprint, notAfter } = cert;
    const reload = cert['reload'];
    if (source !== 'operator' && source !== 'generated') throw new Error('unexpected content');
    if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint))
      throw new Error('unexpected content');
    const klass = CLASSES.find((c) => c === cert['class']);
    if (!klass) throw new Error('unexpected content');
    if (typeof notAfter !== 'number' || !Number.isFinite(notAfter))
      throw new Error('unexpected content');
    if (!isObject(reload) || (reload['state'] !== 'ok' && reload['state'] !== 'failing'))
      throw new Error('unexpected content');
    const { lastAttempt, lastError } = reload;
    if (lastAttempt !== null && (typeof lastAttempt !== 'number' || !Number.isFinite(lastAttempt)))
      throw new Error('unexpected content');
    if (lastError !== null && typeof lastError !== 'string') throw new Error('unexpected content');
    certificate = {
      source,
      fingerprint,
      class: klass,
      notAfter,
      reload: {
        state: reload['state'],
        lastAttempt,
        lastError: lastError === null ? null : printable(lastError)
      }
    };
  }
  return { version: 1, transport, certificate, pid, startTime, bootId, writtenAt };
}

export function readRuntimeStatus(
  dir: string,
  options: {
    expectUid?: number | undefined;
    read?: (path: string) => string;
    identity?: (pid: number) => { startTime: string; bootId: string } | undefined;
    bootId?: () => string | undefined;
  } = {}
): RuntimeView {
  const path = join(dir, RUNTIME_FILE);
  let content: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile())
      return { state: 'status-file-corrupt', problem: `${path} is not a regular file` };
    if ((stat.mode & 0o002) !== 0)
      return { state: 'status-file-corrupt', problem: `${path} is writable by everyone` };
    if (options.expectUid !== undefined && stat.uid !== options.expectUid) {
      return {
        state: 'status-file-corrupt',
        problem: `${path} is owned by uid ${stat.uid}, not the service`
      };
    }
    content = options.read ? options.read(path) : readText(path, options.expectUid);
  } catch (error) {
    if (error instanceof StatusFileProblem)
      return { state: 'status-file-corrupt', problem: error.message };
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'not-running', reason: 'missing' };
    return { state: 'unknown', problem: `${path}: ${code ?? (error as Error).message}` };
  }
  let status: RuntimeStatus;
  try {
    status = parseRuntimeStatus(content);
  } catch {
    return { state: 'status-file-corrupt', problem: `${path} is not a valid status file` };
  }
  const bootNow = (options.bootId ?? (() => processIdentity(process.pid)?.bootId))();
  if (bootNow !== undefined && status.bootId !== bootNow)
    return { state: 'not-running', reason: 'stale-boot' };
  const identity = (options.identity ?? ((pid: number) => processIdentity(pid)))(status.pid);
  if (!identity) return { state: 'not-running', reason: 'stale-pid' };
  if (identity.startTime !== status.startTime)
    return { state: 'not-running', reason: 'pid-reused' };
  return { state: 'running', status };
}
