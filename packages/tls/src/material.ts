import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  canonicalName,
  formatAddress,
  leafNames,
  parseAddress,
  scopeOf,
  type Constraints
} from './constraints.js';
import {
  ensureDir,
  readSecureFile,
  removeTree,
  writeAtomic,
  type FsHook,
  type Owner
} from './files.js';
import { inspectMaterial } from './inspect.js';
import { issueCa, issueLeaf, type Issued } from './issue.js';
import {
  MODES,
  listBackups,
  parseMeta,
  parseStoredConstraints,
  paths,
  priv,
  pub,
  readMeta,
  storedConstraintsJson,
  writeMeta,
  type BackupInfo,
  type CaMeta,
  type Layout
} from './layout.js';
import { parseBundle } from './pem.js';

/** What issuing needs, injected so tests control time, names and addresses. */
export interface IssueContext {
  env: NodeJS.ProcessEnv;
  layout: Layout;
  openssl: string;
  now: () => number;
  hostname: () => string;
  /** Addresses on the default-route interface(s), canonical. */
  addresses: () => string[];
  hook?: FsHook | undefined;
}

export interface CaFiles {
  dir: string;
  keyPath: string;
  certPath: string;
  certPem: string;
  fingerprint: string;
  subject: string;
  notAfter: number;
  createdAt: number;
  constraints: Constraints;
}

export type CaCheck =
  { kind: 'none' } | { kind: 'partial'; problem: string } | { kind: 'ok'; ca: CaFiles };
export type LeafCheck =
  | { kind: 'missing' }
  | { kind: 'refused'; problem: string }
  | {
      kind: 'ok';
      fingerprint: string;
      notBefore: number;
      notAfter: number;
      sans: { dns: string[]; ip: string[] };
    };
export interface StageDirs {
  ca: string;
  pub: string;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
export const namesSetting = (env: NodeJS.ProcessEnv) => list(env['PIPULSE_TLS_NAMES']);
export const subnetsSetting = (env: NodeJS.ProcessEnv) => list(env['PIPULSE_TLS_SUBNETS']);

export const recoveryHint = (layout: Layout) =>
  `restore a backup (sudo pipulse tls restore-ca <ca.old-…>) or move ${paths(layout).caDir} aside and run sudo pipulse tls init to make a new CA (every browser must then trust the new one)`;

/**
 * Whether `path` is there: true, false (ENOENT only), or the error's one-line
 * reason. A path we can't stat (EACCES, EIO, a sandbox or a missing volume) is
 * never "absent": reporting a CA that merely can't be seen as "none" would let
 * init make a second one. lstat, so a dangling symlink counts as present and is
 * refused later by the file policy.
 */
function probe(path: string): true | false | string {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? false : `can't be checked (${code ?? 'error'})`;
  }
}

const cn = (cert: X509Certificate) => /(?:^|\n)CN=([^\n]*)/.exec(cert.subject)?.[1] ?? '';

/** The CA in `dir`, checked end to end. A partial CA is reported, never regenerated. */
export function checkCa(dir: string): CaCheck {
  const there = probe(dir);
  if (there === false) return { kind: 'none' };
  if (typeof there === 'string') return { kind: 'partial', problem: `${dir} ${there}` };
  const keyPath = join(dir, 'ca.key');
  const certPath = join(dir, 'ca.crt');
  const constraintsPath = join(dir, 'constraints.json');
  const checks = [keyPath, certPath, constraintsPath].map((path) => ({
    name: basename(path),
    there: probe(path)
  }));
  const unseen = checks.filter(({ there }) => typeof there === 'string');
  if (unseen.length > 0) {
    return {
      kind: 'partial',
      problem: `${dir}: ${unseen.map(({ name, there }) => `${name} ${there as string}`).join(', ')}`
    };
  }
  const missing = checks.filter(({ there }) => there === false).map(({ name }) => name);
  if (missing.length > 0)
    return { kind: 'partial', problem: `${dir} is missing ${missing.join(', ')}` };
  const partial = (problem: string): CaCheck => ({
    kind: 'partial',
    problem: `${dir}: ${problem}`
  });
  try {
    const policy = { kind: 'generated', maxMode: MODES.caFile } as const;
    const cert = new X509Certificate(readSecureFile(certPath, policy, 'ca/ca.crt'));
    const key = createPrivateKey(readSecureFile(keyPath, policy, 'ca/ca.key'));
    if (!cert.ca) return partial('ca.crt is not a CA certificate');
    if (!cert.checkPrivateKey(key)) return partial('ca.key does not match ca.crt');
    const stored = parseStoredConstraints(
      readSecureFile(constraintsPath, policy, 'ca/constraints.json')
    );
    if (stored.fingerprint !== cert.fingerprint256)
      return partial('constraints.json belongs to another CA');
    return {
      kind: 'ok',
      ca: {
        dir,
        keyPath,
        certPath,
        certPem: cert.toString(),
        fingerprint: cert.fingerprint256,
        subject: cn(cert),
        notAfter: cert.validToDate.getTime(),
        createdAt: stored.createdAt,
        constraints: stored.constraints
      }
    };
  } catch (error) {
    return partial(messageOf(error));
  }
}

