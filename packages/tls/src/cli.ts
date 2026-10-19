import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces, uptime } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { UsageError, nativeLayoutProblem, operatorConfigured, type Context } from './cli/cli-common.js';
import { readClock } from './settings/clock.js';
import { newCa, restoreCa } from './cli/cmd-ca.js';
import { exportCa } from './cli/cmd-export.js';
import { disable, enable } from './cli/cmd-mode.js';
import { init, initChoosesMode } from './cli/cmd-init.js';
import { hostName } from './common/hostname.js';
import { recordRenewLockFailure, renew } from './cli/cmd-renew.js';
import { status } from './cli/cmd-status.js';
import { DEFAULT_TIMESYNC_DIR, DEFAULT_TLS_DIR } from './settings/config.js';
import { candidateSubnet, defaultRouteAddresses, defaultRouteInterfaces } from './ca/constraints.js';
import { settingsEnv } from './common/envfile.js';
import { OPENSSL } from './ca/issue.js';
import { LOCK_WAIT_MS, LockError, withLock } from './ca/lock.js';
import { layoutFrom, type Layout } from './ca/layout.js';
import { processIdentity } from './common/proc.js';
import { sidecar, sidecarHealth, sidecarInit } from './cli/sidecar.js';

export const USAGE = `usage: pipulse tls <command>
  status [--json]              what is configured, what the server serves, the last renewal
  init [--subnet CIDR]... [--yes] [--mode auto [--first-install] [--quiet]]
                               make the CA and certificate if they are missing (never replaces a CA)
  renew [--force]              renew the certificate when it is due (the hourly timer runs this)
  new-ca [--subnet CIDR]... [--name NAME]... [--prune-oldest ca.old-…] [--yes]
                               replace the CA (every device must trust the new one)
  restore-ca ca.old-… [--yes]  bring a backed-up CA back
  enable [--yes] [--allow-expired]
                               serve HTTPS (checks it works, else goes back)
  disable [--allow-insecure] [--yes]
                               serve plain HTTP again (the certificates stay)
  export-ca [--out FILE]       the CA certificate, its fingerprint and how to trust it`;

const ROOT_ONLY = new Set([
  'init',
  'renew',
  'new-ca',
  'restore-ca',
  'enable',
  'disable',
  'sidecar-init',
  'sidecar'
]);
/**
 * Commands that change material or mode take the one interprocess lock before
 * anything else (recover() included); `true` = may create the CA folder for it.
 */
const LOCKED: Readonly<Record<string, boolean>> = {
  init: true,
  'new-ca': true,
  'restore-ca': true,
  renew: false,
  // enable/disable write state.json even for an operator pair, where no CA folder exists yet
  enable: true,
  disable: true
};

async function dispatch(
  command: string | undefined,
  args: string[],
  ctx: Context
): Promise<number> {
  switch (command) {
    case 'status':
      return await status(ctx, args);
    case 'export-ca':
      return exportCa(ctx, args);
    case 'init':
      return await init(ctx, args);
    case 'renew':
      return await renew(ctx, args);
    case 'new-ca':
      return await newCa(ctx, args);
    case 'restore-ca':
      return await restoreCa(ctx, args);
    case 'enable':
      return await enable(ctx, args);
    case 'disable':
      return await disable(ctx, args);
    case 'sidecar-init':
      return sidecarInit(ctx);
    case 'sidecar': {
      // PID 1 in a container has no default signal action: without a handler `docker stop` waits
      // out its timeout and SIGKILLs the sidecar, possibly mid-renewal. A renewal in progress
      // finishes (the loop looks at the signal only between rounds).
      const stop = new AbortController();
      const onSignal = () => stop.abort();
      process.once('SIGTERM', onSignal);
      process.once('SIGINT', onSignal);
      try {
        return await sidecar(ctx, args, { stop: stop.signal });
      } finally {
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
      }
    }
    case 'sidecar-health':
      return sidecarHealth(ctx);
    default:
      throw new UsageError(
        command === undefined ? 'no command given' : `unknown command: ${command}`
      );
  }
}

function routes() {
  const read = (path: string) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  };
  return defaultRouteInterfaces(read('/proc/net/route'), read('/proc/net/ipv6_route'));
}

/**
 * A yes/no question. The end of input (Ctrl-D, a closed pipe) is "no": a readline question
 * that is never answered would leave the process waiting until Node gives up with exit code 13.
 */
