import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { opensslVersion } from './issue.js';
import { issuanceClock, CLOCK_WAIT_MS } from './clock-gate.js';
import {
  buildConstraints,
  consequenceText,
  subnetWarning,
  type Constraints
} from './constraints.js';
import { removeTree } from './files.js';
import { recover, runTransaction } from './journal.js';
import { BACKUP_NAME, listBackups, paths, pub, type BackupInfo } from './layout.js';
import {
  checkCa,
  namesSetting,
  prepareWork,
  recoveryHint,
  repairPublic,
  stageCopiedCa,
  stageNewCa,
  subnetsSetting,
  validateStage,
  type CaFiles
} from './material.js';
import {
  UsageError,
  confirm,
  ensureTlsDirs,
  nativeLayoutProblem,
  operatorConfigured,
  printCa,
  reportOutside,
  usage,
  type Context
} from './cli-common.js';

const TRUST_WARNING =
  'Every browser and device that trusts the current CA must trust the new one; until then they show a warning.';

/** The backups the staged ca-meta.json lists: those there now, plus the active CA about to become one. */
function backupsAfter(
  ctx: Context,
  active: CaFiles | undefined,
  backup: string | null,
  without: string[] = []
): BackupInfo[] {
  return [
    ...listBackups(ctx.layout).filter((b) => !without.includes(b.name)),
    ...(backup && active
      ? [{ name: backup, fingerprint: active.fingerprint, createdAt: active.createdAt }]
      : [])
  ];
}

async function gate(ctx: Context): Promise<boolean> {
  await opensslVersion(ctx.openssl); // a missing or non-conforming openssl says so by name
  const clock = await issuanceClock(ctx, { lenient: true, waitMs: CLOCK_WAIT_MS });
  if (!clock.ok) ctx.err(`not issuing: ${clock.reason}`);
  return clock.ok;
}

export async function newCa(ctx: Context, args: string[]): Promise<number> {
  const { values } = usage(() =>
    parseArgs({
      args,
      options: {
        subnet: { type: 'string', multiple: true },
        name: { type: 'string', multiple: true },
        'prune-oldest': { type: 'string', multiple: true },
        yes: { type: 'boolean' }
      },
      strict: true
    })
  );
  const requested = values.subnet ?? [];
  if (requested.includes('none') && requested.length > 1)
    throw new UsageError('--subnet none cannot be combined with other subnets');
  const layout = ctx.layout;
  if (operatorConfigured(ctx.env)) {
    ctx.err(
      'an operator certificate is in use (PIPULSE_TLS_CERT/PIPULSE_TLS_KEY): there is no managed CA to replace'
    );
    return 1;
  }
  const folderProblem = nativeLayoutProblem(ctx);
  if (folderProblem) {
    ctx.err(`not replacing the CA: ${folderProblem}`);
    return 1;
  }
  recover(layout, ctx.hook);
  ensureTlsDirs(layout, ctx.hook);
  const current = checkCa(paths(layout).caDir);
  if (current.kind === 'partial') {
    ctx.err(`the CA is incomplete: ${current.problem}`);
    ctx.err(`to recover: ${recoveryHint(layout)}`);
    return 1;
  }
  const backups = listBackups(layout);
  const prune = values['prune-oldest'] ?? [];
  // The new backup makes one more: at most two may remain, so all but the newest existing
  // one must go. After an interrupted prune there can be three: then two names are needed.
  const excess = current.kind === 'ok' ? Math.max(0, backups.length - 1) : 0;
  if (excess > 0) {
    const oldest = backups.slice(0, excess).map((b) => b.name);
    if (prune.length !== excess || !oldest.every((name) => prune.includes(name))) {
      const flags = oldest.map((name) => `--prune-oldest ${name}`).join(' ');
      ctx.err(
        prune.length === 0
          ? `${backups.length} CA backups already exist (${backups.map((b) => b.name).join(', ')}); pass ${flags} to delete the oldest once the new CA is in place`
          : `--prune-oldest must name exactly the oldest ${excess === 1 ? 'backup' : 'backups'}: ${flags}`
      );
      return 1;
    }
  } else if (prune.length > 0) {
    ctx.err('--prune-oldest is only needed when two backups exist');
    return 1;
  }
  // IP scope: --subnet, else PIPULSE_TLS_SUBNETS, else the current CA's own subnets (a routine
  // rotation must not silently drop accepted ones); `--subnet none` drops them on purpose.
  const fromSettings = subnetsSetting(ctx.env);
  let subnets: string[];
  if (requested.length > 0) subnets = requested[0] === 'none' ? [] : requested;
  else if (fromSettings.length > 0) subnets = fromSettings;
  else if (current.kind === 'ok') {
    subnets = current.ca.constraints.subnets;
    if (subnets.length > 0)
      ctx.out(
        `Keeping the current IP scope (${subnets.join(', ')}); --subnet none drops it, --subnet CIDR changes it.`
      );
  } else subnets = [];
  let constraints: Constraints;
  try {
    const built = buildConstraints({
      hostname: ctx.hostname(),
      names: [...namesSetting(ctx.env), ...(values.name ?? [])],
      subnets
    });
    for (const warning of built.warnings) ctx.err(`warning: ${warning}`);
    constraints = built.constraints;
  } catch (error) {
    ctx.err(`not creating a CA: ${(error as Error).message}`);
    return 1;
  }
  for (const subnet of constraints.subnets) {
    const warning = subnetWarning(subnet, ctx.interfaces());
    if (warning) ctx.err(`warning: ${warning}`);
  }
  if (current.kind === 'ok') {
    ctx.out('Current CA scope:');
    for (const line of consequenceText(current.ca.constraints).slice(1, 3)) ctx.out(line);
  }
  ctx.out('New CA scope:');
  for (const line of consequenceText(constraints)) ctx.out(line);
  if (current.kind === 'ok') ctx.out(TRUST_WARNING);
  if (!(await confirm(ctx, values.yes, 'Replace the CA?'))) {
    ctx.err('nothing changed');
    return 1;
  }
  if (!(await gate(ctx))) return 1;
  const active = current.kind === 'ok' ? current.ca : undefined;
  prepareWork(layout, ctx.hook);
  try {
    let outside: string[] = [];
    const { backup } = await runTransaction(layout, {
      kind: active ? 'new-ca' : 'init',
      now: ctx.now(),
      hook: ctx.hook,
      stage: async (dirs, name) => {
        // The oldest backup, if pruned, is already left out: ca-meta.json never lists a deleted folder.
        ({ outside } = await stageNewCa(
          ctx,
          dirs,
          constraints,
          backupsAfter(ctx, active, name, prune)
        ));
      },
      validate: (dirs) => {
        validateStage(dirs, pub(layout));
      }
    });
    if (prune.length > 0) {
      for (const name of prune) removeTree(join(layout.caRoot, name), ctx.hook);
      const now = checkCa(paths(layout).caDir);
      if (now.kind === 'ok') repairPublic(ctx, now.ca);
      ctx.out(
        `deleted the oldest ${prune.length === 1 ? 'backup' : 'backups'}: ${prune.join(', ')}`
      );
    }
    reportOutside(ctx, outside);
    printCa(ctx);
    if (backup)
      ctx.out(
        `The previous CA is kept as ${backup} (sudo pipulse tls restore-ca ${backup} brings it back).`
      );
    return 0;
  } finally {
    removeTree(paths(layout).work);
  }
}

