import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Mode = 'https' | 'http';
/** What decided the mode: PIPULSE_TLS, state.json, or the release default. */
export type ModeReason = 'env' | 'state' | 'default';
export type StateMode = 'https' | 'legacy-http';

export type CertSource =
  | { kind: 'operator'; certPath: string; keyPath: string; caPath?: string }
  | { kind: 'generated'; bundlePath: string; caPath: string };

export interface TlsConfig {
  mode: Mode;
  modeReason: ModeReason;
  /** state.json's mode when the file exists, even if PIPULSE_TLS overrode it. */
  stateMode?: StateMode;
  /** Where the certificate comes from; set only in HTTPS mode. */
  source?: CertSource;
  /** PIPULSE_TLS_REQUIRE_VALID_CERT: refuse expired / not-yet-valid certificates. */
  requireValid: boolean;
  /** PIPULSE_TLS_NAMES: names the certificate must cover (lower-cased). */
  names: string[];
  /** PIPULSE_TLS_CLOCK=trust: an unknown clock counts as synced. */
  clockTrust: boolean;
  dir: string;
  timesyncDir: string;
}

export class TlsConfigError extends Error {
  override name = 'TlsConfigError';
}

export const DEFAULT_TLS_DIR = '/etc/pipulse/tls';
export const DEFAULT_TIMESYNC_DIR = '/run/systemd/timesync';

/**
 * state.json is data, never sourced by a shell: exactly
 * {"version":1,"mode":"https"|"legacy-http"}, nothing else, no key twice
 * (JSON.parse would silently keep the last one).
 */
export function parseState(text: string): { mode: StateMode } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TlsConfigError('state.json is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TlsConfigError('state.json must be a JSON object');
  }
  const keys = [...text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((match) => match[1]);
  if (new Set(keys).size !== keys.length)
    throw new TlsConfigError('state.json has a duplicate key');
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => key !== 'version' && key !== 'mode');
  if (unknownKey !== undefined)
    throw new TlsConfigError(`state.json has an unknown key: ${unknownKey}`);
  if (record['version'] !== 1) throw new TlsConfigError('state.json version must be 1');
  const mode = record['mode'];
  if (mode !== 'https' && mode !== 'legacy-http') {
    throw new TlsConfigError('state.json mode must be "https" or "legacy-http"');
  }
  return { mode };
}

function readStateFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new TlsConfigError(`state.json can't be read (${code ?? 'error'})`);
  }
}

const setting = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

/**
 * Resolves HTTPS or HTTP, once at startup: PIPULSE_TLS=on|off, else
 * state.json's mode, else the release default ('refuse' = stop with the fix
 * line). Every setting is checked whatever the mode, so a typo never hides.
 */
export function readTlsConfig(
  env: NodeJS.ProcessEnv,
  options: { releaseDefault: Mode | 'refuse'; readState?: (path: string) => string | undefined }
): TlsConfig {
  const dir = setting(env, 'PIPULSE_TLS_DIR') ?? DEFAULT_TLS_DIR;
  const stateText = (options.readState ?? readStateFile)(join(dir, 'state.json'));
  const stateMode = stateText === undefined ? undefined : parseState(stateText).mode;

  const flag = setting(env, 'PIPULSE_TLS');
  let mode: Mode;
  let modeReason: ModeReason;
  if (flag === 'on' || flag === 'off') {
    mode = flag === 'on' ? 'https' : 'http';
    modeReason = 'env';
  } else if (flag !== undefined) {
    throw new TlsConfigError(`PIPULSE_TLS must be "on" or "off", not "${flag}"`);
  } else if (stateMode !== undefined) {
    mode = stateMode === 'https' ? 'https' : 'http';
    modeReason = 'state';
  } else if (options.releaseDefault === 'refuse') {
    throw new TlsConfigError(
      'no HTTPS certificate configured: set PIPULSE_TLS_CERT and PIPULSE_TLS_KEY, or PIPULSE_TLS=off'
    );
  } else {
    mode = options.releaseDefault;
    modeReason = 'default';
  }

  const certPath = setting(env, 'PIPULSE_TLS_CERT');
  const keyPath = setting(env, 'PIPULSE_TLS_KEY');
  if ((certPath === undefined) !== (keyPath === undefined)) {
    throw new TlsConfigError('PIPULSE_TLS_CERT and PIPULSE_TLS_KEY must be set together');
  }
  const caPath = setting(env, 'PIPULSE_TLS_CA');
  const source: CertSource =
    certPath !== undefined && keyPath !== undefined
      ? { kind: 'operator', certPath, keyPath, ...(caPath !== undefined ? { caPath } : {}) }
      : { kind: 'generated', bundlePath: join(dir, 'leaf.pem'), caPath: join(dir, 'ca.crt') };

  const requireText = setting(env, 'PIPULSE_TLS_REQUIRE_VALID_CERT');
  if (requireText !== undefined && requireText !== 'true' && requireText !== 'false') {
    throw new TlsConfigError('PIPULSE_TLS_REQUIRE_VALID_CERT must be "true" or "false"');
  }
  const clockText = setting(env, 'PIPULSE_TLS_CLOCK');
  if (clockText !== undefined && clockText !== 'trust') {
    throw new TlsConfigError('PIPULSE_TLS_CLOCK must be "trust" or unset');
  }
  const names = (setting(env, 'PIPULSE_TLS_NAMES') ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');

  return {
    mode,
    modeReason,
    ...(stateMode !== undefined ? { stateMode } : {}),
    ...(mode === 'https' ? { source } : {}),
    requireValid: requireText === 'true',
    names,
    clockTrust: clockText === 'trust',
    dir,
    timesyncDir: setting(env, 'PIPULSE_TLS_TIMESYNC_DIR') ?? DEFAULT_TIMESYNC_DIR
  };
}
