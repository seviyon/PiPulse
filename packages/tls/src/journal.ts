import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TlsConfigError } from './config.js';
import {
  SimulatedCrash,
  cleanTemp,
  ensureDir,
  pathExists,
  removeTree,
  renameDurable,
  syncDir,
  writeAtomic,
  type FsHook
} from './files.js';
import { MODES, backupName, paths, priv, pub, type Layout } from './layout.js';
import type { StageDirs } from './material.js';

export class JournalError extends Error {
  override name = 'JournalError';
}

export const TXN_STEPS = [
  'staged',
  'validated',
  'active-ca-moved',
  'new-ca-installed',
  'leaf-installed',
  'committed'
] as const;
export type TxnStep = (typeof TXN_STEPS)[number];
export type TxnKind = 'init' | 'new-ca' | 'restore-ca';

export interface Txn {
  version: 1;
  id: string;
  kind: TxnKind;
  step: TxnStep;
  /** Where the active CA goes (chosen before staging), or null when there is none. */
  backup: string | null;
  /** restore-ca: the backup folder being restored, removed once the copy is active. */
  restoreFrom: string | null;
}

/** Public files in install order: the CA first, the serving bundle last. */
const PUBLIC_FILES = ['ca.crt', 'ca-meta.json', 'leaf.crt', 'leaf.pem'];

export function stageDirs(layout: Layout, id: string): StageDirs {
  return { ca: join(layout.caRoot, `ca.next-${id}`), pub: join(layout.tlsDir, `.next-${id}`) };
}

function parseTxn(content: string): Txn {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new JournalError('txn.json is not valid JSON');
  }
  const t = value as Partial<Txn>;
  const ok =
    typeof value === 'object' &&
    value !== null &&
    t.version === 1 &&
    typeof t.id === 'string' &&
    /^[0-9a-f]{8}$/.test(t.id) &&
    (t.kind === 'init' || t.kind === 'new-ca' || t.kind === 'restore-ca') &&
    TXN_STEPS.includes(t.step as TxnStep) &&
    (t.backup === null ||
      (typeof t.backup === 'string' && /^ca\.old-\d{8}T\d{6}Z$/.test(t.backup))) &&
    (t.restoreFrom === null ||
      (typeof t.restoreFrom === 'string' && /^ca\.old-\d{8}T\d{6}Z$/.test(t.restoreFrom)));
  if (!ok) throw new JournalError('txn.json is not a valid journal');
  return value as Txn;
}

