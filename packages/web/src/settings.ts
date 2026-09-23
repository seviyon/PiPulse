import { formatDateTime, formatValue } from './format.js';
import type { Resolution } from './types.js';

export const LEVELS = ['raw', '1m', '1h', '1d'] as const satisfies readonly Resolution[];

export const LEVEL_LABELS: Record<Resolution, string> = {
  raw: 'Raw readings',
  '1m': '1-minute averages',
  '1h': 'Hourly averages',
  '1d': 'Daily averages'
};

/** Lower-case, for sentences: "Deletes ~41,000 raw readings". */
const LEVEL_NOUNS: Record<Resolution, string> = {
  raw: 'raw readings',
  '1m': '1-minute averages',
  '1h': 'hourly averages',
  '1d': 'daily averages'
};

export interface LevelSetting {
  text: string;
  ms: number | null;
  source: 'env' | 'saved' | 'default';
  variable: string;
  locked: boolean;
}

export interface SettingsBody {
  retention: Record<Resolution, LevelSetting>;
  storage: {
    fileBytes: number;
    freeBytes: number;
    diskFreeBytes: number | null;
    levels: Record<Resolution, { rows: number; oldest: number | null }>;
  };
}

export interface LevelDeletion {
  deletesRows: number;
  from: number | null;
  to: number | null;
}

export interface Preview {
  deletions: Record<Resolution, LevelDeletion>;
  estimatedBytes: number;
}

/**
 * The server's duration grammar, for feedback while typing. The server
 * stays the authority (its preview reports errors per field).
 */
const UNIT_MS: Record<string, number> = {
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  y: 365 * 86_400_000
};

/** A duration in ms (Infinity for "forever"), or undefined if it isn't one. */
function durationMs(text: string): number | undefined {
  const value = text.trim().toLowerCase();
  if (value === 'forever') return Infinity;
  const match = /^(\d+(?:\.\d+)?)(s|min|h|d|w|y)$/.exec(value);
  const amount = Number(match?.[1]);
  return match && amount > 0 ? amount * UNIT_MS[match[2]!]! : undefined;
}

export function checkDuration(text: string): string | undefined {
  return durationMs(text) === undefined
    ? 'Use a duration like 30s, 5min, 36h, 14d, 2w, 1y or forever.'
    : undefined;
}

export function changed(body: SettingsBody, draft: Record<Resolution, string>): Resolution[] {
  return LEVELS.filter((level) => draft[level].trim() !== body.retention[level].text);
}

export function formatBytes(bytes: number): string {
  const { text, unit } = formatValue(bytes, 'B');
  return `${text} ${unit}`;
}

export function describeChange(
  resolution: Resolution,
  deletion: LevelDeletion,
  before: LevelSetting,
  after: string
): { deletes: boolean; text: string } {
  if (deletion.deletesRows > 0 && deletion.from !== null && deletion.to !== null) {
    return {
      deletes: true,
      text: `Deletes ~${deletion.deletesRows.toLocaleString('en-US')} ${LEVEL_NOUNS[resolution]} from ${formatDateTime(deletion.from)} to ${formatDateTime(deletion.to)} within a minute`
    };
  }
  const beforeMs = before.ms ?? Infinity;
  const afterMs = durationMs(after) ?? beforeMs;
  if (afterMs < beforeMs) {
    return { deletes: false, text: 'Keeps less from now on. Nothing is old enough to delete yet.' };
  }
  return {
    deletes: false,
    text: "Keeps more from now on. Already-deleted data doesn't come back."
  };
}
