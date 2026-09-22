import type { DatabaseSync } from 'node:sqlite';

export type Resolution = 'raw' | '1m' | '1h' | '1d';
type RollupResolution = Exclude<Resolution, 'raw'>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How long each resolution is kept, in ms. `Infinity` keeps it forever. */
export type RetentionPolicy = Record<Resolution, number>;

/** Raw 2 days, 1-minute 14 days, hourly 1 year, daily forever (~35 MB for the built-in plugins). */
export const DEFAULT_RETENTION: RetentionPolicy = {
  raw: 2 * DAY,
  '1m': 14 * DAY,
  '1h': 365 * DAY,
  '1d': Infinity
};

/** Each rollup level is built from the one before it. Daily buckets are UTC days. */
const levels: { resolution: RollupResolution; bucketMs: number; source: Resolution }[] = [
  { resolution: '1m', bucketMs: MIN, source: 'raw' },
  { resolution: '1h', bucketMs: HOUR, source: '1m' },
  { resolution: '1d', bucketMs: DAY, source: '1h' }
];

/** The bucket size assumed for raw data when choosing a resolution (the fastest poll interval). */
const RAW_STEP_MS = 5000;
const bucketMs: Record<Resolution, number> = { raw: RAW_STEP_MS, '1m': MIN, '1h': HOUR, '1d': DAY };

/** Charts stay responsive (and the Pi's reply small) under this many points. */
const MAX_POINTS = 1500;

const floorTo = (ts: number, step: number) => Math.floor(ts / step) * step;

function rollUp(
  db: DatabaseSync,
  level: (typeof levels)[number],
  start: number,
  end: number
): number {
  const { resolution, bucketMs: step, source } = level;
  const statement =
    source === 'raw'
      ? `INSERT OR REPLACE INTO metrics_rollup (ts, metric, resolution, avg, min, max, count)
         SELECT (ts / ${step}) * ${step}, metric, '${resolution}', AVG(value), MIN(value), MAX(value), COUNT(*)
         FROM metrics WHERE ts >= ? AND ts < ? AND value IS NOT NULL
         GROUP BY metric, (ts / ${step})`
      : // Weighted by count, so a minute with 12 samples outweighs one with 2.
        `INSERT OR REPLACE INTO metrics_rollup (ts, metric, resolution, avg, min, max, count)
         SELECT (ts / ${step}) * ${step}, metric, '${resolution}',
                SUM(avg * count) / SUM(count), MIN(min), MAX(max), SUM(count)
         FROM metrics_rollup WHERE resolution = '${source}' AND ts >= ? AND ts < ?
         GROUP BY metric, (ts / ${step})`;
  return Number(db.prepare(statement).run(start, end).changes);
}

/** Where the next run of `level` should start: after its newest bucket, or at the oldest source data. */
function nextStart(db: DatabaseSync, level: (typeof levels)[number]): number | undefined {
  const newest = db
    .prepare('SELECT MAX(ts) AS ts FROM metrics_rollup WHERE resolution = ?')
    .get(level.resolution) as { ts: number | null };
  if (newest.ts !== null) return newest.ts + level.bucketMs;
  const oldest = (
    level.source === 'raw'
      ? db.prepare('SELECT MIN(ts) AS ts FROM metrics').get()
      : db
          .prepare('SELECT MIN(ts) AS ts FROM metrics_rollup WHERE resolution = ?')
          .get(level.source)
  ) as { ts: number | null };
  return oldest.ts === null ? undefined : floorTo(oldest.ts, level.bucketMs);
}

export interface HousekeepingResult {
  /** Buckets written per level. */
  rolledUp: Record<RollupResolution, number>;
  /** Rows deleted per resolution. */
  pruned: Record<Resolution, number>;
}

/**
 * Rolls complete buckets up (raw → 1m → 1h → 1d) and deletes data past its
 * retention — but only data the next level already covers, so nothing is
 * lost if a rollup falls behind. Safe to run as often as you like; each
 * run only touches buckets that closed since the last one.
 */
