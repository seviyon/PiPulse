import { chmodSync, closeSync, openSync, statSync } from 'node:fs';

/** A path SQLite treats as a real file (not in memory, not a `file:` URI). */
const isFilePath = (path: string): boolean =>
  path !== '' && path !== ':memory:' && !path.startsWith('file:');

/**
 * Makes a new database file owner-only before SQLite creates it, so its readings are never
 * world-readable, not even for the moment between creating the file and tightening it. A path SQLite
 * would create anyway but that can't be made here (no such folder, no permission) is left for
 * SQLite to report in its own words.
 */
export function createPrivate(path: string): void {
  if (!isFilePath(path)) return;
  try {
    closeSync(openSync(path, 'a', 0o600));
  } catch {
    // SQLite opens the file next and says what is wrong.
  }
}

/**
 * Takes group and other access off the database and its WAL and shared-memory files (SQLite gives
 * them the main file's mode, but a file made by an older version may be 0644 and its siblings
 * with it). Best effort: a file another user owns cannot be changed from here, and that must not
 * stop the server from starting.
 */
export function tightenPrivate(path: string): void {
  if (!isFilePath(path)) return;
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    } catch {
      // missing (no WAL yet), not ours, or a read-only mount
    }
  }
}
