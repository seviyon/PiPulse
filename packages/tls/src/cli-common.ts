import type { NetworkInterfaceInfo } from 'node:os';
import type { ClockReading } from './clock.js';
import { consequenceText } from './constraints.js';
import { ensureDir, type FsHook } from './files.js';
import type { CheckResult } from './health-check.js';
import { MODES, priv, pub, readMeta, type Layout } from './layout.js';
import type { LockHolder } from './lock.js';

export class UsageError extends Error {
  override name = 'UsageError';
}

/** Everything a command touches outside its arguments, injected so tests control it. */
export interface Context {
  /** The process environment over pipulse.env (settingsEnv). */
  env: NodeJS.ProcessEnv;
  layout: Layout;
  openssl: string;
  now: () => number;
  hostname: () => string;
  /** Addresses on the default-route interface(s), canonical. */
  addresses: () => string[];
  /** The installer's candidate subnet (the default-route interface's IPv4 network). */
  candidate: () => { iface: string; cidr: string } | undefined;
  interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  clock: (notBefore?: number) => ClockReading;
  isRoot: boolean;
  /** stdin and stdout are a terminal, so a question can be asked. */
  tty: boolean;
  ask: (question: string) => Promise<boolean>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** systemctl restart pipulse (native only). */
  restart: () => Promise<void>;
  health: (env: NodeJS.ProcessEnv) => Promise<CheckResult>;
  sleep: (ms: number) => Promise<void>;
  inContainer: boolean;
  /** The only TLS folder a native install may use for generated material (DEFAULT_TLS_DIR; tests: their temp folder). */
  defaultTlsDir: string;
  /** How long to wait for another pipulse tls command's lock (LOCK_WAIT_MS; tests: 0). */
  lockWaitMs: number;
  /** Tests only: overrides the check that a lock holder in our PID namespace still runs. */
  lockAlive?: ((holder: LockHolder) => boolean) | undefined;
  hook?: FsHook | undefined;
}

/** node:util parseArgs errors become usage errors (exit 2). */
export function usage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** PIPULSE_TLS=off: plain HTTP, and nothing is issued for it. */
export const tlsOff = (env: NodeJS.ProcessEnv) => env['PIPULSE_TLS']?.trim() === 'off';

export const operatorConfigured = (env: NodeJS.ProcessEnv) =>
  Boolean(env['PIPULSE_TLS_CERT']?.trim() && env['PIPULSE_TLS_KEY']?.trim());

/** Anything that changes trust or the transport asks on a terminal, or needs --yes. */
export async function confirm(
  ctx: Context,
  yes: boolean | undefined,
  question: string
): Promise<boolean> {
  if (yes) return true;
  if (!ctx.tty)
    throw new UsageError(
      'this changes trust or the transport: confirm with --yes (there is no terminal to ask on)'
    );
  return ctx.ask(question);
}

export function ensureTlsDirs(layout: Layout, hook?: FsHook | undefined): void {
  ensureDir(layout.tlsDir, { mode: MODES.tlsDir, owner: pub(layout), hook });
  if (layout.caRoot !== layout.tlsDir)
    ensureDir(layout.caRoot, { mode: MODES.caRoot, owner: priv(layout), hook });
}

export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const isoMinute = (ms: number) =>
  `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
export const portOf = (env: NodeJS.ProcessEnv) => env['PIPULSE_PORT']?.trim() || '8889';

export function scopeHint(ctx: Context): string {
  const cidr = ctx.candidate()?.cidr ?? '<your LAN, e.g. 192.168.1.0/24>';
  return ctx.inContainer
    ? `docker compose run --rm pipulse-tls pipulse tls new-ca --subnet ${cidr} --yes`
    : `sudo pipulse tls new-ca --subnet ${cidr}`;
}

/**
 * The out-of-band facts about the CA, identical every time for the same CA:
 * printed by init, new-ca and restore-ca (the installer shows init's), and by
 * the Docker sidecar on every start.
 */
export function printCa(ctx: Context): void {
  const meta = readMeta(ctx.layout);
  if (!meta) return;
  ctx.out(`CA SHA-256 fingerprint: ${meta.fingerprint}`);
  ctx.out(
    `  ${meta.subject}, made ${isoDate(meta.createdAt)}, valid until ${isoDate(meta.notAfter)}`
  );
  for (const line of consequenceText(meta.constraints)) ctx.out(line);
  if (meta.constraints.subnets.length === 0) {
    ctx.out(
      `IP access (https://<address>:${portOf(ctx.env)}) is not covered, so browsers will warn there. To cover your LAN: ${scopeHint(ctx)}`
    );
  }
  ctx.out(
    ctx.inContainer
      ? 'Trust this CA on each device: docker compose exec pipulse pipulse tls export-ca (compare the fingerprint first)'
      : 'Trust this CA on each device: sudo pipulse tls export-ca (compare the fingerprint first)'
  );
}

export function reportOutside(ctx: Context, outside: string[]): void {
  if (outside.length > 0) {
    ctx.err(
      `warning: left out of the certificate (outside the CA's scope): ${outside.join(', ')}; to cover them: ${scopeHint(ctx)}`
    );
  }
}

/**
 * Why generated material can't live where the settings put it. A native
 * (systemd) install keeps it only in the default folder: the renewal unit's
 * sandbox (ReadWritePaths=/etc/pipulse/tls) can write nowhere else, so any
 * other folder would renew never. In a container the image and the volumes
 * set the folders. Operator certificates are never written, so callers skip
 * this check for them.
 */
export function nativeLayoutProblem(ctx: Context): string | undefined {
  if (ctx.inContainer) return undefined;
  if (ctx.layout.tlsDir !== ctx.defaultTlsDir) {
    return `PIPULSE_TLS_DIR=${ctx.layout.tlsDir}: on a native install, generated certificates live only in ${ctx.defaultTlsDir}, the one folder the renewal service may write. Remove the setting, or use your own certificate (PIPULSE_TLS_CERT/PIPULSE_TLS_KEY)`;
  }
  if (ctx.layout.caRoot !== ctx.layout.tlsDir) {
    return `PIPULSE_TLS_CA_DIR=${ctx.layout.caRoot}: only the Docker image keeps the CA in a separate folder. Remove the setting`;
  }
  return undefined;
}
