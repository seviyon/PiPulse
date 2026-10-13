import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Run by absolute path with a fixed argv: nothing from a request or a file reaches a command line. */
export const APT_GET = '/usr/bin/apt-get';
export const APT_CACHE = '/usr/bin/apt-cache';
const APT_STAMP = '/var/lib/apt/periodic/update-success-stamp';
const APT_LISTS = '/var/lib/apt/lists';

/** At most this many packages are listed (the total is always exact). */
export const MAX_LISTED = 300;
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const FIRST_CHECK_MS = 2 * 60_000;
export const CHECK_INTERVAL_MS = 6 * 3_600_000;
/** `POST /api/updates/check` answers from the last check when it is this recent. */
export const MANUAL_GAP_MS = 30_000;

export interface UpgradablePackage {
  name: string;
  from: string;
  to: string;
}

export type UpdatesView =
  | { state: 'unsupported'; reason: 'container' | 'no-apt' }
  | { state: 'pending' }
  | { state: 'failed'; checkedAt: number; problem: string }
  | {
      state: 'ok';
      checkedAt: number;
      /** When the package lists were last refreshed (apt-daily, or `apt-get update`); null if unknown. */
      listsRefreshedAt: number | null;
      pipulse: {
        /** `apt`: installed as a package; `other`: a tarball install (or apt can't say). */
        source: 'apt' | 'other';
        installed: string | null;
        candidate: string | null;
        available: boolean;
      };
      os: { total: number; packages: UpgradablePackage[]; keptBack: string[] };
    };

/**
 * What `apt-get -s upgrade` would do: `Inst name [old] (new origin …)` per package it would
 * upgrade, and the names under "The following packages have been kept back:". A package it
 * would newly install (no `[old]`) is not an upgrade and is left out.
 */
export function parseSimulation(text: string): {
  packages: UpgradablePackage[];
  keptBack: string[];
  total: number;
} {
  const seen = new Set<string>();
  const packages: UpgradablePackage[] = [];
  let total = 0;
  const keptBack: string[] = [];
  let inKeptBack = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('The following packages have been kept back:')) {
      inKeptBack = true;
      continue;
    }
    if (inKeptBack) {
      if (/^ {2}\S/.test(line)) {
        for (const name of line.trim().split(/\s+/)) if (isPackageName(name)) keptBack.push(name);
        continue;
      }
      inKeptBack = false;
    }
    const inst = /^Inst (\S+) \[([^\]\s]+)\] \((\S+)/.exec(line);
    if (!inst || !isPackageName(inst[1]!) || seen.has(inst[1]!)) continue;
    seen.add(inst[1]!);
    total++;
    if (packages.length < MAX_LISTED)
      packages.push({ name: inst[1]!, from: inst[2]!, to: inst[3]! });
  }
  return { packages, keptBack: [...new Set(keptBack)].slice(0, MAX_LISTED), total };
}

/** Debian package names and versions are short ASCII words: anything else is not shown. */
const isPackageName = (name: string) => /^[a-z0-9][a-z0-9+.-]{0,99}$/.test(name);

/** `Installed:` and `Candidate:` from `apt-cache policy <package>`; "(none)" is no version. */
export function parsePolicy(text: string): { installed: string | null; candidate: string | null } {
  const field = (label: string) => {
    const match = new RegExp(`^ {2}${label}: (\\S+)`, 'm').exec(text);
    return match && match[1] !== '(none)' && /^[0-9A-Za-z.+:~-]{1,64}$/.test(match[1]!)
      ? match[1]!
      : null;
  };
  return { installed: field('Installed'), candidate: field('Candidate') };
}

export type Runner = (file: string, args: string[]) => Promise<string>;

/** The real runner: fixed environment, killed (not asked) when it overruns, output capped. */
export const runApt: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' }
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });

/** When the package lists were last refreshed: Debian's daily stamp, else the newest list file. */
export function listsRefreshedAt(stamp = APT_STAMP, lists = APT_LISTS): number | null {
  try {
    return statSync(stamp).mtimeMs;
  } catch {
    // no apt-daily stamp: fall through to the lists themselves
  }
  try {
    let newest: number | null = null;
    for (const name of readdirSync(lists)) {
      if (name === 'lock' || name === 'partial') continue;
      const mtime = statSync(join(lists, name)).mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    }
    return newest;
  } catch {
    return null;
  }
}