export function runHousekeeping(
  db: DatabaseSync,
  now: number = Date.now(),
  retention: RetentionPolicy = DEFAULT_RETENTION
): HousekeepingResult {
  const rolledUp: HousekeepingResult['rolledUp'] = { '1m': 0, '1h': 0, '1d': 0 };
  const pruned: HousekeepingResult['pruned'] = { raw: 0, '1m': 0, '1h': 0, '1d': 0 };
  // Everything before `complete[r]` is final at resolution r after this run.
  const complete: Record<Resolution, number> = { raw: now, '1m': now, '1h': now, '1d': now };

  db.exec('BEGIN');
  try {
    for (const level of levels) {
      // A bucket closes when its time has passed *and* its source level is final that far.
      const end = floorTo(complete[level.source], level.bucketMs);
      complete[level.resolution] = end;
      const start = nextStart(db, level);
      if (start !== undefined && start < end) {
        rolledUp[level.resolution] = rollUp(db, level, start, end);
      }
    }

    const coveredUntil: Record<Resolution, number> = {
      raw: complete['1m'],
      '1m': complete['1h'],
      '1h': complete['1d'],
      '1d': Infinity
    };
    for (const resolution of ['raw', '1m', '1h', '1d'] as const) {
      if (!Number.isFinite(retention[resolution])) continue;
      const cutoff = Math.min(now - retention[resolution], coveredUntil[resolution]);
      pruned[resolution] = Number(
        (resolution === 'raw'
          ? db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff)
          : db
              .prepare('DELETE FROM metrics_rollup WHERE resolution = ? AND ts < ?')
              .run(resolution, cutoff)
        ).changes
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { rolledUp, pruned };
}

/** One chart point. For raw samples avg, min and max are all the sampled value. */
export interface SeriesPoint {
  ts: number;
  avg: number;
  min: number;
  max: number;
}

/** A metric's points within an inclusive [from, to] window at one resolution, oldest first. */
export function getSeries(
  db: DatabaseSync,
  metric: string,
  from: number,
  to: number,
  resolution: Resolution
): SeriesPoint[] {
  const rows =
    resolution === 'raw'
      ? db
          .prepare(
            'SELECT ts, value AS avg, value AS min, value AS max FROM metrics WHERE metric = ? AND ts BETWEEN ? AND ? ORDER BY ts'
          )
          .all(metric, from, to)
      : db
          .prepare(
            'SELECT ts, avg, min, max FROM metrics_rollup WHERE metric = ? AND resolution = ? AND ts BETWEEN ? AND ? ORDER BY ts'
          )
          .all(metric, resolution, from, to);
  return rows as unknown as SeriesPoint[];
}

/**
 * The finest resolution that still covers `from` under the retention
 * policy and keeps the [from, to] window under MAX_POINTS points.
 */
export function chooseResolution(
  from: number,
  to: number,
  now: number = Date.now(),
  retention: RetentionPolicy = DEFAULT_RETENTION
): Resolution {
  const span = Math.max(0, to - from);
  for (const resolution of ['raw', '1m', '1h'] as const) {
    const retained = from >= now - retention[resolution];
    if (retained && span / bucketMs[resolution] <= MAX_POINTS) return resolution;
  }
  return '1d';
}

export interface HousekeepingOptions {
  /** How often to run; defaults to every minute, so 1-minute rollups stay current. */
  intervalMs?: number;
  retention?: RetentionPolicy;
  onResult?: (result: HousekeepingResult) => void;
  onError?: (error: unknown) => void;
}

/**
 * Runs housekeeping now and then every `intervalMs`. A failed run is
 * reported via `onError` and the next one still happens.
 */
export function startHousekeeping(
  db: DatabaseSync,
  options: HousekeepingOptions = {}
): { stop(): void } {
  const run = () => {
    try {
      // Not `onResult?.(runHousekeeping(…))`: an optional call skips evaluating
      // its arguments, so housekeeping would silently never run without onResult.
      const result = runHousekeeping(db, Date.now(), options.retention);
      options.onResult?.(result);
    } catch (error) {
      options.onError?.(error);
    }
  };
  run();
  const timer = setInterval(run, options.intervalMs ?? MIN);
  return { stop: () => clearInterval(timer) };
}

const durationUnits: Record<string, number> = { h: HOUR, d: DAY, w: 7 * DAY, y: 365 * DAY };

/** "36h", "14d", "2w", "1y" or "forever" → ms. Throws naming `variable` on anything else. */
function parseDuration(variable: string, value: string): number {
  const text = value.trim().toLowerCase();
  if (text === 'forever') return Infinity;
  const match = /^(\d+(?:\.\d+)?)([hdwy])$/.exec(text);
  const amount = match ? Number(match[1]) : NaN;
  if (!match || !(amount > 0)) {
    // No "m": it would be ambiguous between minutes and months.
    throw new Error(
      `${variable} must be a duration like 36h, 14d, 2w, 1y or forever (got ${JSON.stringify(value)})`
    );
  }
  return amount * durationUnits[match[2]!]!;
}

/**
 * Reads PIPULSE_RETENTION_RAW / _1M / _1H / _1D, falling back to
 * DEFAULT_RETENTION for any that are unset. Throws on an invalid value so
 * a typo stops the server at startup instead of silently keeping (or
 * deleting) the wrong amount of history.
 */
export function retentionFromEnv(env: Record<string, string | undefined>): RetentionPolicy {
  const policy = { ...DEFAULT_RETENTION };
  for (const [resolution, suffix] of [
    ['raw', 'RAW'],
    ['1m', '1M'],
    ['1h', '1H'],
    ['1d', '1D']
  ] as const) {
    const variable = `PIPULSE_RETENTION_${suffix}`;
    const value = env[variable];
    if (value !== undefined) policy[resolution] = parseDuration(variable, value);
  }
  return policy;
}