export async function askYesNo(
  question: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream
): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await Promise.race([
      rl.question(`${question} [y/N] `),
      new Promise<string>((resolve) => rl.once('close', () => resolve('')))
    ]);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function defaultContext(): Context {
  const env = settingsEnv(process.env);
  const run = (command: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        command,
        args,
        { timeout: 60_000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } },
        (error) => (error ? reject(error) : resolve())
      );
    });
  let layout: Layout | undefined;
  return {
    env,
    // Lazily: `--help` and usage errors must work where there is no pipulse group.
    get layout() {
      return (layout ??= layoutFrom(env));
    },
    openssl: OPENSSL,
    now: Date.now,
    monotonic: () => performance.now(),
    hostname: () => hostName(env),
    addresses: () => defaultRouteAddresses(routes(), networkInterfaces()),
    candidate: () => candidateSubnet(routes(), networkInterfaces()),
    interfaces: networkInterfaces,
    clock: () =>
      readClock({
        timesyncDir: env['PIPULSE_TLS_TIMESYNC_DIR']?.trim() || DEFAULT_TIMESYNC_DIR,
        now: Date.now(),
        trust: env['PIPULSE_TLS_CLOCK']?.trim() === 'trust'
      }),
    uptime: () => uptime() * 1000,
    bootId: () => processIdentity(process.pid)?.bootId,
    isRoot: process.getuid?.() === 0,
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: (question) => askYesNo(question, process.stdin, process.stdout),
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    restart: () => run('systemctl', ['restart', 'pipulse']),
    // Loaded only when needed, so the sidecar's module graph has no network client.
    health: async (settings) => (await import('./health-check.js')).checkHealth(settings),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    inContainer: env['PIPULSE_IN_CONTAINER'] === 'true',
    defaultTlsDir: DEFAULT_TLS_DIR,
    lockWaitMs: LOCK_WAIT_MS
  };
}

/**
 * Whether `command` runs under the interprocess lock. Own keys only: "constructor" or
 * "toString" are not commands. A refused native layout or an operator certificate never
 * writes generated material, so init/renew/new-ca/restore-ca need no lock then (and the
 * renew unit couldn't take one there); enable and disable always lock, since both write
 * state.json and must not race with setup or the sidecar.
 */
export function lockFor(
  command: string | undefined,
  ctx: Context,
  args: string[] = []
): { create: boolean } | undefined {
  if (command === undefined || !Object.hasOwn(LOCKED, command)) return undefined;
  const modeSwitch = command === 'enable' || command === 'disable';
  // `init --mode auto` writes state.json even over an operator certificate; with a refused
  // folder and no operator certificate it writes nothing, not even a lock file there.
  const initState = command === 'init' && initChoosesMode(args);
  if (initState && !operatorConfigured(ctx.env) && nativeLayoutProblem(ctx) !== undefined)
    return undefined;
  if (
    !modeSwitch &&
    !initState &&
    (operatorConfigured(ctx.env) || nativeLayoutProblem(ctx) !== undefined)
  )
    return undefined;
  return { create: LOCKED[command] === true };
}

export async function main(argv: string[], ctx: Context): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === '--help' || command === 'help') {
      ctx.out(USAGE);
      return 0;
    }
    if (command !== undefined && ROOT_ONLY.has(command) && !ctx.isRoot) {
      ctx.err(`pipulse tls ${command} needs root: sudo pipulse tls ${command}`);
      return 1;
    }
    const run = () => dispatch(command, args, ctx);
    // One command at a time (the hourly timer, a manual new-ca, setup).
    const lock = lockFor(command, ctx, args);
    if (lock) {
      return await withLock(ctx.layout, run, {
        create: lock.create,
        waitMs: ctx.lockWaitMs,
        now: ctx.now,
        sleep: ctx.sleep,
        ...(ctx.lockAlive ? { alive: ctx.lockAlive } : {})
      });
    }
    return await run();
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.err(`pipulse tls: ${error.message}`);
      ctx.err(USAGE);
      return 2;
    }
    ctx.err(`pipulse tls: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof LockError && command === 'renew')
      recordRenewLockFailure(ctx, (error as Error).message);
    return 1;
  }
}

/**
 * A reader that closes the pipe early (`pipulse tls status | grep -q …`, `init | head -n 1`)
 * is not an error, and must never cut a command short: init, new-ca, enable and the rest print
 * before and during their work. The write is dropped and the command finishes, with its own
 * exit status. Any other stream error is still thrown.
 */
export function ignoreClosedPipe(stream: NodeJS.WritableStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') return;
    throw error;
  });
}

/**
 * The entry point: help needs no settings, and a settings file that can't be read
 * (settingsEnv throws) ends as one line, not a stack trace.
 */
export async function cli(
  argv: string[],
  makeContext: () => Context,
  stderr: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  stdout: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
): Promise<number> {
  if (argv[0] === 'help' || argv[0] === '--help') {
    stdout(USAGE);
    return 0;
  }
  let ctx: Context;
  try {
    ctx = makeContext();
  } catch (error) {
    stderr(`pipulse tls: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return main(argv, ctx);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  ignoreClosedPipe(process.stdout);
  ignoreClosedPipe(process.stderr);
  process.exitCode = await cli(process.argv.slice(2), defaultContext);
}
