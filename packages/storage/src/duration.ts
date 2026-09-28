// No database imports here: packages that only parse durations (e.g. the notify
// file for notify-test) import this as @pipulse/storage/duration, which never
// loads node:sqlite and so never prints its ExperimentalWarning.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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
