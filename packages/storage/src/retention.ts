import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_RETENTION,
  parseDuration,
  type Resolution,
  type RetentionPolicy
} from './rollup.js';
import { getSettings, saveSettings } from './settings.js';

export const RESOLUTIONS = ['raw', '1m', '1h', '1d'] as const;

export const RETENTION_VARIABLES: Record<Resolution, string> = {
  raw: 'PIPULSE_RETENTION_RAW',
  '1m': 'PIPULSE_RETENTION_1M',
  '1h': 'PIPULSE_RETENTION_1H',
  '1d': 'PIPULSE_RETENTION_1D'
};

/** DEFAULT_RETENTION as the text the Settings page shows. */
export const DEFAULT_RETENTION_TEXT: Record<Resolution, string> = {
  raw: '2d',
  '1m': '14d',
  '1h': '1y',
  '1d': 'forever'
};

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  raw: 'raw',
  '1m': '1-minute',
  '1h': 'hourly',
  '1d': 'daily'
};

export interface RetentionLevel {
  /** As typed ("30d"), so the page shows it back unchanged. */
  text: string;
  /** Infinity for "forever". */
  ms: number;
  source: 'env' | 'saved' | 'default';
  /** The environment variable that sets this level (and locks it when set). */
  variable: string;
}

export type RetentionSettings = Record<Resolution, RetentionLevel>;

/** The longest look-back among the alert rules: raw retention may not be shorter. */
export interface LookBack {
  ms: number;
  ruleId: string;
  text: string;
}

export type RetentionCheck =
  | { ok: true; levels: RetentionSettings }
  | { ok: false; errors: Partial<Record<Resolution, string>> };

const settingKey = (resolution: Resolution) => `retention.${resolution}`;

export function policyOf(levels: RetentionSettings): RetentionPolicy {
  return {
    raw: levels.raw.ms,
    '1m': levels['1m'].ms,
    '1h': levels['1h'].ms,
    '1d': levels['1d'].ms
  };
}

/**
 * The first pair kept out of order (a level longer than the next one).
 * Housekeeping needs each level to cover the one below it.
 */
function outOfOrder(levels: RetentionSettings): [Resolution, Resolution] | undefined {
  for (let i = 1; i < RESOLUTIONS.length; i++) {
    const shorter = RESOLUTIONS[i - 1]!;
    const longer = RESOLUTIONS[i]!;
    if (levels[shorter].ms > levels[longer].ms) return [shorter, longer];
  }
  return undefined;
}

function orderMessage(levels: RetentionSettings, [a, b]: [Resolution, Resolution]): string {
  return `${RESOLUTION_LABELS[a]} retention (${levels[a].text}) must not be longer than ${RESOLUTION_LABELS[b]} retention (${levels[b].text})`;
}

/**
 * Per level: the environment variable, else the saved value, else the
 * default. A bad environment value throws (startup stops, as before). A
 * saved value that no longer parses is reported and skipped; saved values
 * that the environment has made out of order are ignored as a whole.
 */
export function resolveRetention(
  env: Record<string, string | undefined>,
  saved: Record<string, unknown>,
  onIgnored?: (message: string) => void
): RetentionSettings {
  const levels = {} as RetentionSettings;
  for (const resolution of RESOLUTIONS) {
    const variable = RETENTION_VARIABLES[resolution];
    const fromEnv = env[variable];
    if (fromEnv !== undefined) {
      levels[resolution] = {
        text: fromEnv.trim(),
        ms: parseDuration(variable, fromEnv),
        source: 'env',
        variable
      };
      continue;
    }
    const value = saved[settingKey(resolution)];
    if (value !== undefined) {
      try {
        if (typeof value !== 'string') throw new Error('it is not text');
        levels[resolution] = {
          text: value,
          ms: parseDuration(settingKey(resolution), value),
          source: 'saved',
          variable
        };
        continue;
      } catch (error) {
        onIgnored?.(`saved ${settingKey(resolution)} ignored: ${(error as Error).message}`);
      }
    }
    levels[resolution] = {
      text: DEFAULT_RETENTION_TEXT[resolution],
      ms: DEFAULT_RETENTION[resolution],
      source: 'default',
      variable
    };
  }
  const pair = outOfOrder(levels);
  if (pair) {
    if (RESOLUTIONS.some((resolution) => levels[resolution].source === 'saved')) {
      onIgnored?.(`saved retention ignored: ${orderMessage(levels, pair)}`);
      return resolveRetention(env, {}, onIgnored);
    }
    throw new Error(orderMessage(levels, pair));
  }
  return levels;
}

/**
 * Checks a proposal from the Settings page against the current levels.
 * Fields left out keep their current value; a field set by the environment
 * may only be sent back unchanged.
 */
export function validateRetention(
  proposal: Partial<Record<Resolution, string>>,
  current: RetentionSettings,
  rawAtLeast?: LookBack
): RetentionCheck {
  const errors: Partial<Record<Resolution, string>> = {};
  const levels: RetentionSettings = { ...current };
  for (const resolution of RESOLUTIONS) {
    const text = proposal[resolution]?.trim();
    if (text === undefined) continue;
    const level = current[resolution];
    // Unchanged fields keep their source: the page sends all four, and an
    // untouched default must stay a default (and a locked one stays locked).
    if (text === level.text) continue;
    if (level.source === 'env') {
      errors[resolution] = `set by ${level.variable}; change it there`;
      continue;
    }
    try {
      levels[resolution] = {
        text,
        ms: parseDuration(`${RESOLUTION_LABELS[resolution]} retention`, text),
        source: 'saved',
        variable: level.variable
      };
    } catch (error) {
      errors[resolution] = (error as Error).message;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const pair = outOfOrder(levels);
  if (pair) {
    const [shorter, longer] = pair;
    errors[shorter] =
      `must not be longer than ${RESOLUTION_LABELS[longer]} retention (${levels[longer].text})`;
  } else if (rawAtLeast && levels.raw.ms < rawAtLeast.ms) {
    errors.raw = `must be at least ${rawAtLeast.text}: rule "${rawAtLeast.ruleId}" looks back ${rawAtLeast.text}`;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, levels };
}

/** Saves the levels the operator set (source 'saved'); defaults and environment values stay unsaved. */
export function saveRetention(
  db: DatabaseSync,
  levels: RetentionSettings,
  now: number = Date.now()
): void {
  const values: Record<string, unknown> = {};
  for (const resolution of RESOLUTIONS) {
    if (levels[resolution].source === 'saved') {
      values[settingKey(resolution)] = levels[resolution].text;
    }
  }
  saveSettings(db, values, now);
}

/**
 * The retention in force, re-read from the database on every call, so a
 * saved change reaches housekeeping and /series without a restart. Each
 * distinct "ignored" message is logged once.
 */
export function retentionSource(
  db: DatabaseSync,
  env: Record<string, string | undefined>,
  log: (message: string) => void = console.warn
): () => RetentionSettings {
  const logged = new Set<string>();
  return () =>
    resolveRetention(env, getSettings(db), (message) => {
      if (logged.has(message)) return;
      logged.add(message);
      log(message);
    });
}