const canonicalIp = (text: string) => {
  try {
    return formatAddress(parseAddress(text));
  } catch {
    return text;
  }
};

/**
 * leaf.pem counts only if its key matches and it verifies against `ca` (the CA in ca/).
 * Dates are not judged here: an expired or not-yet-valid leaf comes back `ok` with its
 * `notBefore`/`notAfter`, and the caller (renew, status) decides what that means.
 */
export function checkLeaf(bundlePath: string, ca: { certPem: string }, owner?: Owner): LeafCheck {
  const there = probe(bundlePath);
  if (there === false) return { kind: 'missing' };
  if (typeof there === 'string')
    return { kind: 'refused', problem: `${basename(bundlePath)} ${there}` };
  try {
    const bundle = parseBundle(
      readSecureFile(
        bundlePath,
        { kind: 'generated', maxMode: MODES.bundle, ...(owner ?? {}) },
        'leaf.pem'
      ),
      'leaf.pem'
    );
    const loaded = inspectMaterial({
      source: 'generated',
      keyPem: bundle.key,
      certPems: bundle.certs,
      trust: { anchors: [ca.certPem], system: false },
      names: []
    });
    if (loaded.class !== 'valid')
      return {
        kind: 'refused',
        problem: `leaf.pem does not verify against the CA (${loaded.class})`
      };
    return {
      kind: 'ok',
      fingerprint: loaded.fingerprint,
      notBefore: loaded.notBefore,
      notAfter: loaded.notAfter,
      sans: { dns: loaded.sans.dns, ip: loaded.sans.ip.map(canonicalIp) }
    };
  } catch (error) {
    return { kind: 'refused', problem: messageOf(error) };
  }
}

/** The scratch folder issuance uses (root 0700 on the CA's filesystem), emptied before and after. */
export function prepareWork(layout: Layout, hook?: FsHook | undefined): void {
  removeTree(paths(layout).work, hook);
  ensureDir(paths(layout).work, { mode: MODES.caDir, owner: priv(layout), hook });
}

export async function makeLeaf(
  ctx: IssueContext,
  ca: CaFiles
): Promise<{ issued: Issued; dns: string[]; ip: string[]; outside: string[] }> {
  const names = leafNames({
    constraints: ca.constraints,
    hostname: ctx.hostname(),
    names: namesSetting(ctx.env),
    addresses: ctx.addresses()
  });
  const issued = await issueLeaf({
    openssl: ctx.openssl,
    workDir: paths(ctx.layout).work,
    ca: { keyPath: ca.keyPath, certPath: ca.certPath, certPem: ca.certPem },
    subject: (names.dns[0] ?? 'localhost').slice(0, 64),
    dns: names.dns,
    ip: names.ip,
    now: ctx.now()
  });
  return { issued, ...names };
}

/** leaf.crt first, leaf.pem (key + chain in one file, so never a mismatched pair) last. */
export function writeLeaf(
  dir: string,
  layout: Layout,
  issued: Issued,
  hook?: FsHook | undefined
): void {
  writeAtomic(join(dir, 'leaf.crt'), issued.certPem, {
    mode: MODES.publicCert,
    owner: pub(layout),
    hook
  });
  writeAtomic(join(dir, 'leaf.pem'), issued.keyPem + issued.certPem, {
    mode: MODES.bundle,
    owner: pub(layout),
    hook
  });
}

export function metaFor(ca: CaFiles, backups: BackupInfo[]): CaMeta {
  return {
    version: 1,
    fingerprint: ca.fingerprint,
    subject: ca.subject,
    createdAt: ca.createdAt,
    notAfter: ca.notAfter,
    constraints: ca.constraints,
    backups
  };
}

/** Public copies (ca.crt, ca-meta.json, the leaf) for `ca` into `pubDir`. */
export async function stagePublic(
  ctx: IssueContext,
  pubDir: string,
  ca: CaFiles,
  backups: BackupInfo[]
): Promise<{ outside: string[] }> {
  writeAtomic(join(pubDir, 'ca.crt'), ca.certPem, {
    mode: MODES.publicCert,
    owner: pub(ctx.layout),
    hook: ctx.hook
  });
  writeMeta(join(pubDir, 'ca-meta.json'), metaFor(ca, backups), ctx.layout, ctx.hook);
  const leaf = await makeLeaf(ctx, ca);
  writeLeaf(pubDir, ctx.layout, leaf.issued, ctx.hook);
  return { outside: leaf.outside };
}

function writeCaFiles(
  ctx: IssueContext,
  caDir: string,
  files: { key: string; cert: string; constraints: string }
) {
  ensureDir(caDir, { mode: MODES.caDir, owner: priv(ctx.layout), hook: ctx.hook });
  const options = { mode: MODES.caFile, owner: priv(ctx.layout), hook: ctx.hook };
  writeAtomic(join(caDir, 'ca.key'), files.key, options);
  writeAtomic(join(caDir, 'ca.crt'), files.cert, options);
  writeAtomic(join(caDir, 'constraints.json'), files.constraints, options);
  const check = checkCa(caDir);
  if (check.kind !== 'ok')
    throw new Error(
      `the staged CA did not check out: ${check.kind === 'partial' ? check.problem : 'missing'}`
    );
  return check.ca;
}

