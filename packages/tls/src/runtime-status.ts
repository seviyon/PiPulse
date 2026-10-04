import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './files.js';
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
  writtenAt: number;
}

export type RuntimeView =
  | { state: 'running'; status: RuntimeStatus }
  | { state: 'not-running'; reason: 'missing' | 'stale-boot' | 'stale-pid' | 'pid-reused' }
  | { state: 'status-file-corrupt'; problem: string }
  | { state: 'unknown'; problem: string };

const readText = (path: string) => readFileSync(path, 'utf8');

// proc.ts has it (the lock uses it too); re-exported here for the server and the tests.
export { processIdentity } from './proc.js';

export function writeRuntimeStatus(dir: string, status: RuntimeStatus): void {
  writeAtomic(join(dir, RUNTIME_FILE), `${JSON.stringify(status)}\n`, { mode: 0o640 });
}

function parseRuntimeStatus(content: string): RuntimeStatus {
  const value = JSON.parse(content) as Partial<RuntimeStatus> | null;
  const cert = value?.certificate;
  const ok =
    typeof value === 'object' &&
    value !== null &&
    value.version === 1 &&
    (value.transport === 'https' || value.transport === 'http') &&
    Number.isInteger(value.pid) &&
    typeof value.startTime === 'string' &&
    typeof value.bootId === 'string' &&
    typeof value.writtenAt === 'number' &&
    (cert === null ||
      (typeof cert === 'object' &&
        cert !== undefined &&
        (cert.source === 'operator' || cert.source === 'generated') &&
        typeof cert.fingerprint === 'string' &&
        typeof cert.class === 'string' &&
        typeof cert.notAfter === 'number' &&
        typeof cert.reload === 'object' &&
        cert.reload !== null));
  if (!ok) throw new Error('unexpected content');
  return value as RuntimeStatus;
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
    content = (options.read ?? readText)(path);
  } catch (error) {
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
