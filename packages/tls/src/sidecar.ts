import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { printCa, usage, type Context } from './cli-common.js';
import { decideInitialMode, init } from './cmd-init.js';
import { renew } from './cmd-renew.js';
import { ensureDir } from './files.js';
import { validityOf } from './inspect.js';
import { MODES, paths, priv, pub, readRenewStatus, readState, writeState } from './layout.js';
import { withLock } from './lock.js';
import { checkCa, checkLeaf } from './material.js';

/** On the sidecar's tmpfs, so a restart starts unready. */
export const READY_FILE = '/tmp/pipulse-sidecar-ready';
export const SIDECAR_INTERVAL_MS = 6 * 3_600_000;

const lockOptions = (ctx: Context, create: boolean) => ({
  create,
  waitMs: ctx.lockWaitMs,
  now: ctx.now,
  sleep: ctx.sleep,
  ...(ctx.lockAlive ? { alive: ctx.lockAlive } : {})
});

/** The one-shot init service (CAP_CHOWN only): the two volumes' owners and modes. */
export function sidecarInit(ctx: Context): number {
  ensureDir(ctx.layout.tlsDir, { mode: MODES.tlsDir, owner: pub(ctx.layout) });
  ensureDir(ctx.layout.caRoot, { mode: MODES.caRoot, owner: priv(ctx.layout) });
  ctx.out(`${ctx.layout.tlsDir} is root:pipulse 2750 and ${ctx.layout.caRoot} root 0700`);
  return 0;
}

const exists = (path: string, whenUnsure: boolean) => {
  try {
    statSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : whenUnsure;
  }
};

/**
 * First start, in order: recover a journal, stage and validate a CA and leaf
 * (names-only, or PIPULSE_TLS_SUBNETS; never inferred), activate them, write
 * state.json when absent, print the CA facts (the out-of-band channel,
 * identical on every start), and only then mark ready — the server waits
 * for that.
 */
export async function sidecarStart(ctx: Context, readyFile = READY_FILE): Promise<number> {
  rmSync(readyFile, { force: true });
  // The same lock as the CLI: `docker compose run pipulse-tls pipulse tls new-ca` may run meanwhile.
  const code = await withLock(
    ctx.layout,
    () => init(ctx, ['--yes', '--quiet']),
    lockOptions(ctx, true)
  );
  if (code !== 0) return code;
  if (readState(ctx.layout) === undefined) {
    const db = ctx.env['PIPULSE_DB_PATH']?.trim() || '/data/pipulse.sqlite';
    const mode = decideInitialMode({
      previousInstall: false,
      dbExists: exists(db, true),
      markerExists: exists(join(dirname(db), 'tls-installed'), false)
    });
    writeState(ctx.layout, mode, ctx.hook);
    ctx.out(
      mode === 'https'
        ? 'state.json: https'
        : 'state.json: legacy-http (this data comes from an HTTP install). HTTPS is ready: docker compose run --rm pipulse-tls pipulse tls enable --yes, then docker compose restart pipulse'
    );
  }
  printCa(ctx);
  const clock = ctx.clock();
  ctx.out(
    `clock: ${clock.state}${ctx.env['PIPULSE_TLS_CLOCK']?.trim() === 'trust' ? ' (PIPULSE_TLS_CLOCK=trust)' : ''}`
  );
  writeFileSync(readyFile, `${ctx.now()}\n`, { mode: 0o600 });
  return 0;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true }
    );
  });

export async function sidecar(
  ctx: Context,
  args: string[],
  options: { readyFile?: string; intervalMs?: number; stop?: AbortSignal } = {}
): Promise<number> {
  usage(() => parseArgs({ args, options: {}, strict: true }));
  const code = await sidecarStart(ctx, options.readyFile);
  if (code !== 0) {
    ctx.err('pipulse-tls is not ready; the server will not start until this is fixed');
    return code;
  }
  for (;;) {
    try {
      await withLock(ctx.layout, () => renew(ctx, []), lockOptions(ctx, false));
    } catch (error) {
      ctx.err(`renewal skipped this round: ${(error as Error).message}`); // e.g. a new-ca is running
    }
    if (await wait(options.intervalMs ?? SIDECAR_INTERVAL_MS, options.stop)) return 0;
  }
}

export function sidecarHealth(ctx: Context, readyFile = READY_FILE): number {
  if (!existsSync(readyFile)) {
    ctx.err('not ready yet');
    return 1;
  }
  const ca = checkCa(paths(ctx.layout).caDir);
  if (ca.kind !== 'ok') {
    ctx.err(`no usable CA: ${ca.kind === 'partial' ? ca.problem : 'missing'}`);
    return 1;
  }
  const leaf = checkLeaf(paths(ctx.layout).bundle, ca.ca, pub(ctx.layout));
  if (leaf.kind !== 'ok' || validityOf(leaf, ctx.now(), 0) === 'expired') {
    ctx.err('no valid certificate');
    return 1;
  }
  const renewal = readRenewStatus(paths(ctx.layout).renewStatus);
  if (renewal?.result === 'failed') {
    ctx.err(`renewal failing: ${renewal.reason}`);
    return 1;
  }
  return 0;
}
