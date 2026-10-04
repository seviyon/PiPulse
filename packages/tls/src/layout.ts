import { X509Certificate } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DEFAULT_TLS_DIR, parseState, TlsConfigError, type StateMode } from './config.js';
import { parseConstraints, type Constraints } from './constraints.js';
import { writeAtomic, type FsHook, type Owner } from './files.js';

/**
 * Where generated TLS material lives. Natively caRoot is tlsDir
 * (/etc/pipulse/tls, the CA in its ca/ subfolder); in Docker the CA key's
 * folder is its own volume (/tls-ca) that the server never mounts. A
 * journal stage never spans the two (a rename can't cross filesystems).
 */
export interface Layout {
  tlsDir: string;
  caRoot: string;
  /** Owner of everything here: root (the tests use their own uid). */
  uid: number;
  /** The service's group: public files, and tlsDir's setgid group. */
  gid: number;
  /** Group of the root-only files: 0 (the tests use their own gid). */
  privateGid: number;
}

export const MODES = {
  tlsDir: 0o2750,
  caRoot: 0o700,
  caDir: 0o700,
  caFile: 0o600,
  publicCert: 0o644,
  meta: 0o644,
  bundle: 0o640,
  state: 0o640,
  renewStatus: 0o644,
  txn: 0o600,
  stagePublic: 0o750
} as const;

/** The uid of `name` from /etc/passwd, or undefined (a dev machine has no pipulse user). */
export function userId(
  name: string,
  read: () => string = () => readFileSync('/etc/passwd', 'utf8')
): number | undefined {
  try {
    for (const line of read().split('\n')) {
      const [user, , uid] = line.split(':');
      if (user === name && uid !== undefined && /^\d+$/.test(uid)) return Number(uid);
    }
  } catch {
    // no passwd file: no expectation
  }
  return undefined;
}

export function groupId(
  name: string,
  read: () => string = () => readFileSync('/etc/group', 'utf8')
): number {
  for (const line of read().split('\n')) {
    const [group, , gid] = line.split(':');
    if (group === name && gid !== undefined && /^\d+$/.test(gid)) return Number(gid);
  }
  throw new TlsConfigError(
    `there is no "${name}" group on this system: install PiPulse first (it creates the group)`
  );
}

export function layoutFrom(
  env: NodeJS.ProcessEnv,
  options: { uid?: number; gid?: number; privateGid?: number; readGroup?: () => string } = {}
): Layout {
  const tlsDir = env['PIPULSE_TLS_DIR']?.trim() || DEFAULT_TLS_DIR;
  const caRoot = env['PIPULSE_TLS_CA_DIR']?.trim() || tlsDir;
  // Run as root through sudo, a relative path would resolve against the caller's directory.
  for (const [setting, value] of [
    ['PIPULSE_TLS_DIR', tlsDir],
    ['PIPULSE_TLS_CA_DIR', caRoot]
  ] as const) {
    if (!isAbsolute(value))
      throw new TlsConfigError(`${setting}: ${value} must be an absolute path`);
  }
  return {
    tlsDir,
    caRoot,
    uid: options.uid ?? 0,
    gid: options.gid ?? groupId('pipulse', options.readGroup),
    privateGid: options.privateGid ?? 0
  };
}

export function paths(layout: Layout) {
  const { tlsDir, caRoot } = layout;
  return {
    caDir: join(caRoot, 'ca'),
    caKey: join(caRoot, 'ca', 'ca.key'),
    caCert: join(caRoot, 'ca', 'ca.crt'),
    caConstraints: join(caRoot, 'ca', 'constraints.json'),
    txn: join(caRoot, 'txn.json'),
    work: join(caRoot, '.work'),
    publicCa: join(tlsDir, 'ca.crt'),
    meta: join(tlsDir, 'ca-meta.json'),
    bundle: join(tlsDir, 'leaf.pem'),
    leafCrt: join(tlsDir, 'leaf.crt'),
    state: join(tlsDir, 'state.json'),
    renewStatus: join(tlsDir, 'renew-status.json')
  };
}

export const pub = (layout: Layout): Owner => ({ uid: layout.uid, gid: layout.gid });
export const priv = (layout: Layout): Owner => ({ uid: layout.uid, gid: layout.privateGid });

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
export const BACKUP_NAME = /^ca\.old-\d{8}T\d{6}Z$/;

type Json = Record<string, unknown>;
function object(value: unknown, what: string, keys: string[]): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TlsConfigError(`${what} must be an object`);
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) throw new TlsConfigError(`${what} has an unknown key: ${extra}`);
  return value as Json;
}
const number = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TlsConfigError(`${what} must be a number`);
  return value;
};
const text = (value: unknown, what: string, pattern?: RegExp): string => {
  if (typeof value !== 'string' || (pattern && !pattern.test(value)))
    throw new TlsConfigError(`${what} is not valid`);
  return value;
};
function json(textValue: string, what: string): unknown {
  try {
    return JSON.parse(textValue);
  } catch {
    throw new TlsConfigError(`${what} is not valid JSON`);
  }
}

export interface BackupInfo {
  name: string;
  /** SHA-256 of the backed-up CA, or 'unreadable'. */
  fingerprint: string;
  createdAt: number;
}

/** ca-meta.json: public facts about the CA, for the server, Settings and `status`. */
export interface CaMeta {
  version: 1;
  fingerprint: string;
  subject: string;
  createdAt: number;
  notAfter: number;
  constraints: Constraints;
  backups: BackupInfo[];
}

