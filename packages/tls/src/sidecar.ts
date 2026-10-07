import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dbPathOf } from './config.js';
import { parseArgs } from 'node:util';
import { printCa, tlsOff, usage, type Context } from './cli-common.js';
import { decideInitialMode, init } from './cmd-init.js';
import { renew } from './cmd-renew.js';
import { ensureDir } from './files.js';
import { MODES, paths, priv, pub, readState, writeState } from './layout.js';
import { withLock } from './lock.js';
import { checkLeaf } from './material.js';

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
  // PIPULSE_TLS=off overrides everything (the sidecar reads the same env_file as the server):
  // no CA, legacy-http on a fresh volume, so dropping the setting later never flips the transport.
  const off = tlsOff(ctx.env);
  // The same lock as the CLI: `docker compose run pipulse-tls pipulse tls new-ca` may run meanwhile.
  const code = await withLock(
    ctx.layout,
    () => init(ctx, off ? ['--mode', 'auto', '--yes', '--quiet'] : ['--yes', '--quiet']),
    lockOptions(ctx, true)
  );
  if (code !== 0) return code;
  if (off) {
    writeFileSync(readyFile, `${ctx.now()}\n`, { mode: 0o600 });
    return 0;
  }
  if (readState(ctx.layout) === undefined) {
    const db = dbPathOf(ctx.env, '/data/pipulse.sqlite', '/data');
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
  if (tlsOff(ctx.env)) {
    ctx.out('PIPULSE_TLS=off: nothing to renew');
    while (!(await wait(options.intervalMs ?? SIDECAR_INTERVAL_MS, options.stop))) {
      // idle until told to stop
    }
    return 0;
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

/**
 * Readiness only: the ready file, and a leaf that verifies against the public CA certificate in
 * the TLS folder. Never the CA key, a failed renewal or an expired leaf: `depends_on:
 * service_healthy` would then keep the server from starting, and a certificate problem never
 * stops it. Renewal failures show in the sidecar's log, `pipulse tls status` and /api/health
 * ("renewal-failing").
 */
export function sidecarHealth(ctx: Context, readyFile = READY_FILE): number {
  if (!existsSync(readyFile)) {
    ctx.err('not ready yet');
    return 1;
  }
  if (tlsOff(ctx.env)) return 0;
  let certPem: string;
  try {
    certPem = readFileSync(paths(ctx.layout).publicCa, 'utf8');
  } catch (error) {
    ctx.err(`no CA certificate: ${(error as Error).message}`);
    return 1;
  }
  const leaf = checkLeaf(paths(ctx.layout).bundle, { certPem }, pub(ctx.layout));
  if (leaf.kind !== 'ok') {
    ctx.err('no usable certificate');
    return 1;
  }
  return 0;
}
