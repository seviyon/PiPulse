import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APT_GET = '/usr/bin/apt-get';
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Whether the apt repositories answered, as one word and two counts, never a name or address:
 * apt sources have no friendly names, and apt's own lines carry URLs that may hold credentials.
 *
 * `ok` every source answered with metadata that passed apt's signature check; `partial` some did;
 * `failed` none did, or the check could not run; `no-sources` apt has none configured.
 */
export type ReachState = 'ok' | 'partial' | 'failed' | 'no-sources';

export interface ReachResult {
  state: ReachState;
  reached: number;
  total: number;
}

/**
 * Reads what `apt-get update` printed, not its exit status: offline it exits 0 with only
 * `W: Failed to fetch`, and a bad signature exits 100 with the other sources still fine
 * (apt 2.2.4 and 2.6.2, tested). Every source prints one `Get:N`/`Hit:N` line for its
 * `InRelease`, and an `Err:N` with the same N when it failed, even after a `Get:N` (a signature
 * that did not verify). A source with no `InRelease` falls back to `Release` + `Release.gpg`,
 * which both have to come through. `Ign:` is a source apt skipped on purpose: not reached.
 */
export function parseReach(text: string): ReachResult {
  // One source is "<url> <suite>"; apt asks for its InRelease and, only when that is missing,
  // for Release and Release.gpg, each under its own line number.
  const lines = new Map<string, { source: string; file: string; ok: boolean }>();
  for (const line of text.split('\n')) {
    const match =
      /^(Get|Hit|Ign|Err):(\d+) (.*?)\s*(InRelease|Release\.gpg|Release)(?:\s.*)?$/.exec(line);
    if (!match) continue;
    const id = match[2]!;
    const seen = lines.get(id);
    // A Get line is followed by an Err line with the same number when the signature did not verify.
    const ok = match[1] === 'Get' || match[1] === 'Hit';
    lines.set(id, { source: match[3]!, file: match[4]!, ok: ok && (seen?.ok ?? true) });
  }
  const sources = new Map<string, Map<string, boolean>>();
  for (const { source, file, ok } of lines.values()) {
    const files = sources.get(source) ?? new Map<string, boolean>();
    files.set(file, (files.get(file) ?? false) || ok);
    sources.set(source, files);
  }
  const total = sources.size;
  let reached = 0;
  for (const files of sources.values()) {
    if (files.get('InRelease') || (files.get('Release') && files.get('Release.gpg'))) reached++;
  }
  if (total === 0) return { state: 'no-sources', reached: 0, total: 0 };
  if (reached === total) return { state: 'ok', reached, total };
  return { state: reached === 0 ? 'failed' : 'partial', reached, total };
}

/** Runs apt-get with `args` and resolves its stdout whatever the exit status (a non-zero exit still says which source failed). */
export type ReachRunner = (args: string[]) => Promise<string>;

export const runReach: ReachRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      APT_GET,
      args,
      {
        timeout: TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' }
      },
      (error, stdout) => {
        // A timeout or a kill leaves nothing to read; an ordinary non-zero exit is an answer.
        if (error && (error.killed || (error as NodeJS.ErrnoException).code === 'ENOENT'))
          reject(error);
        else resolve(String(stdout));
      }
    );
  });

/** The options that make `apt-get update` fetch only the `InRelease` files into a private folder. */
export function reachArgs(dir: string): string[] {
  const off = (target: string) => `-oAcquire::IndexTargets::deb::${target}::DefaultEnabled=false`;
  return [
    'update',
    `-oDir::State::lists=${join(dir, 'lists')}`,
    `-oDir::Cache=${join(dir, 'cache')}`,
    '-oDebug::NoLocking=1',
    '-oAPT::Get::List-Cleanup=0',
    '-oAcquire::Languages=none',
    '-oAcquire::Retries=0',
    '-oAcquire::http::Timeout=10',
    '-oAcquire::https::Timeout=10',
    ...[
      'Packages',
      'Contents-deb',
      'Contents-udeb',
      'CNF',
      'DEP-11',
      'DEP-11-icons-small',
      'DEP-11-icons',
      'DEP-11-icons-large'
    ].map(off)
  ];
}

/**
 * Asks every configured repository for its signed `InRelease`, as the service user, into a
 * private folder that is removed afterwards whatever happened (the system's lists are never
 * touched, nothing is installed). Throws when apt could not be run or overran its time.
 */
export async function checkReach(run: ReachRunner = runReach): Promise<ReachResult> {
  const dir = mkdtempSync(join(tmpdir(), 'pipulse-apt-'));
  try {
    mkdirSync(join(dir, 'lists', 'partial'), { recursive: true });
    mkdirSync(join(dir, 'cache', 'archives', 'partial'), { recursive: true });
    return parseReach(await run(reachArgs(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