/** One short line for the page: apt's own `E:` line when it has one, no paths. */
const oneLine = (error: unknown) => {
  const lines = (error instanceof Error ? error.message : String(error))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const line = lines.find((l) => l.startsWith('E:')) ?? lines[0] ?? 'failed';
  return line.replace(/\/\S+/g, '…').slice(0, 160);
};

/** Whether `path` is a regular file (apt-get is installed). */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface UpdatesOptions {
  inContainer: boolean;
  run?: Runner;
  now?: () => number;
  monotonic?: () => number;
  listsRefreshedAt?: () => number | null;
  /** Whether apt-get exists here (tests). */
  aptPresent?: () => boolean;
  firstCheckMs?: number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface Updates {
  view(): UpdatesView;
  /** Checks now. `manual` answers from the last check when it finished less than MANUAL_GAP_MS ago. */
  check(options?: { manual?: boolean }): Promise<UpdatesView>;
  start(): void;
  stop(): void;
}

/**
 * Whether upgrades are waiting, checked on a timer by simulating `apt-get upgrade` as the
 * service user (no root, no network, no lock). Held in memory only; a restart checks again.
 * A container's apt is not the host's, so nothing is run there.
 */
export function createUpdates(options: UpdatesOptions): Updates {
  const run = options.run ?? runApt;
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const aptPresent = options.aptPresent ?? (() => isFile(APT_GET));
  let current: UpdatesView = options.inContainer
    ? { state: 'unsupported', reason: 'container' }
    : { state: 'pending' };
  let running: Promise<UpdatesView> | undefined;
  let finishedAt: number | undefined;
  let first: NodeJS.Timeout | undefined;
  let every: NodeJS.Timeout | undefined;

  const doCheck = async (): Promise<UpdatesView> => {
    if (options.inContainer) return current;
    if (!aptPresent()) return (current = { state: 'unsupported', reason: 'no-apt' });
    try {
      const simulation = parseSimulation(
        await run(APT_GET, ['-s', '-o', 'Debug::NoLocking=1', 'upgrade'])
      );
      let policy: { installed: string | null; candidate: string | null } = {
        installed: null,
        candidate: null
      };
      try {
        policy = parsePolicy(await run(APT_CACHE, ['policy', 'pipulse']));
      } catch {
        // not a package here (a tarball install): reported as `other`
      }
      current = {
        state: 'ok',
        checkedAt: now(),
        listsRefreshedAt: (options.listsRefreshedAt ?? listsRefreshedAt)(),
        pipulse: {
          source: policy.installed ? 'apt' : 'other',
          installed: policy.installed,
          candidate: policy.candidate,
          available:
            simulation.packages.some((p) => p.name === 'pipulse') ||
            simulation.keptBack.includes('pipulse')
        },
        os: {
          total: simulation.total,
          packages: simulation.packages,
          keptBack: simulation.keptBack
        }
      };
    } catch (error) {
      options.onError?.(error);
      current = { state: 'failed', checkedAt: now(), problem: oneLine(error) };
    }
    return current;
  };

  const check: Updates['check'] = (opts = {}) => {
    if (running) return running;
    if (
      opts.manual &&
      finishedAt !== undefined &&
      monotonic() - finishedAt < MANUAL_GAP_MS &&
      current.state !== 'pending'
    )
      return Promise.resolve(current);
    running = doCheck().finally(() => {
      finishedAt = monotonic();
      running = undefined;
    });
    return running;
  };

  return {
    view: () => current,
    check,
    start() {
      if (options.inContainer || first || every) return;
      first = setTimeout(() => {
        void check();
        every = setInterval(() => void check(), options.intervalMs ?? CHECK_INTERVAL_MS);
        every.unref();
      }, options.firstCheckMs ?? FIRST_CHECK_MS);
      first.unref();
    },
    stop() {
      if (first) clearTimeout(first);
      if (every) clearInterval(every);
      first = every = undefined;
    }
  };
}