export async function restoreCa(ctx: Context, args: string[]): Promise<number> {
  const { values, positionals } = usage(() =>
    parseArgs({ args, options: { yes: { type: 'boolean' } }, allowPositionals: true, strict: true })
  );
  if (positionals.length !== 1)
    throw new UsageError(
      'restore-ca needs one backup, e.g. ca.old-20261001T101500Z (see sudo pipulse tls status)'
    );
  const name = basename(positionals[0]!);
  if (!BACKUP_NAME.test(name))
    throw new UsageError(`${name} is not a CA backup name (ca.old-YYYYMMDDTHHMMSSZ)`);
  const layout = ctx.layout;
  if (operatorConfigured(ctx.env)) {
    ctx.err(
      'an operator certificate is in use (PIPULSE_TLS_CERT/PIPULSE_TLS_KEY): there is no managed CA to restore'
    );
    return 1;
  }
  const folderProblem = nativeLayoutProblem(ctx);
  if (folderProblem) {
    ctx.err(`not restoring the CA: ${folderProblem}`);
    return 1;
  }
  recover(layout, ctx.hook);
  const from = join(layout.caRoot, name);
  const restored = checkCa(from);
  if (restored.kind !== 'ok') {
    ctx.err(
      `${name} can't be restored: ${restored.kind === 'none' ? 'there is no such backup' : restored.problem}`
    );
    return 1;
  }
  const current = checkCa(paths(layout).caDir);
  if (current.kind === 'partial') {
    ctx.err(
      `the active CA is incomplete (${current.problem}); move ${paths(layout).caDir} aside by hand, then run restore-ca again`
    );
    return 1;
  }
  if (current.kind === 'ok' && current.ca.fingerprint === restored.ca.fingerprint) {
    ctx.out(`${name} is already the active CA`);
    return 0;
  }
  ctx.out(`Restoring the CA with SHA-256 ${restored.ca.fingerprint}:`);
  for (const line of consequenceText(restored.ca.constraints)) ctx.out(line);
  ctx.out(
    'Devices that still trust this CA work again at once; the others must trust it (sudo pipulse tls export-ca).'
  );
  if (!(await confirm(ctx, values.yes, 'Restore this CA?'))) {
    ctx.err('nothing changed');
    return 1;
  }
  if (!(await gate(ctx))) return 1;
  const active = current.kind === 'ok' ? current.ca : undefined;
  prepareWork(layout, ctx.hook);
  try {
    let outside: string[] = [];
    const { backup } = await runTransaction(layout, {
      kind: 'restore-ca',
      now: ctx.now(),
      restoreFrom: name,
      hook: ctx.hook,
      stage: async (dirs, next) => {
        ({ outside } = await stageCopiedCa(
          ctx,
          dirs,
          from,
          backupsAfter(ctx, active, next, [name])
        ));
      },
      validate: (dirs) => {
        validateStage(dirs, pub(layout));
      }
    });
    reportOutside(ctx, outside);
    printCa(ctx);
    if (backup) ctx.out(`The CA it replaced is kept as ${backup}.`);
    return 0;
  } finally {
    removeTree(paths(layout).work);
  }
}