export function parseMeta(content: string): CaMeta {
  const record = object(json(content, 'ca-meta.json'), 'ca-meta.json', [
    'version',
    'fingerprint',
    'subject',
    'createdAt',
    'notAfter',
    'constraints',
    'backups'
  ]);
  if (record['version'] !== 1) throw new TlsConfigError('ca-meta.json version must be 1');
  const backups = record['backups'];
  if (!Array.isArray(backups)) throw new TlsConfigError('ca-meta.json backups must be a list');
  return {
    version: 1,
    fingerprint: text(record['fingerprint'], 'ca-meta.json fingerprint', FINGERPRINT),
    subject: text(record['subject'], 'ca-meta.json subject', /^[A-Za-z0-9][A-Za-z0-9 .-]{0,63}$/),
    createdAt: number(record['createdAt'], 'ca-meta.json createdAt'),
    notAfter: number(record['notAfter'], 'ca-meta.json notAfter'),
    constraints: parseConstraints(record['constraints']),
    backups: backups.map((entry: unknown) => {
      const b = object(entry, 'ca-meta.json backup', ['name', 'fingerprint', 'createdAt']);
      return {
        name: text(b['name'], 'backup name', BACKUP_NAME),
        fingerprint: text(
          b['fingerprint'],
          'backup fingerprint',
          /^(([0-9A-F]{2}:){31}[0-9A-F]{2}|unreadable)$/
        ),
        createdAt: number(b['createdAt'], 'backup createdAt')
      };
    })
  };
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function readMeta(layout: Layout): CaMeta | undefined {
  const content = readOptional(paths(layout).meta);
  return content === undefined ? undefined : parseMeta(content);
}

export function writeMeta(
  path: string,
  meta: CaMeta,
  layout: Layout,
  hook?: FsHook | undefined
): void {
  writeAtomic(path, `${JSON.stringify(meta, null, 2)}\n`, {
    mode: MODES.meta,
    owner: pub(layout),
    hook
  });
}

/** ca/constraints.json: the constraints the CA was made with, tied to it by fingerprint. */
export interface StoredConstraints {
  version: 1;
  fingerprint: string;
  createdAt: number;
  constraints: Constraints;
}

export function parseStoredConstraints(content: string): StoredConstraints {
  const record = object(json(content, 'constraints.json'), 'constraints.json', [
    'version',
    'fingerprint',
    'createdAt',
    'constraints'
  ]);
  if (record['version'] !== 1) throw new TlsConfigError('constraints.json version must be 1');
  return {
    version: 1,
    fingerprint: text(record['fingerprint'], 'constraints.json fingerprint', FINGERPRINT),
    createdAt: number(record['createdAt'], 'constraints.json createdAt'),
    constraints: parseConstraints(record['constraints'])
  };
}

export const storedConstraintsJson = (
  fingerprint: string,
  createdAt: number,
  constraints: Constraints
) => `${JSON.stringify({ version: 1, fingerprint, createdAt, constraints }, null, 2)}\n`;

/**
 * ca.old-20261001T101500Z: sorts by time, and says when the CA was replaced.
 * The name has one-second resolution: pass `taken` (does that folder exist?) and a
 * second backup in the same second moves on to the next free second.
 */
export function backupName(now: number, taken: (name: string) => boolean = () => false): string {
  for (let at = now; ; at += 1000) {
    const name = `ca.old-${new Date(at).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
    if (!taken(name)) return name;
  }
}

export function listBackups(layout: Layout): BackupInfo[] {
  let names: string[];
  try {
    names = readdirSync(layout.caRoot)
      .filter((name) => BACKUP_NAME.test(name))
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    try {
      const cert = new X509Certificate(readFileSync(join(layout.caRoot, name, 'ca.crt')));
      const stored = parseStoredConstraints(
        readFileSync(join(layout.caRoot, name, 'constraints.json'), 'utf8')
      );
      return { name, fingerprint: cert.fingerprint256, createdAt: stored.createdAt };
    } catch {
      return { name, fingerprint: 'unreadable', createdAt: 0 };
    }
  });
}

export function readState(layout: Layout): StateMode | undefined {
  const content = readOptional(paths(layout).state);
  return content === undefined ? undefined : parseState(content).mode;
}

/** state.json is data, never sourced: written only by setup (through the CLI), the CLI and the sidecar. */
export function writeState(layout: Layout, mode: StateMode, hook?: FsHook | undefined): void {
  writeAtomic(paths(layout).state, `${JSON.stringify({ version: 1, mode })}\n`, {
    mode: MODES.state,
    owner: pub(layout),
    hook
  });
}

export interface RenewStatus {
  version: 1;
  lastAttempt: number;
  result: 'renewed' | 'not-due' | 'waiting-clock' | 'failed';
  reason: string;
}

export function parseRenewStatus(content: string): RenewStatus {
  const record = object(json(content, 'renew-status.json'), 'renew-status.json', [
    'version',
    'lastAttempt',
    'result',
    'reason'
  ]);
  const result = record['result'];
  if (
    record['version'] !== 1 ||
    !['renewed', 'not-due', 'waiting-clock', 'failed'].includes(result as string)
  ) {
    throw new TlsConfigError('renew-status.json is not valid');
  }
  return {
    version: 1,
    lastAttempt: number(record['lastAttempt'], 'renew-status.json lastAttempt'),
    result: result as RenewStatus['result'],
    reason: text(record['reason'], 'renew-status.json reason').slice(0, 300)
  };
}

export function readRenewStatus(path: string): RenewStatus | undefined {
  const content = readOptional(path);
  return content === undefined ? undefined : parseRenewStatus(content);
}

export function writeRenewStatus(layout: Layout, status: RenewStatus): void {
  writeAtomic(paths(layout).renewStatus, `${JSON.stringify(status)}\n`, {
    mode: MODES.renewStatus,
    owner: pub(layout)
  });
}