export function readTxn(layout: Layout): Txn | undefined {
  let content: string;
  try {
    content = readFileSync(paths(layout).txn, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return parseTxn(content);
  } catch (error) {
    throw new JournalError(
      `${paths(layout).txn}: ${(error as Error).message}; see README "Recovering the CA"`
    );
  }
}

function writeTxn(layout: Layout, txn: Txn, hook?: FsHook): void {
  writeAtomic(paths(layout).txn, `${JSON.stringify(txn)}\n`, {
    mode: MODES.txn,
    owner: priv(layout),
    hook
  });
}

/**
 * Throws a transaction away. The journal goes FIRST: a crash half-way must never leave a
 * `validated` journal beside a half-deleted stage, which recover() would take for a
 * transaction to finish and install a public CA whose key was just deleted. With no
 * journal, whatever stage folders remain are orphans that recover() sweeps.
 */
function discard(layout: Layout, txn: Txn, hook?: FsHook): void {
  const dirs = stageDirs(layout, txn.id);
  hook?.('remove', paths(layout).txn);
  rmSync(paths(layout).txn, { force: true });
  syncDir(layout.caRoot);
  removeTree(dirs.ca, hook);
  removeTree(dirs.pub, hook);
}

/** Finishes a validated transaction from whatever is on disk; every step is safe to repeat. */
function complete(layout: Layout, start: Txn, hook?: FsHook): void {
  let txn = start;
  const p = paths(layout);
  const dirs = stageDirs(layout, txn.id);
  const stagedCa = join(dirs.ca, 'ca');
  const advance = (step: TxnStep) => {
    txn = { ...txn, step };
    writeTxn(layout, txn, hook);
  };
  // 1. The active CA becomes a backup — only while a staged CA still waits, so
  //    a rerun never moves the newly installed CA away.
  if (txn.backup && pathExists(p.caDir) && pathExists(stagedCa)) {
    renameDurable(p.caDir, join(layout.caRoot, txn.backup), hook);
  }
  advance('active-ca-moved');
  // 2. The staged CA becomes the active one.
  if (pathExists(stagedCa)) {
    if (pathExists(p.caDir))
      throw new JournalError(`both ${p.caDir} and a staged CA exist; move one aside by hand`);
    renameDurable(stagedCa, p.caDir, hook);
  }
  advance('new-ca-installed');
  // 3. Public copies, the serving bundle last (the reloader waits for two stable polls anyway).
  for (const name of PUBLIC_FILES) {
    const from = join(dirs.pub, name);
    if (pathExists(from)) renameDurable(from, join(layout.tlsDir, name), hook);
  }
  advance('leaf-installed');
  // 4. A restored backup is the active CA now; then the stage and the journal go.
  if (txn.restoreFrom) removeTree(join(layout.caRoot, txn.restoreFrom), hook);
  removeTree(dirs.ca, hook);
  removeTree(dirs.pub, hook);
  advance('committed');
  hook?.('remove', p.txn);
  rmSync(p.txn, { force: true });
  syncDir(layout.caRoot);
}

/**
 * A CA change (first CA, new CA, restored CA) as a journalled transaction:
 * everything is staged and validated first, so a failure before the renames
 * leaves the serving CA and leaf untouched; after that, recover() finishes
 * what was started.
 */
export async function runTransaction(
  layout: Layout,
  options: {
    kind: TxnKind;
    now: number;
    restoreFrom?: string | undefined;
    hook?: FsHook | undefined;
    stage: (dirs: StageDirs, backup: string | null) => Promise<void>;
    validate: (dirs: StageDirs) => void;
  }
): Promise<{ backup: string | null }> {
  if (readTxn(layout))
    throw new JournalError('an unfinished CA change is pending (txn.json): run recover() first');
  const hook = options.hook;
  const id = randomBytes(4).toString('hex');
  const dirs = stageDirs(layout, id);
  // One-second names: a second backup in the same second takes the next free second.
  const backup = pathExists(paths(layout).caDir)
    ? backupName(options.now, (name) => pathExists(join(layout.caRoot, name)))
    : null;
  const txn: Txn = {
    version: 1,
    id,
    kind: options.kind,
    step: 'staged',
    backup,
    restoreFrom: options.restoreFrom ?? null
  };
  writeTxn(layout, txn, hook);
  try {
    ensureDir(dirs.ca, { mode: MODES.caDir, owner: priv(layout), hook });
    ensureDir(dirs.pub, { mode: MODES.stagePublic, owner: pub(layout), hook });
    await options.stage(dirs, backup);
    options.validate(dirs);
  } catch (error) {
    if (!(error instanceof SimulatedCrash)) discard(layout, txn, hook);
    throw error;
  }
  const validated: Txn = { ...txn, step: 'validated' };
  writeTxn(layout, validated, hook);
  complete(layout, validated, hook);
  return { backup };
}

/** A kill between issue.ts's mkdtempSync and its cleanup leaves a root-only folder holding a key. */
function sweepIssueFolders(layout: Layout, hook?: FsHook): void {
  const work = paths(layout).work;
  let names: string[];
  try {
    names = readdirSync(work);
  } catch {
    return;
  }
  for (const name of names) if (/^issue-/.test(name)) removeTree(join(work, name), hook);
}

function removeStrayStages(layout: Layout, hook?: FsHook): void {
  const sweep = (root: string, pattern: RegExp) => {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) if (pattern.test(name)) removeTree(join(root, name), hook);
  };
  sweep(layout.caRoot, /^ca\.next-[0-9a-f]{8}$/);
  sweep(layout.tlsDir, /^\.next-[0-9a-f]{8}$/);
}

/** Every command but `status` runs this first: finish or roll back, then clean temp files. */
export function recover(layout: Layout, hook?: FsHook): 'none' | 'discarded' | 'completed' {
  cleanTemp(layout.tlsDir);
  if (layout.caRoot !== layout.tlsDir) cleanTemp(layout.caRoot);
  sweepIssueFolders(layout, hook);
  const txn = readTxn(layout);
  if (!txn) {
    removeStrayStages(layout, hook);
    return 'none';
  }
  const staged = pathExists(join(stageDirs(layout, txn.id).ca, 'ca'));
  const activeUntouched = pathExists(paths(layout).caDir);
  if (txn.step === 'staged' || (txn.step === 'validated' && staged && activeUntouched)) {
    discard(layout, txn, hook);
    return 'discarded';
  }
  complete(layout, txn, hook);
  return 'completed';
}

// TlsConfigError is re-exported for callers that catch both kinds.
export { TlsConfigError };