/** A brand-new CA (subject "PiPulse CA <host> <install id>") and its leaf, into a journal stage. */
export async function stageNewCa(
  ctx: IssueContext,
  dirs: StageDirs,
  constraints: Constraints,
  backups: BackupInfo[]
): Promise<{ ca: CaFiles; outside: string[] }> {
  const now = ctx.now();
  const issued = await issueCa({
    openssl: ctx.openssl,
    workDir: paths(ctx.layout).work,
    subject: `PiPulse CA ${canonicalName(ctx.hostname()).slice(0, 40)} ${randomBytes(3).toString('hex')}`,
    scope: scopeOf(constraints),
    now
  });
  const ca = writeCaFiles(ctx, join(dirs.ca, 'ca'), {
    key: issued.keyPem,
    cert: issued.certPem,
    constraints: storedConstraintsJson(issued.fingerprint, now, constraints)
  });
  return { ca, ...(await stagePublic(ctx, dirs.pub, ca, backups)) };
}

/** A copy of a backed-up CA (restore-ca) and a fresh leaf from it, into a journal stage. */
export async function stageCopiedCa(
  ctx: IssueContext,
  dirs: StageDirs,
  fromDir: string,
  backups: BackupInfo[]
): Promise<{ ca: CaFiles; outside: string[] }> {
  const read = (name: string) =>
    readSecureFile(
      join(fromDir, name),
      { kind: 'generated', maxMode: MODES.caFile },
      `${basename(fromDir)}/${name}`
    );
  const ca = writeCaFiles(ctx, join(dirs.ca, 'ca'), {
    key: read('ca.key'),
    cert: read('ca.crt'),
    constraints: read('constraints.json')
  });
  return { ca, ...(await stagePublic(ctx, dirs.pub, ca, backups)) };
}

/** Everything a stage must hold before anything active is touched. Throws what is wrong. */
export function validateStage(dirs: StageDirs, owner: Owner): CaFiles {
  const check = checkCa(join(dirs.ca, 'ca'));
  if (check.kind !== 'ok')
    throw new Error(
      `the staged CA is not complete: ${check.kind === 'partial' ? check.problem : 'missing'}`
    );
  if (readFileSync(join(dirs.pub, 'ca.crt'), 'utf8') !== check.ca.certPem)
    throw new Error('the staged ca.crt is not the staged CA');
  if (
    parseMeta(readFileSync(join(dirs.pub, 'ca-meta.json'), 'utf8')).fingerprint !==
    check.ca.fingerprint
  ) {
    throw new Error('the staged ca-meta.json describes another CA');
  }
  const leaf = checkLeaf(join(dirs.pub, 'leaf.pem'), check.ca, owner);
  if (leaf.kind !== 'ok')
    throw new Error(
      `the staged leaf is not usable: ${leaf.kind === 'refused' ? leaf.problem : 'missing'}`
    );
  return check.ca;
}

/**
 * Makes the public copies match the CA in ca/ (after a crash, a manual
 * edit, or a backup listing change). Returns the files it rewrote.
 */
export function repairPublic(ctx: IssueContext, ca: CaFiles): string[] {
  const p = paths(ctx.layout);
  const fixed: string[] = [];
  let current: string | undefined;
  try {
    current = readFileSync(p.publicCa, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== ca.certPem) {
    writeAtomic(p.publicCa, ca.certPem, {
      mode: MODES.publicCert,
      owner: pub(ctx.layout),
      hook: ctx.hook
    });
    fixed.push('ca.crt');
  }
  const wanted = metaFor(ca, listBackups(ctx.layout));
  let meta: CaMeta | undefined;
  try {
    meta = readMeta(ctx.layout);
  } catch {
    meta = undefined;
  }
  if (JSON.stringify(meta) !== JSON.stringify(wanted)) {
    writeMeta(p.meta, wanted, ctx.layout, ctx.hook);
    fixed.push('ca-meta.json');
  }
  // leaf.crt (what `status` reads) must be the certificate of leaf.pem (what is served): a
  // kill between writeLeaf's two writes leaves them apart, and nothing else would notice.
  try {
    const served = parseBundle(readFileSync(p.bundle, 'utf8'), 'leaf.pem').certs[0];
    if (served !== undefined) {
      let shown: string | undefined;
      try {
        shown = new X509Certificate(readFileSync(p.leafCrt)).fingerprint256;
      } catch {
        shown = undefined;
      }
      if (shown !== new X509Certificate(served).fingerprint256) {
        writeAtomic(p.leafCrt, served, {
          mode: MODES.publicCert,
          owner: pub(ctx.layout),
          hook: ctx.hook
        });
        fixed.push('leaf.crt');
      }
    }
  } catch {
    // No readable leaf.pem (none yet, or not for this user): nothing to copy from.
  }
  return fixed;
}
