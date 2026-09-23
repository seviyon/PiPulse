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

/** Start of the local day (server timezone, `TZ`) containing `ts`. */
function localDayStart(ts: number): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Start of the local day after the one starting at `dayStart`; 23 or 25 hours later across DST. */
function nextLocalDay(dayStart: number): number {
  const date = new Date(dayStart);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

interface Level {
  resolution: RollupResolution;
  source: Resolution;
  /** Start of the bucket containing `ts`. */
  bucketStart(ts: number): number;
  /** Start of the bucket after the one starting at `start`. */
  nextBucket(start: number): number;
}

const fixed = (step: number) => ({
  bucketStart: (ts: number) => floorTo(ts, step),
  nextBucket: (start: number) => start + step
});

/**
 * Each rollup level is built from a finer one. Minutes and hours are fixed
 * UTC-aligned buckets. Days are the server's local calendar days, built
 * from 1-minute rollups rather than hours so they stay correct in
 * timezones whose offset isn't a whole hour; 1-minute retention (14 days
 * by default) always outlasts a day.
 */
const levels: Level[] = [
  { resolution: '1m', source: 'raw', ...fixed(MIN) },
  { resolution: '1h', source: '1m', ...fixed(HOUR) },
  { resolution: '1d', source: '1m', bucketStart: localDayStart, nextBucket: nextLocalDay }
];

/** Charts stay responsive (and the Pi's reply small) under this many points. */
const MAX_POINTS = 1500;

const floorTo = (ts: number, step: number) => Math.floor(ts / step) * step;

function rollUp(db: DatabaseSync, level: Level, start: number, end: number): number {
  if (level.resolution === '1d') return rollUpDays(db, start, end);
  const step = level.nextBucket(0);
  const { resolution, source } = level;
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

/**
 * Adds a partial aggregate into a daily row: count-weighted mean, wider
 * min/max, summed count. A day is written in more than one piece when a
 * run starts partway through it (after the schema 3 migration, or after the
 * server's timezone changes), and the pieces never overlap, so merging is
 * exact where replacing would drop the earlier piece.
 */
const MERGE_DAY = `ON CONFLICT (metric, resolution, ts) DO UPDATE SET
  avg = (avg * count + excluded.avg * excluded.count) / (count + excluded.count),
  min = MIN(min, excluded.min),
  max = MAX(max, excluded.max),
  count = count + excluded.count`;

/**
 * Local days have no fixed length, so they can't be grouped in SQL by
 * dividing timestamps; [start, end) is cut at local midnights and each
 * piece aggregated into the row of the local day it falls in. Usually that
 * is zero or one day. `start` is where the last run stopped, which is a
 * local midnight except after a timezone change; the piece before the next
 * midnight is then merged into that day's row, so no minute is counted
 * twice or skipped.
 */
function rollUpDays(db: DatabaseSync, start: number, end: number): number {
  const statement = db.prepare(
    `INSERT INTO metrics_rollup (ts, metric, resolution, avg, min, max, count)
     SELECT ?, metric, '1d', SUM(avg * count) / SUM(count), MIN(min), MAX(max), SUM(count)
     FROM metrics_rollup WHERE resolution = '1m' AND ts >= ? AND ts < ?
     GROUP BY metric
     ${MERGE_DAY}`
  );
  let written = 0;
  for (let from = start; from < end;) {
    const day = localDayStart(from);
    const to = Math.min(nextLocalDay(day), end);
    written += Number(statement.run(day, from, to).changes);
    from = to;
  }
  db.prepare(
    `INSERT INTO rollup_progress (resolution, until) VALUES ('1d', ?)
     ON CONFLICT (resolution) DO UPDATE SET until = excluded.until`
  ).run(end);
  return written;
}

/**
 * Where the next run of `level` should start: where daily rollups last
 * stopped, after the level's newest bucket, or at the oldest source data.
 * Days track where they stopped rather than deriving it from the newest
 * row, since that row's end depends on the timezone it was written in.
 */
function nextStart(db: DatabaseSync, level: Level): number | undefined {
  if (level.resolution === '1d') {
    const progress = db
      .prepare("SELECT until FROM rollup_progress WHERE resolution = '1d'")
      .get() as { until: number } | undefined;
    if (progress) return progress.until;
  }
  const newest = db
    .prepare('SELECT MAX(ts) AS ts FROM metrics_rollup WHERE resolution = ?')
    .get(level.resolution) as { ts: number | null };
  if (newest.ts !== null) return level.nextBucket(newest.ts);
  const oldest = (
    level.source === 'raw'
      ? db.prepare('SELECT MIN(ts) AS ts FROM metrics').get()
      : db
          .prepare('SELECT MIN(ts) AS ts FROM metrics_rollup WHERE resolution = ?')
          .get(level.source)
  ) as { ts: number | null };
  return oldest.ts === null ? undefined : level.bucketStart(oldest.ts);
}

export interface HousekeepingResult {
  /** Buckets written per level. */
  rolledUp: Record<RollupResolution, number>;
  /** Rows deleted per resolution. */
  pruned: Record<Resolution, number>;
  /** Cleared alerts deleted for being older than a year. */
  alertsPruned: number;
}

/**
 * Rolls complete buckets up (raw → 1m → 1h, and 1m → local days) and deletes data past its
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
  let alertsPruned!: number;
  // Everything before `complete[r]` is final at resolution r after this run.
  const complete: Record<Resolution, number> = { raw: now, '1m': now, '1h': now, '1d': now };

  db.exec('BEGIN');
  try {
    for (const level of levels) {
      // A bucket closes when its time has passed *and* its source level is final that far.
      const end = level.bucketStart(complete[level.source]);
      complete[level.resolution] = end;
      const start = nextStart(db, level);
      if (start !== undefined && start < end) {
        rolledUp[level.resolution] = rollUp(db, level, start, end);
      }
    }

    // What each resolution feeds must already be rolled up before it is pruned.
    const coveredUntil: Record<Resolution, number> = {
      raw: complete['1m'],
      '1m': Math.min(complete['1h'], complete['1d']),
      '1h': Infinity,
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

    // Alert history: a year of cleared alerts; open ones stay however old.
    alertsPruned = Number(
      db
        .prepare('DELETE FROM alerts WHERE cleared_at IS NOT NULL AND cleared_at < ?')
        .run(now - 365 * DAY).changes
    );

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { rolledUp, pruned, alertsPruned };
}

/** One chart point. For raw samples avg, min and max are all the sampled value. */
export interface SeriesPoint {
  ts: number;
  avg: number;
  min: number;
  max: number;
  /** Raw samples the point stands for: 1 for a raw sample, the bucket's count for a rollup. */
  count: number;
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
            'SELECT ts, value AS avg, value AS min, value AS max, 1 AS count FROM metrics WHERE metric = ? AND ts BETWEEN ? AND ? ORDER BY ts'
          )
          .all(metric, from, to)
      : db
          .prepare(
            'SELECT ts, avg, min, max, count FROM metrics_rollup WHERE metric = ? AND resolution = ? AND ts BETWEEN ? AND ? ORDER BY ts'
          )
          .all(metric, resolution, from, to);
  return rows as unknown as SeriesPoint[];
}

/**
 * Whether `metric` has more than MAX_POINTS rows at `resolution` in the
 * window. The inner LIMIT stops the primary-key scan at MAX_POINTS + 1, so
 * this costs at most that many index steps however large the table is.
 */
function tooManyPoints(
  db: DatabaseSync,
  metric: string,
  from: number,
  to: number,
  resolution: Resolution
): boolean {
  const sql =
    resolution === 'raw'
      ? 'SELECT COUNT(*) AS n FROM (SELECT 1 FROM metrics WHERE metric = ? AND ts BETWEEN ? AND ? LIMIT ?)'
      : `SELECT COUNT(*) AS n FROM (SELECT 1 FROM metrics_rollup WHERE metric = ? AND resolution = '${resolution}' AND ts BETWEEN ? AND ? LIMIT ?)`;
  const { n } = db.prepare(sql).get(metric, from, to, MAX_POINTS + 1) as { n: number };
  return n > MAX_POINTS;
}

/** The oldest timestamp `metric` has at any resolution, or undefined without data. */
function oldestTs(db: DatabaseSync, metric: string): number | undefined {
  const { ts } = db
    .prepare(
      `SELECT MIN(ts) AS ts FROM (
         SELECT MIN(ts) AS ts FROM metrics WHERE metric = ?1
         UNION ALL SELECT MIN(ts) FROM metrics_rollup WHERE metric = ?1 AND resolution = '1m'
         UNION ALL SELECT MIN(ts) FROM metrics_rollup WHERE metric = ?1 AND resolution = '1h'
         UNION ALL SELECT MIN(ts) FROM metrics_rollup WHERE metric = ?1 AND resolution = '1d'
       )`
    )
    .get(metric) as { ts: number | null };
  return ts ?? undefined;
}

/**
 * The finest resolution that is complete across [from, to] and holds at
 * most MAX_POINTS rows for `metric` there. Counting the rows actually
 * there, rather than estimating from the span, matters on a young
 * database: coarse levels fill in only as their buckets complete (the first
 * hourly row after an hour), so a 7-day view shows the minutes collected so
 * far instead of nothing. On a mature database the counts match the span.
 */
export function chooseResolution(
  db: DatabaseSync,
  metric: string,
  from: number,
  to: number,
  now: number = Date.now(),
  retention: RetentionPolicy = DEFAULT_RETENTION
): Resolution {
  const oldest = oldestTs(db, metric);
  for (const resolution of ['raw', '1m', '1h'] as const) {
    // Pruning deletes rows older than the cutoff, so a level is whole in the
    // window if the window starts after it, or if nothing this old was ever
    // collected (a young database, where nothing has been pruned yet).
    // Otherwise it would show only its tail.
    const cutoff = now - retention[resolution];
    const complete = from >= cutoff || (oldest !== undefined && oldest >= cutoff);
    if (complete && !tooManyPoints(db, metric, from, to, resolution)) return resolution;
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

const durationUnits: Record<string, number> = {
  s: 1000,
  min: MIN,
  h: HOUR,
  d: DAY,
  w: 7 * DAY,
  y: 365 * DAY
};

/**
 * "30s", "5min", "36h", "14d", "2w", "1y" or "forever" → ms. Throws naming
 * `name` on anything else. No bare "m": it would be ambiguous between
 * minutes and months. Zero is rejected unless `allowZero` (a retention of
 * nothing would delete every row; an alert may fire on a single reading).
 */
export function parseDuration(
  name: string,
  value: string,
  { allowZero = false }: { allowZero?: boolean } = {}
): number {
  const text = value.trim().toLowerCase();
  if (text === 'forever') return Infinity;
  const match = /^(\d+(?:\.\d+)?)(s|min|h|d|w|y)$/.exec(text);
  const amount = match ? Number(match[1]) : NaN;
  if (!match || !(amount > 0 || (allowZero && amount === 0))) {
    throw new Error(
      `${name} must be a duration like 30s, 5min, 36h, 14d, 2w, 1y or forever (got ${JSON.stringify(value)})`
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
