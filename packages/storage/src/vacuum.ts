import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const DAY = 86_400_000;

export type VacuumResult =
  | { ran: true; beforeBytes: number; afterBytes: number; ms: number }
  | { ran: false; reason: string };

export interface VacuumOptions {
  /** Free pages as a share of the file that make a vacuum worth it (default 0.25). */
  minFreeFraction?: number;
  /** Smaller files are never vacuumed (default 8 MB). */
  minFileBytes?: number;
  /** Minimum time between attempts (default a day). */
  everyMs?: number;
  /** Free bytes on the database's disk; injectable for tests. */
  diskFree?: (db: DatabaseSync) => number | undefined;
  onVacuum?: (result: VacuumResult) => void;
}

/** The main database file's path, or undefined for an in-memory database. */
export function databaseFile(db: DatabaseSync): string | undefined {
  const rows = db.prepare('PRAGMA database_list').all() as unknown as {
    name: string;
    file: string;
  }[];
  const file = rows.find((row) => row.name === 'main')?.file;
  return file ? file : undefined;
}

/** The database's logical size and how much of it is free pages. */
export function fileUsage(db: DatabaseSync): { fileBytes: number; freeBytes: number } {
  const pragma = (name: string) =>
    Number(Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[0]);
  const pageSize = pragma('page_size');
  return {
    fileBytes: pragma('page_count') * pageSize,
    freeBytes: pragma('freelist_count') * pageSize
  };
}

/** Free bytes available to PiPulse on the database's filesystem. */
export function diskFreeBytes(db: DatabaseSync): number | undefined {
  const file = databaseFile(db);
  if (!file) return undefined;
  try {
    const stats = statfsSync(dirname(file));
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}

/**
 * Compacts the database when deletes have left much of it free, so the
 * file shrinks after a retention cut. `undefined` means nothing was needed;
 * a skip for lack of disk space counts as an attempt, so it is logged at
 * most once per `everyMs`.
 */
export function maybeVacuum(
  db: DatabaseSync,
  now: number,
  lastAttemptAt: number | undefined,
  options: VacuumOptions = {}
): VacuumResult | undefined {
  const {
    minFreeFraction = 0.25,
    minFileBytes = 8 * 1024 * 1024,
    everyMs = DAY,
    diskFree = diskFreeBytes
  } = options;
  if (!databaseFile(db)) return undefined;
  if (lastAttemptAt !== undefined && now - lastAttemptAt < everyMs) return undefined;
  const { fileBytes, freeBytes } = fileUsage(db);
  if (fileBytes <= minFileBytes || freeBytes < fileBytes * minFreeFraction) return undefined;

  const available = diskFree(db);
  if (available === undefined || available < fileBytes * 1.1) {
    return {
      ran: false,
      reason: `not enough free disk space for a ${Math.ceil(fileBytes / 1e6)} MB copy`
    };
  }
  const started = performance.now();
  db.exec('VACUUM');
  // In WAL mode VACUUM goes through the log; checkpoint so the file itself shrinks.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return {
    ran: true,
    beforeBytes: fileBytes,
    afterBytes: fileUsage(db).fileBytes,
    ms: Math.round(performance.now() - started)
  };
}
