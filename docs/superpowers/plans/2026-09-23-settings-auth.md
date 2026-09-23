# Phase 5b-1 Authentication, Settings and Retention Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One operator can sign in and change PiPulse's data retention from the browser, safely; nobody else on the LAN can change anything, and reads can optionally require sign-in too.

**Architecture:** `packages/storage` gains the `settings` table (migration 5), retention resolved per level from environment › saved › default and re-read on every housekeeping run, deletion previews, usage figures, a size estimate and an automatic `VACUUM`. `packages/api` gains a Fastify-free `auth.ts` (scrypt hash file, in-memory sessions, sign-in rate limit), one `onRequest` hook that enforces every rule, session routes, settings routes and a `hash-password` command. `packages/web` gains a sign-in form (also a full-page gate when reads are protected), a Settings page and a Sign out button.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Node ≥ 22.13 (`node:sqlite`, `node:crypto` scrypt, `fs.statfsSync`), Fastify 5 + `@fastify/websocket`, Preact, Vitest 5 (happy-dom for web).

**Spec:** `docs/superpowers/specs/2026-09-23-settings-auth-design.md`

## Global Constraints

- Node.js `>=22.13.0`. No new runtime dependencies anywhere: scrypt from `node:crypto`, cookies parsed by hand (no `@fastify/cookie`).
- No npm `pre*`/`post*` lifecycle hooks (this machine runs with `ignore-scripts=true`).
- Build order stays storage → collector → alerts → api → web.
- `packages/api/src/auth.ts` imports no Fastify types; only `auth-routes.ts`, `settings-routes.ts` and `index.ts` touch Fastify.
- Migration 5 is `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`; migrations 1–4 are never edited.
- Environment variables: `PIPULSE_ADMIN_PASSWORD_HASH_FILE` (unset = read-only), `PIPULSE_PROTECT_READS` (`true`|`false`, default `false`; anything else stops startup). No `PIPULSE_TRUST_PROXY` in this phase.
- Password hash line: `scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>`; new hashes use N = 2^15, r = 8, p = 1, 16-byte salt, 32-byte hash.
- Cookie: `pipulse_session=<256-bit base64url>; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`, plus `Secure` only when the connection itself is HTTPS. Sessions expire 7 days after last use and live only in memory.
- Sign-in: 5 failures per connection IP per 15 minutes → `429`; each failure answers after ~1 s; the failure body never says why.
- Status codes: `401` not signed in (WebSocket: close code `4401`), `403` editing disabled or foreign `Origin`, `400` invalid value, `409` deletion not confirmed, `429` too many sign-ins.
- Durations: `30s`, `5min`, `36h`, `14d`, `2w`, `1y`, `forever`; no bare `m` (the existing `parseDuration`).
- `VACUUM` only when free pages ≥ 25 % of the file and the file > 8 MB, free disk ≥ file size × 1.1, at most once a day.
- Colour never carries meaning alone on the dashboard: always an icon and words.
- Each package's tests live in its `test/` folder; `npm test`, `npm run lint` and Prettier on changed files pass before every commit (`npm test` builds first).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec clarifications: `GET /api/settings` returns `variable` on every level (the page names it even when unlocked); a saved policy whose levels are out of order is ignored as a whole (logged once, defaults used), while an out-of-order policy from environment variables alone stops startup; `PIPULSE_RETENTION_*` values out of order therefore now stop startup where Phase 4 accepted them.

## Review Focus

1. **The server restarted while the Settings page was open** (sessions are in memory): the page still thinks it is signed in; Review/Save gets `401` and must fall back to the sign-in form, not show a broken page. Test in Task 9.
2. **A saved retention now conflicts with an environment variable** (e.g. saved raw `30d`, then the operator sets `PIPULSE_RETENTION_1M=14d`): the saved values are ignored with one logged line, and the server still starts. Test in Task 2.
3. **A password with non-ASCII letters or surrounding spaces** (`" Contraseña "`): the hash command and sign-in must agree byte for byte (NFC-normalised, never trimmed). Test in Task 5.
4. **A hash file edited on another machine** (CRLF line ending, trailing newline): it must still parse. Test in Task 5.
5. **A signed-out browser left open with read protection on**: the WebSocket closes with `4401` and must not reconnect every few seconds forever. Test in Task 8.

---

### Task 1: Storage — the `settings` table

**Files:**

- Modify: `packages/storage/src/migrations.ts` (append migration 5)
- Create: `packages/storage/src/settings.ts`
- Modify: `packages/storage/src/index.ts` (exports)
- Test: `packages/storage/test/settings.test.ts`

**Interfaces:**

- Produces: `getSettings(db: DatabaseSync): Record<string, unknown>`; `saveSettings(db: DatabaseSync, values: Record<string, unknown>, now?: number): void` (a value of `undefined` deletes the key).

- [ ] **Step 1: Write the failing test**

```ts
// packages/storage/test/settings.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSettings, openDb, saveSettings, SCHEMA_VERSION, type PiPulseDb } from '../src/index.js';

let db: PiPulseDb | undefined;
afterEach(() => db?.close());

describe('settings', () => {
  it('is schema version 5 with an empty settings table', () => {
    db = openDb(':memory:');
    expect(SCHEMA_VERSION).toBe(5);
    expect(getSettings(db)).toEqual({});
  });

  it('saves, replaces and deletes values, surviving a reopen', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pipulse-')), 'db.sqlite');
    db = openDb(path);
    saveSettings(db, { 'retention.raw': '30d', 'retention.1m': '60d' }, 1000);
    saveSettings(db, { 'retention.raw': '7d', 'retention.1m': undefined }, 2000);
    db.close();
    db = openDb(path);
    expect(getSettings(db)).toEqual({ 'retention.raw': '7d' });
    const row = db
      .prepare('SELECT updated_at FROM settings WHERE key = ?')
      .get('retention.raw') as {
      updated_at: number;
    };
    expect(row.updated_at).toBe(2000);
  });

  it('reads a corrupt row as unset instead of throwing', () => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO settings VALUES ('retention.raw', '{not json', 1)").run();
    expect(getSettings(db)).toEqual({});
  });

  it('writes nothing when one value fails', () => {
    db = openDb(':memory:');
    expect(() => saveSettings(db!, { a: 1, b: 10n })).toThrow();
    expect(getSettings(db)).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/storage/test/settings.test.ts`
Expected: FAIL — `getSettings` is not exported.

- [ ] **Step 3: Append migration 5**

In `packages/storage/src/migrations.ts`, after the migration that creates `alerts` (the array's last element), add:

```ts
// 5: operator settings saved from the Settings page (5b-1: retention).
// Key/value with JSON values, so later settings need no migration.
(db) => {
  db.exec(`
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
};
```

- [ ] **Step 4: Create `settings.ts`**

```ts
// packages/storage/src/settings.ts
import type { DatabaseSync } from 'node:sqlite';

/** Every saved setting by key ("retention.raw"), values parsed from JSON. */
export function getSettings(db: DatabaseSync): Record<string, unknown> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as unknown as {
    key: string;
    value: string;
  }[];
  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      // A corrupt row reads as unset; the default applies until it is saved again.
    }
  }
  return settings;
}

/** Saves every entry in one transaction; a value of `undefined` deletes its key. */
export function saveSettings(
  db: DatabaseSync,
  values: Record<string, unknown>,
  now: number = Date.now()
): void {
  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  const remove = db.prepare('DELETE FROM settings WHERE key = ?');
  db.exec('BEGIN');
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) remove.run(key);
      else upsert.run(key, JSON.stringify(value), now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

(`JSON.stringify(10n)` throws, which is what the rollback test relies on.)

- [ ] **Step 5: Export from `packages/storage/src/index.ts`**

```ts
export { getSettings, saveSettings } from './settings.js';
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run packages/storage`
Expected: PASS, including the existing `migrations.test.ts` (it compares against `SCHEMA_VERSION`).

- [ ] **Step 7: Commit**

```bash
git add packages/storage
git commit -m "Add the settings table (migration 5) with get and save helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Storage — retention from environment, saved value and default

**Files:**

- Create: `packages/storage/src/retention.ts`
- Modify: `packages/storage/src/index.ts` (exports)
- Test: `packages/storage/test/retention.test.ts`

**Interfaces:**

- Consumes: `getSettings`, `saveSettings` (Task 1); `parseDuration`, `DEFAULT_RETENTION`, `Resolution`, `RetentionPolicy` from `rollup.ts`.
- Produces:
  - `RESOLUTIONS: readonly ['raw', '1m', '1h', '1d']`
  - `RETENTION_VARIABLES: Record<Resolution, string>`, `DEFAULT_RETENTION_TEXT: Record<Resolution, string>`, `RESOLUTION_LABELS: Record<Resolution, string>`
  - `interface RetentionLevel { text: string; ms: number; source: 'env' | 'saved' | 'default'; variable: string }`
  - `type RetentionSettings = Record<Resolution, RetentionLevel>`
  - `resolveRetention(env: Record<string, string | undefined>, saved: Record<string, unknown>, onIgnored?: (message: string) => void): RetentionSettings` (throws on a bad or out-of-order environment)
  - `policyOf(levels: RetentionSettings): RetentionPolicy`
  - `interface LookBack { ms: number; ruleId: string; text: string }`
  - `type RetentionCheck = { ok: true; levels: RetentionSettings } | { ok: false; errors: Partial<Record<Resolution, string>> }`
  - `validateRetention(proposal: Partial<Record<Resolution, string>>, current: RetentionSettings, rawAtLeast?: LookBack): RetentionCheck`
  - `saveRetention(db: DatabaseSync, levels: RetentionSettings, now?: number): void`
  - `retentionSource(db: DatabaseSync, env: Record<string, string | undefined>, log?: (message: string) => void): () => RetentionSettings`

- [ ] **Step 1: Write the failing test**

```ts
// packages/storage/test/retention.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSettings,
  openDb,
  policyOf,
  resolveRetention,
  retentionSource,
  saveRetention,
  saveSettings,
  validateRetention,
  type PiPulseDb
} from '../src/index.js';

const DAY = 86_400_000;
let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

describe('resolveRetention', () => {
  it('takes the environment over a saved value over the default, saying which won', () => {
    const levels = resolveRetention(
      { PIPULSE_RETENTION_1H: '2y' },
      { 'retention.raw': '7d', 'retention.1h': '30d' }
    );
    expect(levels.raw).toEqual({
      text: '7d',
      ms: 7 * DAY,
      source: 'saved',
      variable: 'PIPULSE_RETENTION_RAW'
    });
    expect(levels['1m']).toMatchObject({ text: '14d', source: 'default' });
    expect(levels['1h']).toMatchObject({ text: '2y', ms: 730 * DAY, source: 'env' });
    expect(levels['1d']).toMatchObject({ text: 'forever', ms: Infinity, source: 'default' });
  });

  it('skips a saved value that no longer parses, reporting it', () => {
    const ignored = vi.fn();
    const levels = resolveRetention({}, { 'retention.raw': '5m' }, ignored);
    expect(levels.raw.source).toBe('default');
    expect(ignored).toHaveBeenCalledWith(expect.stringMatching(/retention\.raw ignored/));
  });

  it('ignores saved values that an environment variable has made out of order', () => {
    const ignored = vi.fn();
    const levels = resolveRetention(
      { PIPULSE_RETENTION_1M: '14d' },
      { 'retention.raw': '30d' },
      ignored
    );
    expect(levels.raw).toMatchObject({ text: '2d', source: 'default' });
    expect(ignored).toHaveBeenCalledWith(expect.stringMatching(/saved retention ignored/));
  });

  it('throws when the environment alone is out of order or invalid', () => {
    expect(() => resolveRetention({ PIPULSE_RETENTION_RAW: '30d' }, {})).toThrow(
      /raw retention \(30d\) must not be longer than 1-minute retention \(14d\)/
    );
    expect(() => resolveRetention({ PIPULSE_RETENTION_RAW: '5m' }, {})).toThrow(
      /PIPULSE_RETENTION_RAW must be a duration/
    );
  });
});

describe('validateRetention', () => {
  const current = resolveRetention({ PIPULSE_RETENTION_1D: 'forever' }, {});

  it('accepts a valid proposal as saved levels', () => {
    const check = validateRetention({ raw: ' 7d ', '1m': '30d' }, current);
    expect(check.ok && policyOf(check.levels)).toEqual({
      raw: 7 * DAY,
      '1m': 30 * DAY,
      '1h': 365 * DAY,
      '1d': Infinity
    });
    expect(check.ok && check.levels.raw).toMatchObject({ text: '7d', source: 'saved' });
  });

  it('reports each bad field', () => {
    expect(validateRetention({ raw: '5m', '1m': '0d' }, current)).toEqual({
      ok: false,
      errors: {
        raw: expect.stringMatching(/raw retention must be a duration/),
        '1m': expect.stringMatching(/1-minute retention must be a duration/)
      }
    });
  });

  it('refuses levels out of order and a field locked by the environment', () => {
    expect(validateRetention({ raw: '30d' }, current)).toEqual({
      ok: false,
      errors: { raw: 'must not be longer than 1-minute retention (14d)' }
    });
    expect(validateRetention({ '1d': '10y' }, current)).toEqual({
      ok: false,
      errors: { '1d': 'set by PIPULSE_RETENTION_1D; change it there' }
    });
    // Sending the locked value back unchanged is fine (the page sends every field).
    expect(validateRetention({ '1d': 'forever' }, current).ok).toBe(true);
  });

  it('keeps raw retention at least as long as the longest alert look-back', () => {
    expect(
      validateRetention({ raw: '10min' }, current, {
        ms: 15 * 60_000,
        ruleId: 'load_queueing',
        text: '15min'
      })
    ).toEqual({
      ok: false,
      errors: { raw: 'must be at least 15min: rule "load_queueing" looks back 15min' }
    });
  });
});

describe('saveRetention and retentionSource', () => {
  it('saves only the levels the operator changed, and the source sees them at once', () => {
    const env = { PIPULSE_RETENTION_1D: '5y' };
    const getRetention = retentionSource(db, env);
    const check = validateRetention(
      { raw: '7d', '1m': '14d', '1h': '1y', '1d': '5y' },
      getRetention()
    );
    if (!check.ok) throw new Error('expected a valid proposal');
    saveRetention(db, check.levels);
    expect(getSettings(db)).toEqual({ 'retention.raw': '7d' });
    expect(getRetention().raw).toMatchObject({ ms: 7 * DAY, source: 'saved' });
  });

  it('logs an ignored saved value once, not on every read', () => {
    saveSettings(db, { 'retention.raw': 'soon' });
    const log = vi.fn();
    const getRetention = retentionSource(db, {}, log);
    getRetention();
    getRetention();
    expect(log).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/storage/test/retention.test.ts`
Expected: FAIL — `resolveRetention` is not exported.

- [ ] **Step 3: Create `retention.ts`**

```ts
// packages/storage/src/retention.ts
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
```

A saved value that sets a level back to its default text is still stored as `saved`; that is intended (the operator chose it).

- [ ] **Step 4: Export from `packages/storage/src/index.ts`**

```ts
export {
  DEFAULT_RETENTION_TEXT,
  policyOf,
  RESOLUTION_LABELS,
  RESOLUTIONS,
  resolveRetention,
  RETENTION_VARIABLES,
  retentionSource,
  saveRetention,
  validateRetention,
  type LookBack,
  type RetentionCheck,
  type RetentionLevel,
  type RetentionSettings
} from './retention.js';
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/storage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/storage
git commit -m "Resolve retention from environment, saved value and default

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Storage — live retention in housekeeping and automatic `VACUUM`

**Files:**

- Create: `packages/storage/src/vacuum.ts`
- Modify: `packages/storage/src/rollup.ts` (`HousekeepingOptions`, `startHousekeeping`)
- Modify: `packages/storage/src/index.ts` (exports)
- Test: `packages/storage/test/vacuum.test.ts`, `packages/storage/test/housekeeping-timer.test.ts`

**Interfaces:**

- Produces:
  - `databaseFile(db): string | undefined` (undefined for `:memory:`)
  - `fileUsage(db): { fileBytes: number; freeBytes: number }`
  - `diskFreeBytes(db): number | undefined`
  - `interface VacuumOptions { minFreeFraction?: number; minFileBytes?: number; everyMs?: number; diskFree?: (db: DatabaseSync) => number | undefined; onVacuum?: (result: VacuumResult) => void }`
  - `type VacuumResult = { ran: true; beforeBytes: number; afterBytes: number; ms: number } | { ran: false; reason: string }`
  - `maybeVacuum(db, now: number, lastAttemptAt: number | undefined, options?: VacuumOptions): VacuumResult | undefined` — `undefined` when not needed.
  - `HousekeepingOptions.retention` now accepts `RetentionPolicy | (() => RetentionPolicy)`; new `HousekeepingOptions.vacuum?: VacuumOptions | false` (default: on with the defaults above).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/storage/test/vacuum.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileUsage, insertSample, maybeVacuum, openDb, type PiPulseDb } from '../src/index.js';

const DAY = 86_400_000;
let db: PiPulseDb;

/** A file database with most of its pages free. */
function fragmented(): PiPulseDb {
  const file = openDb(join(mkdtempSync(join(tmpdir(), 'pipulse-')), 'db.sqlite'));
  file.exec('BEGIN');
  for (let ts = 0; ts < 20_000; ts++) insertSample(file, { ts, metric: 'cpu_load', value: ts });
  file.exec('COMMIT');
  file.exec('DELETE FROM metrics WHERE ts < 18000');
  return file;
}

beforeEach(() => {
  db = fragmented();
});
afterEach(() => db.close());

const plenty = () => 10 ** 12;

describe('maybeVacuum', () => {
  it('compacts when free pages pass the threshold, reporting sizes', () => {
    const before = fileUsage(db);
    expect(before.freeBytes / before.fileBytes).toBeGreaterThan(0.25);
    const result = maybeVacuum(db, DAY, undefined, { minFileBytes: 0, diskFree: plenty });
    expect(result).toMatchObject({ ran: true, beforeBytes: before.fileBytes });
    expect(result?.ran && result.afterBytes).toBeLessThan(before.fileBytes);
    expect(fileUsage(db).freeBytes).toBe(0);
  });

  it('does nothing below the size or free-page thresholds', () => {
    expect(maybeVacuum(db, DAY, undefined, { diskFree: plenty })).toBeUndefined(); // < 8 MB
    expect(
      maybeVacuum(db, DAY, undefined, { minFileBytes: 0, minFreeFraction: 0.99, diskFree: plenty })
    ).toBeUndefined();
  });

  it('skips with a reason when the disk lacks room for the copy', () => {
    const result = maybeVacuum(db, DAY, undefined, { minFileBytes: 0, diskFree: () => 1000 });
    expect(result).toEqual({ ran: false, reason: expect.stringMatching(/not enough free disk/) });
  });

  it('waits a day after the last attempt', () => {
    const options = { minFileBytes: 0, diskFree: plenty };
    expect(maybeVacuum(db, DAY, 1, options)).toBeUndefined();
    expect(maybeVacuum(db, DAY + 1, 1, options)).toMatchObject({ ran: true });
  });

  it('never runs on an in-memory database', () => {
    const memory = openDb(':memory:');
    expect(
      maybeVacuum(memory, DAY, undefined, { minFileBytes: 0, diskFree: plenty })
    ).toBeUndefined();
    memory.close();
  });
});
```

Append to `packages/storage/test/housekeeping-timer.test.ts`, inside `describe('startHousekeeping', …)` (add `import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';` at the top):

```ts
it('reads a retention function on every run, so a change applies without a restart', () => {
  const now = Date.now();
  insertSample(db, { ts: now - 3 * 3_600_000, metric: 'cpu_load', value: 1 });
  let policy = { raw: 7 * 86_400_000, '1m': 14 * 86_400_000, '1h': Infinity, '1d': Infinity };
  const housekeeping = startHousekeeping(db, {
    intervalMs: 60_000,
    retention: () => policy,
    vacuum: false
  });
  const raw = () => (db.prepare('SELECT COUNT(*) AS n FROM metrics').get() as { n: number }).n;
  expect(raw()).toBe(1);
  policy = { ...policy, raw: 3_600_000 };
  vi.advanceTimersByTime(60_000);
  expect(raw()).toBe(0);
  housekeeping.stop();
});

it('vacuums a fragmented file database once, then waits a day', () => {
  const file = openDb(join(mkdtempSync(join(tmpdir(), 'pipulse-')), 'db.sqlite'));
  file.exec('BEGIN');
  for (let ts = 0; ts < 20_000; ts++) insertSample(file, { ts, metric: 'x', value: ts });
  file.exec('COMMIT');
  file.exec('DELETE FROM metrics WHERE ts < 18000');
  const onVacuum = vi.fn();
  const housekeeping = startHousekeeping(file, {
    intervalMs: 60_000,
    vacuum: { minFileBytes: 0, diskFree: () => 10 ** 12, onVacuum }
  });
  expect(onVacuum).toHaveBeenCalledWith(expect.objectContaining({ ran: true }));
  file.exec('DELETE FROM metrics');
  vi.advanceTimersByTime(60_000);
  expect(onVacuum).toHaveBeenCalledOnce();
  housekeeping.stop();
  file.close();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/storage/test/vacuum.test.ts packages/storage/test/housekeeping-timer.test.ts`
Expected: FAIL — `maybeVacuum` is not exported; `vacuum` is not a known option.

- [ ] **Step 3: Create `vacuum.ts`**

```ts
// packages/storage/src/vacuum.ts
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
```

- [ ] **Step 4: Update `startHousekeeping` in `rollup.ts`**

Add the import at the top of `rollup.ts`:

```ts
import { maybeVacuum, type VacuumOptions } from './vacuum.js';
```

Replace `HousekeepingOptions` and `startHousekeeping` with:

```ts
export interface HousekeepingOptions {
  /** How often to run; defaults to every minute, so 1-minute rollups stay current. */
  intervalMs?: number;
  /** A fixed policy, or a function read at the start of every run (saved settings). */
  retention?: RetentionPolicy | (() => RetentionPolicy);
  /** Compacts the file after large deletions; false turns it off. */
  vacuum?: VacuumOptions | false;
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
  const retention = options.retention;
  let lastVacuumAttempt: number | undefined;
  const run = () => {
    try {
      const policy = typeof retention === 'function' ? retention() : retention;
      // Not `onResult?.(runHousekeeping(…))`: an optional call skips evaluating
      // its arguments, so housekeeping would silently never run without onResult.
      const result = runHousekeeping(db, Date.now(), policy);
      options.onResult?.(result);
      if (options.vacuum !== false) {
        const now = Date.now();
        const vacuum = maybeVacuum(db, now, lastVacuumAttempt, options.vacuum);
        if (vacuum) {
          lastVacuumAttempt = now;
          options.vacuum?.onVacuum?.(vacuum);
        }
      }
    } catch (error) {
      options.onError?.(error);
    }
  };
  run();
  const timer = setInterval(run, options.intervalMs ?? MIN);
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 5: Export from `packages/storage/src/index.ts`**

```ts
export {
  databaseFile,
  diskFreeBytes,
  fileUsage,
  maybeVacuum,
  type VacuumOptions,
  type VacuumResult
} from './vacuum.js';
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run packages/storage`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/storage
git commit -m "Read retention on every housekeeping run and vacuum after large deletes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Storage — usage, deletion preview and size estimate

**Files:**

- Create: `packages/storage/src/usage.ts`
- Modify: `packages/storage/src/index.ts` (exports)
- Test: `packages/storage/test/usage.test.ts`

**Interfaces:**

- Consumes: `fileUsage` (Task 3), `RESOLUTIONS` (Task 2).
- Produces:
  - `interface LevelUsage { rows: number; oldest: number | null }`
  - `interface StorageUsage { fileBytes: number; freeBytes: number; levels: Record<Resolution, LevelUsage> }`
  - `storageUsage(db): StorageUsage`
  - `interface LevelDeletion { deletesRows: number; from: number | null; to: number | null }`
  - `previewDeletion(db, policy: RetentionPolicy, now: number): Record<Resolution, LevelDeletion>`
  - `estimateBytes(policy: RetentionPolicy, metrics: { intervalMs: number }[], usage: StorageUsage): number`

- [ ] **Step 1: Write the failing test**

```ts
// packages/storage/test/usage.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION,
  estimateBytes,
  insertSample,
  openDb,
  previewDeletion,
  storageUsage,
  type PiPulseDb
} from '../src/index.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 20);
let db: PiPulseDb;

beforeEach(() => {
  db = openDb(':memory:');
  for (let ts = NOW - 3 * DAY; ts <= NOW; ts += HOUR) {
    insertSample(db, { ts, metric: 'cpu_load', value: 1 });
  }
  db.prepare(
    "INSERT INTO metrics_rollup (ts, metric, resolution, avg, min, max) VALUES (?, 'cpu_load', '1h', 1, 1, 1)"
  ).run(NOW - 10 * DAY);
});
afterEach(() => db.close());

describe('storageUsage', () => {
  it('counts rows and the oldest row per level', () => {
    const usage = storageUsage(db);
    expect(usage.levels.raw).toEqual({ rows: 73, oldest: NOW - 3 * DAY });
    expect(usage.levels['1h']).toEqual({ rows: 1, oldest: NOW - 10 * DAY });
    expect(usage.levels['1m']).toEqual({ rows: 0, oldest: null });
    expect(usage.fileBytes).toBeGreaterThan(0);
  });
});

describe('previewDeletion', () => {
  it('counts what a shorter policy would delete, and the span it covers', () => {
    const preview = previewDeletion(db, { ...DEFAULT_RETENTION, raw: DAY, '1h': 7 * DAY }, NOW);
    expect(preview.raw).toEqual({ deletesRows: 48, from: NOW - 3 * DAY, to: NOW - DAY });
    expect(preview['1h']).toEqual({ deletesRows: 1, from: NOW - 10 * DAY, to: NOW - 7 * DAY });
    expect(preview['1d']).toEqual({ deletesRows: 0, from: null, to: null });
  });
});

describe('estimateBytes', () => {
  it('scales rows per day by retention, keeping forever for a year', () => {
    const usage = {
      fileBytes: 50_000_000,
      freeBytes: 0,
      levels: {
        raw: { rows: 500_000, oldest: 0 },
        '1m': { rows: 300_000, oldest: 0 },
        '1h': { rows: 150_000, oldest: 0 },
        '1d': { rows: 50_000, oldest: 0 }
      }
    };
    // One metric every 10 s: raw 8640/day, 1m 1440, 1h 24, 1d 1; 50 bytes a row.
    const bytes = estimateBytes(
      { raw: 2 * DAY, '1m': 14 * DAY, '1h': 365 * DAY, '1d': Infinity },
      [{ intervalMs: 10_000 }],
      usage
    );
    expect(bytes).toBe((8640 * 2 + 1440 * 14 + 24 * 365 + 365) * 50);
  });

  it('assumes 50 bytes a row while the database is nearly empty', () => {
    const empty = {
      fileBytes: 4096,
      freeBytes: 0,
      levels: storageUsage(openDb(':memory:')).levels
    };
    expect(
      estimateBytes(
        { raw: DAY, '1m': DAY, '1h': DAY, '1d': DAY },
        [{ intervalMs: 86_400_000 }],
        empty
      )
    ).toBe((1 + 1440 + 24 + 1) * 50); // raw, 1m, 1h, 1d rows for one day of one metric
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/storage/test/usage.test.ts`
Expected: FAIL — `storageUsage` is not exported.

- [ ] **Step 3: Create `usage.ts`**

```ts
// packages/storage/src/usage.ts
import type { DatabaseSync } from 'node:sqlite';
import { RESOLUTIONS } from './retention.js';
import type { Resolution, RetentionPolicy } from './rollup.js';
import { fileUsage } from './vacuum.js';

const DAY = 86_400_000;
/** Bytes per row assumed until the database holds enough rows to measure. */
const FALLBACK_BYTES_PER_ROW = 50;

export interface LevelUsage {
  rows: number;
  oldest: number | null;
}

export interface StorageUsage {
  fileBytes: number;
  freeBytes: number;
  levels: Record<Resolution, LevelUsage>;
}

export interface LevelDeletion {
  deletesRows: number;
  /** Oldest row that would go, or null when nothing would. */
  from: number | null;
  /** The new cutoff, or null when nothing would go. */
  to: number | null;
}

function levelQuery(db: DatabaseSync, resolution: Resolution, before?: number): LevelUsage {
  const row = (
    resolution === 'raw'
      ? before === undefined
        ? db.prepare('SELECT COUNT(*) AS rows, MIN(ts) AS oldest FROM metrics').get()
        : db
            .prepare('SELECT COUNT(*) AS rows, MIN(ts) AS oldest FROM metrics WHERE ts < ?')
            .get(before)
      : before === undefined
        ? db
            .prepare(
              'SELECT COUNT(*) AS rows, MIN(ts) AS oldest FROM metrics_rollup WHERE resolution = ?'
            )
            .get(resolution)
        : db
            .prepare(
              'SELECT COUNT(*) AS rows, MIN(ts) AS oldest FROM metrics_rollup WHERE resolution = ? AND ts < ?'
            )
            .get(resolution, before)
  ) as { rows: number; oldest: number | null };
  return { rows: Number(row.rows), oldest: row.oldest };
}

/** File size, free pages, and rows and oldest row per level. */
export function storageUsage(db: DatabaseSync): StorageUsage {
  const levels = {} as Record<Resolution, LevelUsage>;
  for (const resolution of RESOLUTIONS) levels[resolution] = levelQuery(db, resolution);
  return { ...fileUsage(db), levels };
}

/**
 * What housekeeping would delete under `policy`: rows older than each
 * level's cutoff. An upper bound — raw rows not yet rolled up wait a
 * minute longer.
 */
export function previewDeletion(
  db: DatabaseSync,
  policy: RetentionPolicy,
  now: number
): Record<Resolution, LevelDeletion> {
  const preview = {} as Record<Resolution, LevelDeletion>;
  for (const resolution of RESOLUTIONS) {
    const ms = policy[resolution];
    if (!Number.isFinite(ms)) {
      preview[resolution] = { deletesRows: 0, from: null, to: null };
      continue;
    }
    const cutoff = now - ms;
    const doomed = levelQuery(db, resolution, cutoff);
    preview[resolution] =
      doomed.rows === 0
        ? { deletesRows: 0, from: null, to: null }
        : { deletesRows: doomed.rows, from: doomed.oldest, to: cutoff };
  }
  return preview;
}

/**
 * The database size once `policy` is full. Rows per day come from what is
 * collected (raw from each plugin's interval; each rollup level one row per
 * metric per bucket); bytes per row are measured from the database itself.
 * A level kept forever is estimated for one year.
 */
export function estimateBytes(
  policy: RetentionPolicy,
  metrics: { intervalMs: number }[],
  usage: StorageUsage
): number {
  const perDay: Record<Resolution, number> = {
    raw: metrics.reduce((sum, metric) => sum + DAY / metric.intervalMs, 0),
    '1m': metrics.length * 1440,
    '1h': metrics.length * 24,
    '1d': metrics.length
  };
  const rowsNow = RESOLUTIONS.reduce((sum, r) => sum + usage.levels[r].rows, 0);
  const bytesPerRow =
    rowsNow >= 1000 ? (usage.fileBytes - usage.freeBytes) / rowsNow : FALLBACK_BYTES_PER_ROW;
  const rows = RESOLUTIONS.reduce((sum, r) => {
    const days = Number.isFinite(policy[r]) ? policy[r] / DAY : 365;
    return sum + perDay[r] * days;
  }, 0);
  return Math.round(rows * bytesPerRow);
}
```

- [ ] **Step 4: Export from `packages/storage/src/index.ts`**

```ts
export {
  estimateBytes,
  previewDeletion,
  storageUsage,
  type LevelDeletion,
  type LevelUsage,
  type StorageUsage
} from './usage.js';
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/storage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/storage
git commit -m "Report storage usage, preview retention deletions and estimate size

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: API — password hash, sessions, sign-in limit and `hash-password`

**Files:**

- Create: `packages/api/src/auth.ts`
- Create: `packages/api/src/hash-password.ts`
- Test: `packages/api/test/auth.test.ts`

**Interfaces:**

- Produces (all from `auth.ts`, no Fastify imports):
  - `class AuthConfigError extends Error`
  - `interface PasswordHash { N: number; r: number; p: number; salt: Buffer; hash: Buffer }`
  - `DEFAULT_COST: { N: number; r: number; p: number }`
  - `hashPassword(password: string, cost?: { N: number; r: number; p: number }): Promise<string>`
  - `parsePasswordHash(text: string): PasswordHash`
  - `readPasswordHashFile(path: string, variable?: string): PasswordHash`
  - `verifyPassword(password: string, stored: PasswordHash): Promise<boolean>`
  - `checkNewPassword(first: string, second: string): string | undefined` (a problem, or undefined)
  - `interface Sessions { create(): string; valid(id: string | undefined): boolean; end(id: string | undefined): void }`
  - `SESSION_TTL_MS`, `createSessions(options?: { now?: () => number; ttlMs?: number }): Sessions`
  - `interface LoginLimiter { blocked(ip: string): boolean; fail(ip: string): void; succeed(ip: string): void }`
  - `createLoginLimiter(options?: { now?: () => number; max?: number; windowMs?: number }): LoginLimiter`
  - `SESSION_COOKIE = 'pipulse_session'`, `readCookie(header: string | undefined, name: string): string | undefined`, `sessionCookie(id: string, secure: boolean): string`, `clearedSessionCookie(secure: boolean): string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/test/auth.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AuthConfigError,
  checkNewPassword,
  clearedSessionCookie,
  createLoginLimiter,
  createSessions,
  hashPassword,
  parsePasswordHash,
  readCookie,
  readPasswordHashFile,
  sessionCookie,
  verifyPassword
} from '../src/auth.js';

/** Cheap enough for tests; production uses DEFAULT_COST. */
const CHEAP = { N: 1024, r: 8, p: 1 };
const DAY = 86_400_000;

describe('password hashes', () => {
  it('verifies the right password only, byte for byte', async () => {
    const stored = parsePasswordHash(await hashPassword(' Contraseña ', CHEAP));
    expect(await verifyPassword(' Contraseña ', stored)).toBe(true);
    // The same word written with a combining accent: NFC makes them equal.
    expect(await verifyPassword(' Contraseña ', stored)).toBe(true);
    expect(await verifyPassword('Contraseña', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('writes the documented format with the default cost', async () => {
    const line = await hashPassword('x');
    expect(line).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
  });

  it('reads a hash file with a CRLF or trailing newline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipulse-'));
    const path = join(dir, 'hash');
    writeFileSync(path, `${await hashPassword('pw', CHEAP)}\r\n`);
    expect(await verifyPassword('pw', readPasswordHashFile(path))).toBe(true);
  });

  it('explains a missing or malformed file in one line naming the variable and path', () => {
    expect(() => readPasswordHashFile('/nonexistent/hash')).toThrow(
      /^PIPULSE_ADMIN_PASSWORD_HASH_FILE \/nonexistent\/hash could not be read: ENOENT$/
    );
    const path = join(mkdtempSync(join(tmpdir(), 'pipulse-')), 'hash');
    writeFileSync(path, 'hunter2\n');
    expect(() => readPasswordHashFile(path)).toThrow(AuthConfigError);
    expect(() => readPasswordHashFile(path)).toThrow(/is not a PiPulse password hash/);
    expect(() => parsePasswordHash('scrypt$1000$8$1$AAAA$AAAA')).toThrow(AuthConfigError);
  });

  it('refuses an empty or mismatched new password', () => {
    expect(checkNewPassword('', '')).toMatch(/empty/);
    expect(checkNewPassword('a', 'b')).toMatch(/did not match/);
    expect(checkNewPassword('same', 'same')).toBeUndefined();
  });
});

describe('sessions', () => {
  it('creates unguessable ids that expire seven days after last use', () => {
    let now = 0;
    const sessions = createSessions({ now: () => now });
    const id = sessions.create();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessions.create()).not.toBe(id);
    now = 6 * DAY;
    expect(sessions.valid(id)).toBe(true); // refreshes last use
    now = 12 * DAY;
    expect(sessions.valid(id)).toBe(true);
    now = 19 * DAY + 1;
    expect(sessions.valid(id)).toBe(false);
    expect(sessions.valid(undefined)).toBe(false);
    expect(sessions.valid('forged')).toBe(false);
  });

  it('ends a session', () => {
    const sessions = createSessions();
    const id = sessions.create();
    sessions.end(id);
    expect(sessions.valid(id)).toBe(false);
  });
});

describe('createLoginLimiter', () => {
  it('blocks an address after five failures in 15 minutes, per address', () => {
    let now = 0;
    const limiter = createLoginLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) limiter.fail('10.0.0.2');
    expect(limiter.blocked('10.0.0.2')).toBe(true);
    expect(limiter.blocked('10.0.0.3')).toBe(false);
    now = 15 * 60_000;
    expect(limiter.blocked('10.0.0.2')).toBe(false);
  });

  it('forgets failures after a success', () => {
    const limiter = createLoginLimiter();
    for (let i = 0; i < 4; i++) limiter.fail('ip');
    limiter.succeed('ip');
    limiter.fail('ip');
    expect(limiter.blocked('ip')).toBe(false);
  });
});

describe('cookies', () => {
  it('reads one cookie from a header', () => {
    expect(readCookie('a=1; pipulse_session=abc; b=2', 'pipulse_session')).toBe('abc');
    expect(readCookie(undefined, 'pipulse_session')).toBeUndefined();
    expect(readCookie('xpipulse_session=abc', 'pipulse_session')).toBeUndefined();
  });

  it('sets and clears the session cookie, Secure only over HTTPS', () => {
    expect(sessionCookie('id', false)).toBe(
      'pipulse_session=id; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800'
    );
    expect(sessionCookie('id', true)).toMatch(/; Secure$/);
    expect(clearedSessionCookie(false)).toBe(
      'pipulse_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/api/test/auth.test.ts`
Expected: FAIL — `../src/auth.js` does not exist.

- [ ] **Step 3: Create `auth.ts`**

```ts
// packages/api/src/auth.ts
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** A problem with the auth configuration; its message is one line for the operator. */
export class AuthConfigError extends Error {}

export interface PasswordHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

export const DEFAULT_COST = { N: 2 ** 15, r: 8, p: 1 };
/** scrypt needs 128 × N × r bytes; Node's default limit is exactly that for DEFAULT_COST. */
const MAXMEM = 256 * 1024 * 1024;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Async scrypt: runs on the thread pool, so a sign-in never stalls sample collection. */
function derive(
  password: string,
  salt: Buffer,
  length: number,
  cost: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFC so the same password typed on different keyboards hashes the same.
    scrypt(password.normalize('NFC'), salt, length, { ...cost, maxmem: MAXMEM }, (error, key) =>
      error ? reject(error) : resolve(key)
    );
  });
}

export async function hashPassword(password: string, cost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, 32, cost);
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64'), hash.toString('base64')].join(
    '$'
  );
}

export function parsePasswordHash(text: string): PasswordHash {
  const parts = text.trim().split('$');
  const [scheme, n, r, p, salt, hash] = parts;
  const numbers = [n, r, p].map(Number);
  const [N, R, P] = numbers as [number, number, number];
  const saltBytes = Buffer.from(salt ?? '', 'base64');
  const hashBytes = Buffer.from(hash ?? '', 'base64');
  if (
    parts.length !== 6 ||
    scheme !== 'scrypt' ||
    !numbers.every((value) => Number.isInteger(value) && value > 0) ||
    (N & (N - 1)) !== 0 ||
    saltBytes.length < 16 ||
    hashBytes.length < 16
  ) {
    throw new AuthConfigError('is not a PiPulse password hash (make one with hash-password)');
  }
  return { N, r: R, p: P, salt: saltBytes, hash: hashBytes };
}

export function readPasswordHashFile(
  path: string,
  variable = 'PIPULSE_ADMIN_PASSWORD_HASH_FILE'
): PasswordHash {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    throw new AuthConfigError(`${variable} ${path} could not be read: ${code}`);
  }
  try {
    return parsePasswordHash(text);
  } catch (error) {
    throw new AuthConfigError(`${variable} ${path} ${(error as Error).message}`);
  }
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const candidate = await derive(password, stored.salt, stored.hash.length, {
    N: stored.N,
    r: stored.r,
    p: stored.p
  });
  return timingSafeEqual(candidate, stored.hash);
}

/** Why a new password can't be used, or undefined when it can. Never trimmed. */
export function checkNewPassword(first: string, second: string): string | undefined {
  if (first === '') return 'The password is empty.';
  if (first !== second) return 'The two entries did not match.';
  return undefined;
}

export interface Sessions {
  create(): string;
  /** Whether `id` is a live session; a valid check counts as use. */
  valid(id: string | undefined): boolean;
  end(id: string | undefined): void;
}

export const SESSION_TTL_MS = 7 * DAY;

/** In-memory sessions: a restart signs everyone out, and no signing key exists anywhere. */
export function createSessions(options: { now?: () => number; ttlMs?: number } = {}): Sessions {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const lastUse = new Map<string, number>();
  const expired = (at: number) => now() - at > ttlMs;
  return {
    create() {
      for (const [id, at] of lastUse) if (expired(at)) lastUse.delete(id);
      const id = randomBytes(32).toString('base64url');
      lastUse.set(id, now());
      return id;
    },
    valid(id) {
      if (id === undefined) return false;
      const at = lastUse.get(id);
      if (at === undefined) return false;
      if (expired(at)) {
        lastUse.delete(id);
        return false;
      }
      lastUse.set(id, now());
      return true;
    },
    end(id) {
      if (id !== undefined) lastUse.delete(id);
    }
  };
}

export interface LoginLimiter {
  blocked(ip: string): boolean;
  fail(ip: string): void;
  succeed(ip: string): void;
}

export function createLoginLimiter(
  options: { now?: () => number; max?: number; windowMs?: number } = {}
): LoginLimiter {
  const now = options.now ?? Date.now;
  const max = options.max ?? 5;
  const windowMs = options.windowMs ?? 15 * MIN;
  const failures = new Map<string, number[]>();
  const recent = (ip: string) => (failures.get(ip) ?? []).filter((at) => now() - at < windowMs);
  return {
    blocked: (ip) => recent(ip).length >= max,
    fail(ip) {
      failures.set(ip, [...recent(ip), now()]);
    },
    succeed(ip) {
      failures.delete(ip);
    }
  };
}

export const SESSION_COOKIE = 'pipulse_session';

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const COOKIE_ATTRIBUTES = 'HttpOnly; SameSite=Strict; Path=/';

export function sessionCookie(id: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${id}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0${secure ? '; Secure' : ''}`;
}
```

- [ ] **Step 4: Create the `hash-password` command**

```ts
// packages/api/src/hash-password.ts
/**
 * Prints a PiPulse password hash for PIPULSE_ADMIN_PASSWORD_HASH_FILE:
 *
 *   node packages/api/dist/hash-password.js > /etc/pipulse/admin.hash
 *
 * Asks twice without echoing. Piped input (two lines) works for scripts.
 */
import { checkNewPassword, hashPassword } from './auth.js';

async function readHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let text = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(text);
          return;
        }
        if (char === '\u0003') {
          process.stderr.write('\n');
          process.exit(130);
        }
        text = char === '\u007f' || char === '\b' ? text.slice(0, -1) : text + char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPiped(): Promise<[string, string]> {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  const [first = '', second = ''] = input.split(/\r?\n/);
  return [first, second];
}

const [first, second] = process.stdin.isTTY
  ? [await readHidden('New PiPulse password: '), await readHidden('Again: ')]
  : await readPiped();
const problem = checkNewPassword(first, second);
if (problem) {
  console.error(problem);
  process.exit(1);
}
// The hash goes to stdout alone, so `> file` captures exactly one line.
console.log(await hashPassword(first));
```

- [ ] **Step 5: Run the tests and build**

Run: `npx vitest run packages/api/test/auth.test.ts && npm run build --workspace=packages/api`
Expected: PASS, and `packages/api/dist/hash-password.js` exists.

- [ ] **Step 6: Try the command once**

Run: `printf 'pw\npw\n' | node packages/api/dist/hash-password.js`
Expected: one line starting `scrypt$32768$8$1$`.

- [ ] **Step 7: Commit**

```bash
git add packages/api
git commit -m "Add password hashing, sessions, the sign-in limit and hash-password

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: API — one enforcement hook, session routes and the WebSocket check

**Files:**

- Create: `packages/api/src/origin.ts` (move `isAllowedOrigin` out of `index.ts`)
- Create: `packages/api/src/auth-routes.ts`
- Modify: `packages/api/src/index.ts` (`ServerOptions.auth`, register auth first, WebSocket close `4401`)
- Test: `packages/api/test/auth-routes.test.ts`

**Interfaces:**

- Consumes: everything from `auth.ts` (Task 5).
- Produces:
  - `interface AuthOptions { passwordHash?: PasswordHash; protectReads?: boolean; sessions?: Sessions; limiter?: LoginLimiter; failureDelayMs?: number }`
  - `registerAuth(app: FastifyInstance, options: AuthOptions & { allowedOrigins: string[] }): { signedIn(request: FastifyRequest): boolean; protectReads: boolean }`
  - `ServerOptions.auth?: AuthOptions` (unset = read-only, reads public)
  - Routes: `GET /api/session` → `{ editable: boolean; signedIn: boolean; protectReads: boolean }`; `POST /api/login { password }` → `{ signedIn: true }` + cookie; `POST /api/logout` → `{ signedIn: false }` + cleared cookie.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/test/auth-routes.test.ts
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { hashPassword, parsePasswordHash, type PasswordHash } from '../src/auth.js';
import { buildServer, createLiveFeed, type AuthOptions } from '../src/index.js';

let passwordHash: PasswordHash;
beforeAll(async () => {
  passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
});

let db: PiPulseDb;
let app: FastifyInstance | undefined;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  db.close();
});

function server(auth: AuthOptions): FastifyInstance {
  app = buildServer(db, { auth: { failureDelayMs: 0, ...auth }, live: createLiveFeed() });
  return app;
}

async function signIn(api: FastifyInstance): Promise<string> {
  const res = await api.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'secret' }
  });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

type Mode = 'read-only' | 'signed out' | 'signed in';

async function status(
  mode: Mode,
  protectReads: boolean,
  method: 'GET' | 'POST' | 'PUT',
  url: string
): Promise<number> {
  const api = server(mode === 'read-only' ? { protectReads } : { passwordHash, protectReads });
  const cookie = mode === 'signed in' ? await signIn(api) : undefined;
  const res = await api.inject({
    method,
    url,
    ...(cookie ? { headers: { cookie } } : {}),
    ...(method === 'GET' ? {} : { payload: {} })
  });
  await api.close();
  app = undefined;
  return res.statusCode;
}

describe('enforcement', () => {
  it.each([
    // mode, protect reads, method, url, expected status
    ['read-only', false, 'GET', '/api/config', 200],
    ['read-only', true, 'GET', '/api/config', 401],
    ['read-only', false, 'PUT', '/api/settings', 403],
    ['signed out', false, 'GET', '/api/metrics/latest', 200],
    ['signed out', true, 'GET', '/api/metrics/latest', 401],
    ['signed out', true, 'GET', '/api/session', 200],
    ['signed out', false, 'PUT', '/api/settings', 401],
    ['signed out', true, 'PUT', '/api/settings', 401],
    ['signed in', true, 'GET', '/api/metrics/latest', 200],
    // Past the hook: no settings routes are registered in this test server.
    ['signed in', false, 'PUT', '/api/settings', 404],
    ['signed out', true, 'GET', '/health', 200]
  ] as const)(
    '%s, protect reads %s: %s %s → %i',
    async (mode, protectReads, method, url, expected) => {
      expect(await status(mode, protectReads, method, url)).toBe(expected);
    }
  );

  it('rejects a write from a foreign page even when signed in', async () => {
    const api = server({ passwordHash });
    const cookie = await signIn(api);
    const res = await api.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie, origin: 'http://evil.example', host: 'io.lan:8889' }
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('sign-in', () => {
  it('reports the session state', async () => {
    const api = server({ passwordHash, protectReads: true });
    expect((await api.inject({ url: '/api/session' })).json()).toEqual({
      editable: true,
      signedIn: false,
      protectReads: true
    });
    const cookie = await signIn(api);
    expect((await api.inject({ url: '/api/session', headers: { cookie } })).json()).toMatchObject({
      signedIn: true
    });
  });

  it('sets an HttpOnly, SameSite=Strict cookie, not Secure over plain HTTP', async () => {
    const res = await server({ passwordHash }).inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'secret' }
    });
    expect(res.headers['set-cookie']).toMatch(
      /^pipulse_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/
    );
  });

  it('answers a wrong password with the same body every time, then 429', async () => {
    const api = server({ passwordHash });
    for (let i = 0; i < 5; i++) {
      const res = await api.inject({
        method: 'POST',
        url: '/api/login',
        payload: { password: 'guess' }
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'sign-in failed' });
    }
    const blocked = await api.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'secret' }
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('signs out, and the old cookie stops working', async () => {
    const api = server({ passwordHash, protectReads: true });
    const cookie = await signIn(api);
    const out = await api.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(out.headers['set-cookie']).toMatch(/^pipulse_session=; .*Max-Age=0$/);
    expect((await api.inject({ url: '/api/config', headers: { cookie } })).statusCode).toBe(401);
  });

  it('refuses sign-in when no password is configured', async () => {
    const res = await server({}).inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'x' }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/editing is disabled/);
  });
});

describe('/api/live with read protection', () => {
  // A real socket, as in live.test.ts: injectWS never delivers the close event.
  it('closes a signed-out socket with 4401 and serves a signed-in one', async () => {
    const api = server({ passwordHash, protectReads: true });
    const cookie = await signIn(api);
    await api.listen({ port: 0, host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${(api.server.address() as AddressInfo).port}/api/live`;

    const out = new WebSocket(url);
    const code = await new Promise<number>((resolve) => out.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);

    const inside = new WebSocket(url, { headers: { cookie } });
    const first = await new Promise<string>((resolve) =>
      inside.once('message', (data) => resolve(String(data)))
    );
    expect(JSON.parse(first).type).toBe('snapshot');
    inside.terminate();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/api/test/auth-routes.test.ts`
Expected: FAIL — `AuthOptions` is not exported; `/api/session` is 404.

- [ ] **Step 3: Move `isAllowedOrigin` to `origin.ts`**

Cut the function (and its doc comment) from `index.ts` into:

```ts
// packages/api/src/origin.ts
/**
 * Accepts non-browser clients (no Origin header), same-host pages, and
 * explicitly allowed origins; rejects every other cross-site page.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowed: string[]
): boolean {
  if (origin === undefined) return true;
  if (allowed.includes(origin)) return true;
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    // e.g. the literal "null" origin sent by sandboxed iframes and file:// pages
    return false;
  }
}
```

and add `import { isAllowedOrigin } from './origin.js';` to `index.ts`.

- [ ] **Step 4: Create `auth-routes.ts`**

```ts
// packages/api/src/auth-routes.ts
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  clearedSessionCookie,
  createLoginLimiter,
  createSessions,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  verifyPassword,
  type LoginLimiter,
  type PasswordHash,
  type Sessions
} from './auth.js';
import { isAllowedOrigin } from './origin.js';

export interface AuthOptions {
  /** Unset: read-only, every write answers 403. */
  passwordHash?: PasswordHash;
  /** Require a session for every /api read and the WebSocket too. */
  protectReads?: boolean;
  sessions?: Sessions;
  limiter?: LoginLimiter;
  /** How long a failed sign-in waits before answering (default 1 s). */
  failureDelayMs?: number;
}

/** Reads anyone may make even with read protection on. */
const PUBLIC_READS = new Set(['/api/session']);

const loginSchema = {
  type: 'object',
  required: ['password'],
  properties: { password: { type: 'string', maxLength: 1024 } },
  additionalProperties: false
} as const;

/**
 * The one place that decides who may do what. Routes never check auth
 * themselves: this hook runs first for every request.
 */
export function registerAuth(
  app: FastifyInstance,
  options: AuthOptions & { allowedOrigins: string[] }
): { signedIn(request: FastifyRequest): boolean; protectReads: boolean } {
  const sessions = options.sessions ?? createSessions();
  const limiter = options.limiter ?? createLoginLimiter();
  const failureDelayMs = options.failureDelayMs ?? 1000;
  const protectReads = options.protectReads ?? false;
  const passwordHash = options.passwordHash;
  const sessionId = (request: FastifyRequest) => readCookie(request.headers.cookie, SESSION_COOKIE);
  const signedIn = (request: FastifyRequest) => sessions.valid(sessionId(request));
  const secure = (request: FastifyRequest) => request.protocol === 'https';

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0]!;
    if (!path.startsWith('/api/')) return;
    if (request.method === 'GET' || request.method === 'HEAD') {
      // The WebSocket handler closes an unauthorised socket with 4401 itself.
      if (!protectReads || PUBLIC_READS.has(path) || path === '/api/live') return;
      if (!signedIn(request)) return reply.status(401).send({ error: 'sign in required' });
      return;
    }
    if (!isAllowedOrigin(request.headers.origin, request.headers.host, options.allowedOrigins)) {
      return reply.status(403).send({ error: 'origin not allowed' });
    }
    if (!passwordHash) {
      return reply.status(403).send({ error: 'editing is disabled: no admin password configured' });
    }
    if (path === '/api/login' || path === '/api/logout') return;
    if (!signedIn(request)) return reply.status(401).send({ error: 'sign in required' });
  });

  app.get('/api/session', async (request) => ({
    editable: passwordHash !== undefined,
    signedIn: signedIn(request),
    protectReads
  }));

  app.post<{ Body: { password: string } }>(
    '/api/login',
    { schema: { body: loginSchema } },
    async (request, reply) => {
      if (limiter.blocked(request.ip)) {
        return reply
          .status(429)
          .send({ error: 'too many sign-in attempts; try again in 15 minutes' });
      }
      // The hook has already answered 403 when there is no password.
      if (!(await verifyPassword(request.body.password, passwordHash!))) {
        limiter.fail(request.ip);
        await delay(failureDelayMs);
        return reply.status(401).send({ error: 'sign-in failed' });
      }
      limiter.succeed(request.ip);
      reply.header('set-cookie', sessionCookie(sessions.create(), secure(request)));
      return { signedIn: true };
    }
  );

  app.post('/api/logout', async (request, reply) => {
    sessions.end(sessionId(request));
    reply.header('set-cookie', clearedSessionCookie(secure(request)));
    return { signedIn: false };
  });

  return { signedIn, protectReads };
}
```

- [ ] **Step 5: Wire it into `buildServer` (`index.ts`)**

1. Imports and re-exports:

```ts
import { registerAuth, type AuthOptions } from './auth-routes.js';
export type { AuthOptions } from './auth-routes.js';
```

2. Add to `ServerOptions`:

```ts
  /** Sign-in and read protection; unset = read-only with public reads. */
  auth?: AuthOptions;
```

3. In `buildServer`, right after `const app = Fastify({ logger: false });`, compute the origins once and register auth before any route:

```ts
const allowedOrigins = options.allowedOrigins ?? [];
const auth = registerAuth(app, { ...options.auth, allowedOrigins });
```

and delete the later `const allowedOrigins = options.allowedOrigins ?? [];` inside `if (live)`.

4. Change the WebSocket handler's signature to `(socket, request) => {` and make its first lines:

```ts
if (auth.protectReads && !auth.signedIn(request)) {
  socket.close(4401, 'sign in required');
  return;
}
```

- [ ] **Step 6: Run the API tests**

Run: `npx vitest run packages/api`
Expected: PASS — the new table and every existing API test (reads are public by default).

- [ ] **Step 7: Commit**

```bash
git add packages/api
git commit -m "Enforce sign-in for writes and optionally reads in one hook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: API — settings routes and server wiring

**Files:**

- Create: `packages/api/src/settings-routes.ts`
- Modify: `packages/api/src/index.ts` (`ServerOptions.settings`, register routes, `/series` reads live retention)
- Modify: `packages/api/src/server.ts` (hash file, `PIPULSE_PROTECT_READS`, retention source, vacuum log)
- Modify: `packages/collector/src/main.ts` (retention source)
- Test: `packages/api/test/settings-routes.test.ts`

**Interfaces:**

- Consumes: Tasks 2–4 from `@pipulse/storage`; `AuthOptions` (Task 6); `readPasswordHashFile` (Task 5); `Rule` from `@pipulse/alerts`.
- Produces:
  - `interface SettingsOptions { getRetention: () => RetentionSettings; rawAtLeast?: LookBack; metrics: { intervalMs: number }[]; diskFree?: () => number | undefined; now?: () => number }`
  - `longestLookBack(rules: Rule[]): LookBack | undefined`
  - `registerSettingsRoutes(app, db, options: SettingsOptions): void`
  - `ServerOptions.settings?: SettingsOptions`
  - `GET /api/settings` → `SettingsBody`:
    `{ retention: Record<Resolution, { text: string; ms: number | null; source: 'env' | 'saved' | 'default'; variable: string; locked: boolean }>; storage: { fileBytes: number; freeBytes: number; diskFreeBytes: number | null; levels: Record<Resolution, { rows: number; oldest: number | null }> } }`
  - `POST /api/settings/preview { retention: Partial<Record<Resolution, string>> }` → `200 { deletions: Record<Resolution, LevelDeletion>; estimatedBytes: number }` or `400 { errors }`
  - `PUT /api/settings { retention, confirmDeletion?: boolean }` → `200 SettingsBody`, `400 { errors }`, or `409 { error, deletions, estimatedBytes }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/test/settings-routes.test.ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  insertSample,
  openDb,
  retentionSource,
  type PiPulseDb,
  type RetentionSettings
} from '@pipulse/storage';
import { builtinRules } from '@pipulse/alerts';
import { hashPassword, parsePasswordHash, type PasswordHash } from '../src/auth.js';
import { buildServer } from '../src/index.js';
import { longestLookBack } from '../src/settings-routes.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 20);

let passwordHash: PasswordHash;
beforeAll(async () => {
  passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
});

let db: PiPulseDb;
let app: FastifyInstance;
let cookie: string;
let getRetention: () => RetentionSettings;

async function start(env: Record<string, string> = {}) {
  getRetention = retentionSource(db, env, () => {});
  app = buildServer(db, {
    auth: { passwordHash, failureDelayMs: 0 },
    settings: {
      getRetention,
      rawAtLeast: longestLookBack(builtinRules(4)),
      metrics: [{ intervalMs: 5000 }],
      diskFree: () => 10 ** 10,
      now: () => NOW
    }
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'secret' }
  });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
}

const put = (payload: object) =>
  app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload });

beforeEach(() => {
  db = openDb(':memory:');
  for (let ts = NOW - 3 * DAY; ts <= NOW; ts += HOUR) {
    insertSample(db, { ts, metric: 'cpu_load', value: 1 });
  }
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe('longestLookBack', () => {
  it('finds the rule that looks back furthest', () => {
    expect(longestLookBack(builtinRules(4))).toEqual({
      ms: 15 * 60_000,
      ruleId: 'load_queueing',
      text: '15min'
    });
    expect(longestLookBack([])).toBeUndefined();
  });
});

describe('GET /api/settings', () => {
  it('shows each level with its source and lock, and storage figures', async () => {
    await start({ PIPULSE_RETENTION_1D: 'forever' });
    const body = (await app.inject({ url: '/api/settings' })).json();
    expect(body.retention.raw).toEqual({
      text: '2d',
      ms: 2 * DAY,
      source: 'default',
      variable: 'PIPULSE_RETENTION_RAW',
      locked: false
    });
    expect(body.retention['1d']).toMatchObject({ ms: null, source: 'env', locked: true });
    expect(body.storage).toMatchObject({ diskFreeBytes: 10 ** 10, levels: { raw: { rows: 73 } } });
  });
});

describe('POST /api/settings/preview', () => {
  it('previews what a shorter policy deletes and the estimated size', async () => {
    await start();
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/preview',
      headers: { cookie },
      payload: { retention: { raw: '1d' } }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deletions.raw).toEqual({
      deletesRows: 48,
      from: NOW - 3 * DAY,
      to: NOW - DAY
    });
    expect(res.json().estimatedBytes).toBeGreaterThan(0);
  });

  it('reports invalid fields with 400', async () => {
    await start();
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/preview',
      headers: { cookie },
      payload: { retention: { raw: '10min' } }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.raw).toMatch(/rule "load_queueing" looks back 15min/);
  });

  it('needs a session like any write', async () => {
    await start();
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/preview',
      payload: { retention: {} }
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('PUT /api/settings', () => {
  it('refuses a deleting change without confirmation, then saves it with', async () => {
    await start();
    const refused = await put({ retention: { raw: '1d' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().deletions.raw.deletesRows).toBe(48);
    expect(getRetention().raw.source).toBe('default');

    const saved = await put({ retention: { raw: '1d' }, confirmDeletion: true });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().retention.raw).toMatchObject({ text: '1d', source: 'saved' });
    expect(getRetention().raw.ms).toBe(DAY);
  });

  it('saves a longer retention without confirmation', async () => {
    await start();
    expect((await put({ retention: { raw: '7d' } })).statusCode).toBe(200);
  });

  it('refuses to change a level locked by the environment', async () => {
    await start({ PIPULSE_RETENTION_RAW: '2d' });
    const res = await put({ retention: { raw: '7d' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.raw).toMatch(/set by PIPULSE_RETENTION_RAW/);
  });

  it('rejects a value that is not a duration', async () => {
    await start();
    // Fastify coerces 7 to "7" (and strips unknown fields); the duration check still refuses it.
    const res = await put({ retention: { raw: 7 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.raw).toMatch(/must be a duration/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/api/test/settings-routes.test.ts`
Expected: FAIL — `../src/settings-routes.js` does not exist.

- [ ] **Step 3: Create `settings-routes.ts`**

```ts
// packages/api/src/settings-routes.ts
import type { FastifyInstance } from 'fastify';
import {
  diskFreeBytes,
  estimateBytes,
  policyOf,
  previewDeletion,
  RESOLUTIONS,
  saveRetention,
  storageUsage,
  validateRetention,
  type LookBack,
  type PiPulseDb,
  type Resolution,
  type RetentionSettings
} from '@pipulse/storage';
import type { Rule } from '@pipulse/alerts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface SettingsOptions {
  getRetention: () => RetentionSettings;
  /** Raw retention may not be shorter than the longest alert look-back. */
  rawAtLeast?: LookBack;
  /** What is collected, for the size estimate. */
  metrics: { intervalMs: number }[];
  /** Free bytes on the database's disk; defaults to statfs on its directory. */
  diskFree?: () => number | undefined;
  now?: () => number;
}

/** "15min", "2h", "1d": the largest whole unit, as the rules file writes durations. */
function durationText(ms: number): string {
  if (ms % DAY === 0) return `${ms / DAY}d`;
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms % MIN === 0) return `${ms / MIN}min`;
  return `${Math.ceil(ms / 1000)}s`;
}

/** The rule whose `for` or `clearAfter` reaches furthest back into raw readings. */
export function longestLookBack(rules: Rule[]): LookBack | undefined {
  let longest: LookBack | undefined;
  for (const rule of rules) {
    const ms = Math.max(rule.forMs, rule.clearAfterMs);
    if (ms > 0 && (!longest || ms > longest.ms)) {
      longest = { ms, ruleId: rule.id, text: durationText(ms) };
    }
  }
  return longest;
}

const retentionSchema = {
  type: 'object',
  properties: Object.fromEntries(
    RESOLUTIONS.map((resolution) => [resolution, { type: 'string', maxLength: 32 }])
  ),
  additionalProperties: false
};

const previewSchema = {
  type: 'object',
  required: ['retention'],
  properties: { retention: retentionSchema },
  additionalProperties: false
};

const saveSchema = {
  type: 'object',
  required: ['retention'],
  properties: { retention: retentionSchema, confirmDeletion: { type: 'boolean' } },
  additionalProperties: false
};

type Proposal = Partial<Record<Resolution, string>>;

export function registerSettingsRoutes(
  app: FastifyInstance,
  db: PiPulseDb,
  options: SettingsOptions
): void {
  const now = options.now ?? Date.now;
  const diskFree = options.diskFree ?? (() => diskFreeBytes(db));

  const body = () => {
    const levels = options.getRetention();
    const retention = Object.fromEntries(
      RESOLUTIONS.map((resolution) => {
        const level = levels[resolution];
        return [
          resolution,
          {
            text: level.text,
            ms: Number.isFinite(level.ms) ? level.ms : null,
            source: level.source,
            variable: level.variable,
            locked: level.source === 'env'
          }
        ];
      })
    );
    return {
      retention,
      storage: { ...storageUsage(db), diskFreeBytes: diskFree() ?? null }
    };
  };

  /** Validation and preview shared by preview and save. */
  const check = (proposal: Proposal) => {
    const result = validateRetention(proposal, options.getRetention(), options.rawAtLeast);
    if (!result.ok) return { ok: false as const, errors: result.errors };
    const policy = policyOf(result.levels);
    return {
      ok: true as const,
      levels: result.levels,
      preview: {
        deletions: previewDeletion(db, policy, now()),
        estimatedBytes: estimateBytes(policy, options.metrics, storageUsage(db))
      }
    };
  };

  app.get('/api/settings', async () => body());

  app.post<{ Body: { retention: Proposal } }>(
    '/api/settings/preview',
    { schema: { body: previewSchema } },
    async (request, reply) => {
      const result = check(request.body.retention);
      if (!result.ok) return reply.status(400).send({ errors: result.errors });
      return result.preview;
    }
  );

  app.put<{ Body: { retention: Proposal; confirmDeletion?: boolean } }>(
    '/api/settings',
    { schema: { body: saveSchema } },
    async (request, reply) => {
      const result = check(request.body.retention);
      if (!result.ok) return reply.status(400).send({ errors: result.errors });
      const deletes = RESOLUTIONS.some((r) => result.preview.deletions[r].deletesRows > 0);
      if (deletes && request.body.confirmDeletion !== true) {
        return reply
          .status(409)
          .send({ error: 'this change deletes data; confirm it first', ...result.preview });
      }
      saveRetention(db, result.levels, now());
      return body();
    }
  );
}
```

- [ ] **Step 4: Wire the routes and live retention into `buildServer`**

In `index.ts`:

```ts
import { registerSettingsRoutes, type SettingsOptions } from './settings-routes.js';
export { longestLookBack, type SettingsOptions } from './settings-routes.js';
```

Add to `ServerOptions`:

```ts
  /** Settings routes and live retention; omitted = no /api/settings. */
  settings?: SettingsOptions;
```

Add `policyOf` to the `@pipulse/storage` import. In the `/series` handler, replace `options.retention` with the live policy:

```ts
const retention = options.settings ? policyOf(options.settings.getRetention()) : options.retention;
const resolution =
  requested === 'auto'
    ? chooseResolution(db, request.params.id, from, to, now, retention)
    : requested;
```

After the `/api/alerts` route, register the settings routes:

```ts
if (options.settings) registerSettingsRoutes(app, db, options.settings);
```

- [ ] **Step 5: Wire the server (`server.ts`)**

Replace the retention block (`readRetention` and `const RETENTION = readRetention();`) and the rules block so the order becomes: read auth settings, open the database, resolve retention, read rules. Keep the existing helpers' style (`console.error` one line, `process.exit(1)`).

```ts
import {
  openDb,
  policyOf,
  retentionSource,
  startHousekeeping,
  type RetentionSettings
} from '@pipulse/storage';
import { readPasswordHashFile, type PasswordHash } from './auth.js';
import { buildServer, createFeed, createLiveFeed, longestLookBack } from './index.js';

function fail(error: unknown): never {
  console.error(`[pipulse] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

/** PIPULSE_ADMIN_PASSWORD_HASH_FILE; unset leaves PiPulse read-only. */
function readPasswordHash(): PasswordHash | undefined {
  const path = process.env['PIPULSE_ADMIN_PASSWORD_HASH_FILE'];
  if (!path) return undefined;
  try {
    return readPasswordHashFile(path);
  } catch (error) {
    fail(error);
  }
}
const PASSWORD_HASH = readPasswordHash();

/** PIPULSE_PROTECT_READS=true|false (default false). */
function readProtectReads(): boolean {
  const value = process.env['PIPULSE_PROTECT_READS'];
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  fail(`PIPULSE_PROTECT_READS must be true or false (got ${JSON.stringify(value)})`);
}
const PROTECT_READS = readProtectReads();

const db = openDb(DB_PATH);

/**
 * Retention in force: PIPULSE_RETENTION_* over values saved from the
 * Settings page over defaults, re-read on every housekeeping run. Resolved
 * once here so a bad environment value stops startup.
 */
const getRetention = retentionSource(db, process.env, (message) =>
  console.warn(`[pipulse] ${message}`)
);
function readRetention(): RetentionSettings {
  try {
    return getRetention();
  } catch (error) {
    fail(error);
  }
}
const RETENTION = readRetention();
```

Delete the later `const db = openDb(DB_PATH);` (the database now opens before rules are read, because saved retention lives in it). In `readRules()`, use `rawRetentionMs: RETENTION.raw.ms` and `fail(error)` in its catch; `const RULES = readRules();` stays after `RETENTION`. Then pass the new options to `buildServer`:

```ts
const app = buildServer(db, {
  live,
  device: await readDeviceInfo(),
  allowedOrigins: ALLOWED_ORIGINS,
  ...(existsSync(WEB_DIR) ? { webRoot: WEB_DIR } : {}),
  plugins: builtinPlugins.map(({ id, label, unit, intervalMs }) => ({
    id,
    label,
    unit,
    intervalMs
  })),
  rules: RULES,
  alertFeed,
  auth: { protectReads: PROTECT_READS, ...(PASSWORD_HASH ? { passwordHash: PASSWORD_HASH } : {}) },
  settings: {
    getRetention,
    metrics: METRICS,
    ...(longestLookBack(RULES) ? { rawAtLeast: longestLookBack(RULES)! } : {})
  }
});
```

and replace the housekeeping start with:

```ts
// Rolls raw samples up into 1m/1h/1d buckets and prunes past retention, every
// minute, re-reading saved retention each run; compacts the file after big deletes.
const housekeeping = startHousekeeping(db, {
  retention: () => policyOf(getRetention()),
  vacuum: {
    onVacuum: (result) => {
      console.log(
        result.ran
          ? `[pipulse] vacuum: ${(result.beforeBytes / 1e6).toFixed(1)} MB → ${(result.afterBytes / 1e6).toFixed(1)} MB in ${(result.ms / 1000).toFixed(1)} s`
          : `[pipulse] vacuum skipped: ${result.reason}`
      );
    }
  },
  onError: (error) => {
    console.error('[pipulse] housekeeping failed:', error);
  }
});
```

Remove the now-unused `retentionFromEnv` and `RetentionPolicy` imports and the `retention: RETENTION` option to `buildServer`. Update the startup log to say whether editing is on:

```ts
console.log(
  `[pipulse] listening on http://${HOST}:${port}` +
    (PASSWORD_HASH ? '' : ' (read-only: PIPULSE_ADMIN_PASSWORD_HASH_FILE not set)') +
    (PROTECT_READS ? ' (reads need sign-in)' : '')
);
```

- [ ] **Step 6: Wire the standalone collector (`packages/collector/src/main.ts`)**

Replace `readRetention` / `RETENTION` and the housekeeping start:

```ts
import { openDb, policyOf, retentionSource, startHousekeeping } from '@pipulse/storage';

const db = openDb(dbPath);
// Same precedence as the server: environment › saved in the Settings page › default.
const getRetention = retentionSource(db, process.env, (message) =>
  console.warn(`[collector] ${message}`)
);
try {
  getRetention();
} catch (error) {
  console.error(`[collector] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
// Rolls raw samples up into 1m/1h/1d buckets and prunes past retention, every minute.
const housekeeping = startHousekeeping(db, {
  retention: () => policyOf(getRetention()),
  onError: (error) => {
    console.error('[collector] housekeeping failed:', error);
  }
});
```

(The collector leaves `vacuum` at its default; it logs nothing about it, which is acceptable for the rarely used standalone daemon.)

- [ ] **Step 7: Run everything**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 8: Smoke-test startup by hand**

```bash
PIPULSE_DB_PATH=/tmp/pp-5b.sqlite PIPULSE_PORT=8899 PIPULSE_PROTECT_READS=maybe node packages/api/dist/server.js
```

Expected: one line `[pipulse] PIPULSE_PROTECT_READS must be true or false (got "maybe")`, exit 1. Then run without it: `listening … (read-only: PIPULSE_ADMIN_PASSWORD_HASH_FILE not set)`; stop with Ctrl-C; `rm -f /tmp/pp-5b.sqlite*`.

- [ ] **Step 9: Commit**

```bash
git add packages/api packages/collector
git commit -m "Serve settings with preview and confirmation, and apply saved retention live

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web — session, sign-in gate, 401 handling and Sign out

**Files:**

- Create: `packages/web/src/api.ts`
- Create: `packages/web/src/sign-in.tsx`
- Modify: `packages/web/src/live.ts` (`onUnauthorized`, no retry after `4401`)
- Modify: `packages/web/src/app.tsx` (session state, gate, Sign out, use `api.ts`)
- Modify: `packages/web/src/history-page.tsx`, `packages/web/src/alerts-page.tsx` (`fetch` → `apiFetch`)
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/test/sign-in.test.tsx`, `packages/web/test/live.test.ts`

**Interfaces:**

- Produces:
  - `api.ts`: `class HttpError extends Error { status: number }`; `authEvents: EventTarget` (fires `'unauthorized'`); `apiFetch(path: string, init?: RequestInit): Promise<Response>`; `getJson<T>(path: string): Promise<T>`; `sendJson<T>(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<T>` (throws `HttpError` carrying the parsed body as `body`); `interface Session { editable: boolean; signedIn: boolean; protectReads: boolean }`; `NO_SESSION`; `loadSession(): Promise<Session>`.
  - `sign-in.tsx`: `SignIn({ heading?: string; onSignedIn(): void })`.
  - `live.ts`: `LiveOptions.onUnauthorized?: () => void`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/test/live.test.ts — add inside the existing describe block
it('stops reconnecting after the server closes with 4401, and says so', () => {
  const onUnauthorized = vi.fn();
  const onStatus = vi.fn();
  connectLive({
    url: 'ws://io.lan/api/live',
    onMessage: () => {},
    onStatus,
    onUnauthorized,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket
  });
  FakeSocket.instances.at(-1)!.onclose?.({ code: 4401 } as CloseEvent);
  expect(onUnauthorized).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(60_000);
  expect(FakeSocket.instances).toHaveLength(1);
});
```

(The file's `FakeSocket` types `onclose` as `(() => void) | null`; widen it to `((event?: { code: number }) => void) | null`. Its `beforeEach` already calls `vi.useFakeTimers()`, and `drop()` keeps calling `onclose` with no event, so existing tests are unchanged.)

```tsx
// packages/web/test/sign-in.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SignIn } from '../src/sign-in.js';

let root: HTMLElement;
let answer: Response;
beforeEach(() => {
  answer = Response.json({ signedIn: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => answer)
  );
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

async function submit(password: string) {
  const input = root.querySelector('input[type=password]') as HTMLInputElement;
  await act(() => {
    input.value = password;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await vi.waitFor(() =>
    expect((root.querySelector('button') as HTMLButtonElement).disabled).toBe(false)
  );
}

describe('SignIn', () => {
  it('posts the password unchanged and reports success', async () => {
    const onSignedIn = vi.fn();
    render(<SignIn onSignedIn={onSignedIn} />, root);
    await submit(' pass word ');
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/login');
    expect(JSON.parse(String(init!.body))).toEqual({ password: ' pass word ' });
    expect(onSignedIn).toHaveBeenCalledOnce();
  });

  it.each([
    [401, /Sign-in failed/],
    [429, /Too many attempts/],
    [403, /no admin password/]
  ])('explains a %i', async (status, message) => {
    answer = new Response('{}', { status });
    render(<SignIn onSignedIn={() => {}} />, root);
    await submit('x');
    expect(root.querySelector('[role=alert]')?.textContent).toMatch(message);
  });
});
```

Add to `packages/web/test/app.test.tsx`:

```tsx
describe('read protection', () => {
  it('shows only the sign-in form when /api/config needs a session, then the dashboard', async () => {
    let signedIn = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url, 'http://io.lan:8889').pathname;
        if (path === '/api/session') {
          return Response.json({ editable: true, signedIn, protectReads: true });
        }
        if (path === '/api/login' && init?.method === 'POST') {
          signedIn = true;
          return Response.json({ signedIn: true });
        }
        if (!signedIn) return Response.json({ error: 'sign in required' }, { status: 401 });
        if (path === '/api/config') return Response.json({ ...config, serverTime });
        return Response.json([]);
      })
    );
    render(<App />, root);
    await eventually(() => expect(root.querySelector('input[type=password]')).not.toBeNull());
    expect(root.querySelector('nav')).toBeNull();

    const input = root.querySelector('input[type=password]') as HTMLInputElement;
    await act(() => {
      input.value = 'secret';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => {
      root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    });
    await eventually(() => expect(root.querySelector('h1')?.textContent).toBe('Io'));
    expect(root.textContent).toContain('Sign out');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/web`
Expected: FAIL — `onUnauthorized` is ignored; `sign-in.js` does not exist; the App shows "Can't reach the PiPulse server".

- [ ] **Step 3: Create `api.ts`**

```ts
// packages/web/src/api.ts
/** An API answer other than 2xx; `body` is the parsed JSON body when there is one. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown
  ) {
    super(`the PiPulse server answered ${status}`);
  }
}

/** Fires 'unauthorized' on any 401, so the app can ask for a sign-in. */
export const authEvents = new EventTarget();

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await (init ? fetch(path, init) : fetch(path));
  if (response.status === 401) authEvents.dispatchEvent(new Event('unauthorized'));
  return response;
}

async function parse<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new HttpError(response.status, body);
  return body as T;
}

export async function getJson<T>(path: string): Promise<T> {
  return parse<T>(await apiFetch(path));
}

export async function sendJson<T>(
  method: 'POST' | 'PUT',
  path: string,
  body?: unknown
): Promise<T> {
  return parse<T>(
    await apiFetch(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    })
  );
}

export interface Session {
  /** A password is configured, so signing in can enable editing. */
  editable: boolean;
  signedIn: boolean;
  /** Every read needs a session too. */
  protectReads: boolean;
}

export const NO_SESSION: Session = { editable: false, signedIn: false, protectReads: false };

/** The session state; an older server (no /api/session) reads as read-only. */
export async function loadSession(): Promise<Session> {
  try {
    return await getJson<Session>('/api/session');
  } catch {
    return NO_SESSION;
  }
}
```

(`fetch(path)` with no second argument when `init` is undefined keeps existing tests that inspect `mock.calls[0]` unchanged.)

- [ ] **Step 4: Create `sign-in.tsx`**

```tsx
// packages/web/src/sign-in.tsx
import { useState } from 'preact/hooks';

const MESSAGES: Record<number, string> = {
  401: 'Sign-in failed. Check the password and try again.',
  403: 'Editing is disabled on this PiPulse: no admin password is configured.',
  429: 'Too many attempts. Wait 15 minutes, then try again.'
};

/**
 * The password form. Posts with plain fetch, not apiFetch: a wrong password
 * answers 401, which must not count as "the session expired".
 */
export function SignIn({ heading, onSignedIn }: { heading?: string; onSignedIn(): void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password })
      });
      if (response.ok) {
        setPassword('');
        onSignedIn();
        return;
      }
      setError(MESSAGES[response.status] ?? `The PiPulse server answered ${response.status}.`);
    } catch {
      setError("Couldn't reach the PiPulse server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="sign-in" onSubmit={submit}>
      <h2>{heading ?? 'Sign in'}</h2>
      <label>
        Password
        <input
          type="password"
          autocomplete="current-password"
          value={password}
          onInput={(event) => setPassword(event.currentTarget.value)}
        />
      </label>
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || password === ''}>
        Sign in
      </button>
    </form>
  );
}
```

- [ ] **Step 5: Stop reconnecting after `4401` (`live.ts`)**

Add to `LiveOptions`:

```ts
  /** The server closed with 4401 (sign-in needed); no reconnect follows. */
  onUnauthorized?: () => void;
```

Replace the `onclose` handler:

```ts
socket.onclose = (event?: CloseEvent) => {
  if (stopped) return;
  if (event?.code === 4401) {
    // Retrying can't help until someone signs in; the app shows the form.
    stopped = true;
    options.onUnauthorized?.();
    return;
  }
  options.onStatus('reconnecting', retryMs);
  timer = setTimeout(open, retryMs);
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
};
```

- [ ] **Step 6: Session, gate and Sign out in `app.tsx`**

1. Replace the local `getJson` with `import { authEvents, getJson, HttpError, loadSession, NO_SESSION, sendJson, type Session } from './api.js';` and `import { SignIn } from './sign-in.js';`.
2. New state next to `config`:

```tsx
const [session, setSession] = useState<Session>(NO_SESSION);
/** Reads need a sign-in and there is no session: show only the form. */
const [needSignIn, setNeedSignIn] = useState(false);
/** Bumped after signing in, to load the config again. */
const [loadKey, setLoadKey] = useState(0);
```

3. In the config `attempt()` failure branch, stop retrying on `401`:

```tsx
(error: unknown) => {
  if (cancelled) return;
  if (error instanceof HttpError && error.status === 401) {
    setNeedSignIn(true);
    return;
  }
  setUnreachable({ retryInMs: retryMs });
  timer = setTimeout(attempt, retryMs);
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
};
```

change the effect's dependency list from `[]` to `[loadKey]`, and after `attempt();` add `void loadSession().then((loaded) => !cancelled && setSession(loaded));`.

4. A new effect reacting to any 401:

```tsx
// Any 401 (an expired session, a restarted server): re-check, and if reads
// are protected, go back to the sign-in form.
useEffect(() => {
  const onUnauthorized = () => {
    void loadSession().then((loaded) => {
      setSession(loaded);
      if (loaded.protectReads && !loaded.signedIn) setNeedSignIn(true);
    });
  };
  authEvents.addEventListener('unauthorized', onUnauthorized);
  return () => authEvents.removeEventListener('unauthorized', onUnauthorized);
}, []);
```

5. Pass `onUnauthorized: () => authEvents.dispatchEvent(new Event('unauthorized'))` to `connectLive`.

6. Helpers and the gate, placed before `if (unreachable)`:

```tsx
const signedIn = () => {
  setNeedSignIn(false);
  setSession((current) => ({ ...current, signedIn: true }));
  setLoadKey((key) => key + 1);
};
const signOut = () => {
  void sendJson('POST', '/api/logout').finally(() => {
    setSession((current) => ({ ...current, signedIn: false }));
    if (session.protectReads) setNeedSignIn(true);
  });
};

if (needSignIn) {
  return (
    <main class="page">
      <SignIn heading="Sign in to PiPulse" onSignedIn={signedIn} />
    </main>
  );
}
```

7. In the header, after `<ConnectionLine … />`:

```tsx
{
  session.signedIn && (
    <button type="button" class="link-button" onClick={signOut}>
      Sign out
    </button>
  );
}
```

- [ ] **Step 7: Route every other API read through `apiFetch`**

In `history-page.tsx` and `alerts-page.tsx` replace `fetch(` with `apiFetch(` and add `import { apiFetch } from './api.js';`.

- [ ] **Step 8: Styles (`styles.css`)**

```css
/* ---- Sign-in and settings ---- */

.sign-in {
  display: grid;
  gap: 0.75rem;
  max-width: 22rem;
  padding: 1.25rem;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface);
}

.sign-in label {
  display: grid;
  gap: 0.3rem;
  color: var(--ink-2);
}

.sign-in input,
.settings-page input[type='text'] {
  font: inherit;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--page);
  color: var(--ink);
}

.form-error {
  color: var(--critical);
}

.link-button {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
}
```

All variables used (`--page`, `--surface`, `--hairline`, `--ink`, `--ink-2`, `--accent`, `--critical`, `--radius`) exist in `styles.css`'s palette, with dark-mode values; do not add new colours.

- [ ] **Step 9: Run the web tests**

Run: `npx vitest run packages/web`
Expected: PASS, including every existing test.

- [ ] **Step 10: Commit**

```bash
git add packages/web
git commit -m "Add sign-in, a read-protection gate and Sign out to the dashboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Web — the Settings page

**Files:**

- Create: `packages/web/src/settings.ts` (pure helpers)
- Create: `packages/web/src/settings-page.tsx`
- Modify: `packages/web/src/router.ts` (`settings` route)
- Modify: `packages/web/src/app.tsx` (nav link, render the page)
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/test/settings.test.ts` (includes the route cases), `packages/web/test/settings-page.test.tsx`

**Interfaces:**

- Consumes: `apiFetch`, `getJson`, `sendJson`, `HttpError`, `Session` (Task 8); `SignIn` (Task 8); `formatValue`, `formatDateTime` from `format.ts`; `StatusIcon` from `tile.tsx`.
- Produces:
  - `settings.ts`: `LEVELS: readonly Resolution[]`; `LEVEL_LABELS: Record<Resolution, string>`; types `LevelSetting`, `SettingsBody`, `LevelDeletion`, `Preview`; `checkDuration(text: string): string | undefined`; `changed(body: SettingsBody, draft: Record<Resolution, string>): Resolution[]`; `formatBytes(bytes: number): string`; `describeChange(resolution: Resolution, deletion: LevelDeletion): { deletes: boolean; text: string }`.
  - `router.ts`: `Route` gains `{ page: 'settings' }`, hash `#/settings`.
  - `SettingsPage({ session: Session; onSessionChange(session: Session): void })`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/test/settings.test.ts
import { describe, expect, it } from 'vitest';
import {
  changed,
  checkDuration,
  describeChange,
  formatBytes,
  type SettingsBody
} from '../src/settings.js';
import { parseRoute, routeHash } from '../src/router.js';

const level = (text: string, ms: number | null) => ({
  text,
  ms,
  source: 'default' as const,
  variable: 'PIPULSE_RETENTION_RAW',
  locked: false
});
const body: SettingsBody = {
  retention: {
    raw: level('2d', 172_800_000),
    '1m': level('14d', 1_209_600_000),
    '1h': level('1y', 31_536_000_000),
    '1d': level('forever', null)
  },
  storage: {
    fileBytes: 0,
    freeBytes: 0,
    diskFreeBytes: null,
    levels: {
      raw: { rows: 0, oldest: null },
      '1m': { rows: 0, oldest: null },
      '1h': { rows: 0, oldest: null },
      '1d': { rows: 0, oldest: null }
    }
  }
};

describe('checkDuration', () => {
  it('accepts the server grammar and explains anything else', () => {
    for (const ok of ['30s', '5min', '36h', '14d', '2w', '1y', 'forever', ' 7D ']) {
      expect(checkDuration(ok)).toBeUndefined();
    }
    expect(checkDuration('5m')).toMatch(/like 30s, 5min/);
    expect(checkDuration('0d')).toMatch(/like/);
  });
});

describe('changed and describeChange', () => {
  it('lists only edited levels, ignoring spacing', () => {
    expect(changed(body, { raw: ' 2d', '1m': '30d', '1h': '1y', '1d': 'forever' })).toEqual(['1m']);
  });

  it('words a deletion and a lengthening', () => {
    expect(
      describeChange('raw', {
        deletesRows: 41_000,
        from: Date.UTC(2026, 8, 21, 18),
        to: Date.UTC(2026, 8, 22, 18)
      })
    ).toEqual({
      deletes: true,
      text: expect.stringMatching(/^Deletes ~41,000 raw readings from .+ to .+ within a minute$/)
    });
    expect(describeChange('raw', { deletesRows: 0, from: null, to: null })).toEqual({
      deletes: false,
      text: "Keeps more from now on. Already-deleted data doesn't come back."
    });
  });
});

describe('formatBytes and the route', () => {
  it('formats sizes and routes #/settings', () => {
    expect(formatBytes(240_000_000)).toBe('240 MB');
    expect(parseRoute('#/settings')).toEqual({ page: 'settings' });
    expect(routeHash({ page: 'settings' })).toBe('#/settings');
  });
});
```

```tsx
// packages/web/test/settings-page.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SettingsPage } from '../src/settings-page.js';
import type { Session } from '../src/api.js';

const DAY = 86_400_000;
const settings = {
  retention: {
    raw: {
      text: '2d',
      ms: 2 * DAY,
      source: 'default',
      variable: 'PIPULSE_RETENTION_RAW',
      locked: false
    },
    '1m': {
      text: '14d',
      ms: 14 * DAY,
      source: 'default',
      variable: 'PIPULSE_RETENTION_1M',
      locked: false
    },
    '1h': {
      text: '1y',
      ms: 365 * DAY,
      source: 'default',
      variable: 'PIPULSE_RETENTION_1H',
      locked: false
    },
    '1d': {
      text: 'forever',
      ms: null,
      source: 'env',
      variable: 'PIPULSE_RETENTION_1D',
      locked: true
    }
  },
  storage: {
    fileBytes: 35_000_000,
    freeBytes: 1_000_000,
    diskFreeBytes: 2_000_000_000,
    levels: {
      raw: { rows: 380_000, oldest: Date.UTC(2026, 8, 20) },
      '1m': { rows: 222_000, oldest: Date.UTC(2026, 8, 8) },
      '1h': { rows: 96_000, oldest: Date.UTC(2025, 8, 22) },
      '1d': { rows: 4000, oldest: Date.UTC(2025, 1, 1) }
    }
  }
};
const preview = {
  deletions: {
    raw: { deletesRows: 190_000, from: Date.UTC(2026, 8, 20), to: Date.UTC(2026, 8, 21) },
    '1m': { deletesRows: 0, from: null, to: null },
    '1h': { deletesRows: 0, from: null, to: null },
    '1d': { deletesRows: 0, from: null, to: null }
  },
  estimatedBytes: 25_000_000
};

let root: HTMLElement;
let putStatus: number;
const calls: { method: string; path: string; body?: unknown }[] = [];

beforeEach(() => {
  putStatus = 200;
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url, body });
      if (url === '/api/settings' && method === 'GET') return Response.json(settings);
      if (url === '/api/settings/preview') return Response.json(preview);
      if (url === '/api/settings' && method === 'PUT') {
        return Response.json(putStatus === 200 ? settings : { error: 'sign in required' }, {
          status: putStatus
        });
      }
      return new Response('not found', { status: 404 });
    })
  );
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(root.textContent).not.toContain('Loading');
  });
}

const signedIn: Session = { editable: true, signedIn: true, protectReads: false };
const input = (name: string) => root.querySelector(`input[name="${name}"]`) as HTMLInputElement;
const button = (text: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

async function type(name: string, value: string) {
  await act(() => {
    input(name).value = value;
    input(name).dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(text: string) {
  await act(async () => {
    button(text).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
}

describe('SettingsPage', () => {
  it('in read-only mode shows values and how to enable editing, with no inputs enabled', async () => {
    render(
      <SettingsPage
        session={{ editable: false, signedIn: false, protectReads: false }}
        onSessionChange={() => {}}
      />,
      root
    );
    await settle();
    expect(root.textContent).toContain('PIPULSE_ADMIN_PASSWORD_HASH_FILE');
    expect(input('raw').disabled).toBe(true);
    expect(root.textContent).toContain('35 MB');
  });

  it('asks a signed-out operator to sign in', async () => {
    render(
      <SettingsPage
        session={{ editable: true, signedIn: false, protectReads: false }}
        onSessionChange={() => {}}
      />,
      root
    );
    await settle();
    expect(root.querySelector('input[type=password]')).not.toBeNull();
    expect(input('raw').disabled).toBe(true);
  });

  it('locks a level set by the environment, naming the variable', async () => {
    render(<SettingsPage session={signedIn} onSessionChange={() => {}} />, root);
    await settle();
    expect(input('1d').disabled).toBe(true);
    expect(root.textContent).toContain('set by PIPULSE_RETENTION_1D');
    expect(input('raw').disabled).toBe(false);
  });

  it('previews a deletion and enables Save only once it is confirmed', async () => {
    render(<SettingsPage session={signedIn} onSessionChange={() => {}} />, root);
    await settle();
    await type('raw', '1d');
    await click('Review changes');
    expect(root.textContent).toMatch(/Deletes ~190,000 raw readings/);
    expect(root.textContent).toContain('25 MB');
    expect(button('Save').disabled).toBe(true);
    const confirm = root.querySelector('input[type=checkbox]') as HTMLInputElement;
    await act(() => confirm.click());
    expect(button('Save').disabled).toBe(false);
    await click('Save');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      retention: { raw: '1d', '1m': '14d', '1h': '1y', '1d': 'forever' },
      confirmDeletion: true
    });
    expect(root.textContent).toContain('Saved');
  });

  it('falls back to the sign-in form when the session is gone (server restarted)', async () => {
    const onSessionChange = vi.fn();
    putStatus = 401;
    render(<SettingsPage session={signedIn} onSessionChange={onSessionChange} />, root);
    await settle();
    await type('raw', '1d');
    await click('Review changes');
    await act(() => (root.querySelector('input[type=checkbox]') as HTMLInputElement).click());
    await click('Save');
    expect(onSessionChange).toHaveBeenCalledWith({ ...signedIn, signedIn: false });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/web/test/settings.test.ts packages/web/test/settings-page.test.tsx`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Add the route (`router.ts`)**

```ts
export type Route =
  { page: 'now' } | { page: 'history'; range: RangeId } | { page: 'alerts' } | { page: 'settings' };
```

In `parseRoute`, after the alerts line: `if (path === '/settings') return { page: 'settings' };`. In `routeHash`:

```ts
export function routeHash(route: Route): string {
  if (route.page === 'history') return `#/history?range=${route.range}`;
  if (route.page === 'settings') return '#/settings';
  return route.page === 'alerts' ? '#/alerts' : '#/';
}
```

Update the doc comment to mention `"#/settings"`.

- [ ] **Step 4: Create `settings.ts`**

```ts
// packages/web/src/settings.ts
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
export function checkDuration(text: string): string | undefined {
  const value = text.trim().toLowerCase();
  if (value === 'forever') return undefined;
  const match = /^(\d+(?:\.\d+)?)(s|min|h|d|w|y)$/.exec(value);
  if (match && Number(match[1]) > 0) return undefined;
  return 'Use a duration like 30s, 5min, 36h, 14d, 2w, 1y or forever.';
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
  deletion: LevelDeletion
): { deletes: boolean; text: string } {
  if (deletion.deletesRows > 0 && deletion.from !== null && deletion.to !== null) {
    return {
      deletes: true,
      text: `Deletes ~${deletion.deletesRows.toLocaleString('en-US')} ${LEVEL_NOUNS[resolution]} from ${formatDateTime(deletion.from)} to ${formatDateTime(deletion.to)} within a minute`
    };
  }
  return {
    deletes: false,
    text: "Keeps more from now on. Already-deleted data doesn't come back."
  };
}
```

- [ ] **Step 5: Create `settings-page.tsx`**

```tsx
// packages/web/src/settings-page.tsx
import { useEffect, useState } from 'preact/hooks';
import { getJson, HttpError, sendJson, type Session } from './api.js';
import { formatDateTime } from './format.js';
import {
  changed,
  checkDuration,
  describeChange,
  formatBytes,
  LEVEL_LABELS,
  LEVELS,
  type Preview,
  type SettingsBody
} from './settings.js';
import { SignIn } from './sign-in.js';
import { StatusIcon } from './tile.js';
import type { Resolution } from './types.js';

type Draft = Record<Resolution, string>;
type Loaded = { status: 'loading' } | { status: 'error' } | { status: 'ready'; body: SettingsBody };
type Review =
  | { status: 'none' }
  | { status: 'errors'; errors: Partial<Record<Resolution, string>> }
  | { status: 'ready'; preview: Preview };

const draftOf = (body: SettingsBody): Draft =>
  Object.fromEntries(LEVELS.map((level) => [level, body.retention[level].text])) as Draft;

function sourceText(setting: SettingsBody['retention'][Resolution]): string {
  if (setting.locked) return `🔒 set by ${setting.variable}`;
  return setting.source === 'saved' ? 'saved' : 'default';
}

/**
 * Retention per level, with a preview of what a change deletes before it
 * is saved, and the storage figures that help choose a policy.
 */
export function SettingsPage({
  session,
  onSessionChange
}: {
  session: Session;
  onSessionChange(session: Session): void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [draft, setDraft] = useState<Draft>();
  const [review, setReview] = useState<Review>({ status: 'none' });
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<string>();
  const canEdit = session.editable && session.signedIn;

  useEffect(() => {
    getJson<SettingsBody>('/api/settings').then(
      (body) => {
        setLoaded({ status: 'ready', body });
        setDraft(draftOf(body));
      },
      () => setLoaded({ status: 'error' })
    );
  }, []);

  /** A 401 here means the session is gone (expired or the server restarted). */
  const handle = (error: unknown) => {
    if (error instanceof HttpError && error.status === 401) {
      onSessionChange({ ...session, signedIn: false });
      return;
    }
    if (error instanceof HttpError && error.status === 400) {
      const errors = (error.body as { errors?: Partial<Record<Resolution, string>> })?.errors;
      if (errors) {
        setReview({ status: 'errors', errors });
        return;
      }
    }
    setMessage("Couldn't reach the PiPulse server. Nothing was saved.");
  };

  if (loaded.status === 'loading' || !draft) {
    return loaded.status === 'error' ? (
      <p class="waiting">Couldn't load the settings from the PiPulse server.</p>
    ) : (
      <p class="waiting">Loading</p>
    );
  }
  const { body } = loaded as { status: 'ready'; body: SettingsBody };
  const edited = changed(body, draft);
  const typingErrors = Object.fromEntries(
    LEVELS.map((level) => [level, checkDuration(draft[level])]).filter(([, problem]) => problem)
  ) as Partial<Record<Resolution, string>>;
  const fieldErrors =
    review.status === 'errors' ? { ...review.errors, ...typingErrors } : typingErrors;
  const changes =
    review.status === 'ready'
      ? edited.map((level) => ({
          level,
          ...describeChange(level, review.preview.deletions[level])
        }))
      : [];
  const deletes = changes.some((change) => change.deletes);

  const edit = (level: Resolution, value: string) => {
    setDraft({ ...draft, [level]: value });
    setReview({ status: 'none' });
    setConfirmed(false);
    setMessage(undefined);
  };

  const reviewChanges = () => {
    sendJson<Preview>('POST', '/api/settings/preview', { retention: draft }).then(
      (preview) => setReview({ status: 'ready', preview }),
      handle
    );
  };

  const save = () => {
    sendJson<SettingsBody>('PUT', '/api/settings', {
      retention: draft,
      ...(deletes ? { confirmDeletion: true } : {})
    }).then((saved) => {
      setLoaded({ status: 'ready', body: saved });
      setDraft(draftOf(saved));
      setReview({ status: 'none' });
      setConfirmed(false);
      setMessage('Saved. Housekeeping applies it within a minute.');
    }, handle);
  };

  return (
    <div class="settings-page">
      <section aria-labelledby="settings-retention">
        <h2 id="settings-retention">Data retention</h2>
        {!session.editable && (
          <div class="note">
            <p>
              Editing is off: no admin password is configured. To turn it on, run{' '}
              <code>node packages/api/dist/hash-password.js</code>, save its output to a file only
              PiPulse can read, set <code>PIPULSE_ADMIN_PASSWORD_HASH_FILE</code> to that file and
              restart PiPulse.
            </p>
          </div>
        )}
        {session.editable && !session.signedIn && (
          <SignIn
            heading="Sign in to change settings"
            onSignedIn={() => onSessionChange({ ...session, signedIn: true })}
          />
        )}
        <table class="retention-table">
          <thead>
            <tr>
              <th scope="col">Level</th>
              <th scope="col">Keep for</th>
              <th scope="col">Source</th>
              <th scope="col">Stored now</th>
            </tr>
          </thead>
          <tbody>
            {LEVELS.map((level) => {
              const setting = body.retention[level];
              const usage = body.storage.levels[level];
              const problem = fieldErrors[level];
              return (
                <tr key={level}>
                  <th scope="row">
                    <label for={`retention-${level}`}>{LEVEL_LABELS[level]}</label>
                  </th>
                  <td>
                    <input
                      id={`retention-${level}`}
                      name={level}
                      type="text"
                      value={draft[level]}
                      disabled={!canEdit || setting.locked}
                      aria-invalid={problem ? 'true' : undefined}
                      aria-describedby={problem ? `retention-${level}-error` : undefined}
                      onInput={(event) => edit(level, event.currentTarget.value)}
                    />
                    {problem && (
                      <p class="form-error" id={`retention-${level}-error`}>
                        {problem}
                      </p>
                    )}
                  </td>
                  <td>{sourceText(setting)}</td>
                  <td>
                    {usage.rows.toLocaleString('en-US')} rows
                    {usage.oldest !== null && `, since ${formatDateTime(usage.oldest)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {canEdit && (
          <button
            type="button"
            disabled={edited.length === 0 || Object.keys(typingErrors).length > 0}
            onClick={reviewChanges}
          >
            Review changes
          </button>
        )}
        {review.status === 'ready' && (
          <div class="preview">
            <ul>
              {changes.map((change) => (
                <li key={change.level} data-severity={change.deletes ? 'critical' : undefined}>
                  {change.deletes && <StatusIcon level="critical" />}
                  <strong>{LEVEL_LABELS[change.level]}:</strong> {change.text}
                </li>
              ))}
            </ul>
            <p>
              Estimated size once this policy is full: ≈{' '}
              {formatBytes(review.preview.estimatedBytes)}
            </p>
            {deletes && (
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.currentTarget.checked)}
                />{' '}
                I understand this deletes data
              </label>
            )}
            <button type="button" disabled={deletes && !confirmed} onClick={save}>
              Save
            </button>
          </div>
        )}
        {message && <p role="status">{message}</p>}
      </section>
      <section aria-labelledby="settings-storage">
        <h2 id="settings-storage">Storage</h2>
        <dl class="facts">
          <div>
            <dt>Database</dt>
            <dd>{formatBytes(body.storage.fileBytes)}</dd>
          </div>
          <div>
            <dt>Free inside it</dt>
            <dd>{formatBytes(body.storage.freeBytes)}</dd>
          </div>
          {body.storage.diskFreeBytes !== null && (
            <div>
              <dt>Free on disk</dt>
              <dd>{formatBytes(body.storage.diskFreeBytes)}</dd>
            </div>
          )}
        </dl>
      </section>
    </div>
  );
}
```

- [ ] **Step 6: Link and render it (`app.tsx`)**

Add `import { SettingsPage } from './settings-page.js';`. After the Alerts link in the nav:

```tsx
<a
  href={routeHash({ page: 'settings' })}
  aria-current={route.page === 'settings' ? 'page' : undefined}
>
  Settings
</a>
```

In the page switch, before the alerts branch:

```tsx
      ) : route.page === 'settings' ? (
        <SettingsPage
          session={session}
          onSessionChange={(next) => {
            setSession(next);
            if (next.protectReads && !next.signedIn) setNeedSignIn(true);
          }}
        />
```

- [ ] **Step 7: Styles (`styles.css`)**

```css
.settings-page {
  display: grid;
  gap: 24px;
}

.retention-table {
  border-collapse: collapse;
  width: 100%;
  max-width: 48rem;
}

.retention-table th,
.retention-table td {
  text-align: left;
  padding: 0.4rem 0.6rem 0.4rem 0;
  vertical-align: top;
  border-bottom: 1px solid var(--hairline);
}

.preview,
.note {
  max-width: 48rem;
  padding: 1rem;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface);
  display: grid;
  gap: 0.6rem;
}

.preview li[data-severity='critical'] {
  color: var(--critical);
}
```

(Same colour-variable rule as Task 8.)

- [ ] **Step 8: Run the web tests**

Run: `npx vitest run packages/web`
Expected: PASS.

- [ ] **Step 9: Look at it**

Run `npm run build`, start a server with a hash file (Task 5's command) on port 8899 against a scratch database, open `http://localhost:8899/#/settings`, and check the three states (read-only without the file, signed out, signed in) at desktop and phone width. Stop the server and delete the scratch files.

- [ ] **Step 10: Commit**

```bash
git add packages/web
git commit -m "Add the Settings page with retention preview and confirmation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Documentation

**Files:**

- Modify: `README.md`, `CLAUDE.md`, `docs/PLAN.md`

- [ ] **Step 1: README**

- Status line: Phase 5b-1 complete (sign-in, Settings page with retention editor).
- Env table: add
  - `| PIPULSE_ADMIN_PASSWORD_HASH_FILE | _(none)_ | File with the admin password hash (make one with hash-password); unset = read-only |`
  - `| PIPULSE_PROTECT_READS | false | true: every page, API read and the live feed need sign-in |`
- Retention paragraph: values can also be changed on the Settings page; an environment variable wins and locks that field; levels must not be out of order (raw ≤ 1-minute ≤ hourly ≤ daily), and an out-of-order environment stops startup; the database compacts itself after a large deletion (at most daily, only with room on disk).
- Endpoints paragraph: `GET /api/session`, `POST /api/login`, `POST /api/logout`, `GET /api/settings`, `POST /api/settings/preview`, `PUT /api/settings`; replace "There is no authentication yet" with: writes need sign-in, reads optionally; plain HTTP, so keep it on your LAN.
- New `## Sign-in and settings` section:

````markdown
## Sign-in and settings

Without a password PiPulse is read-only: everything shows, nothing can be changed. To enable editing:

```bash
node packages/api/dist/hash-password.js > ~/pipulse-admin.hash   # asks twice, prints one line
chmod 600 ~/pipulse-admin.hash
PIPULSE_ADMIN_PASSWORD_HASH_FILE=~/pipulse-admin.hash node packages/api/dist/server.js
```

Only the scrypt hash is stored; to change the password, make a new file and restart. Sign in on the Settings page; the session lasts 7 days from last use, and a restart signs you out. Five wrong passwords from one address lock it out for 15 minutes.

The Settings page shows each retention level, where its value comes from (default, saved, or locked by a `PIPULSE_RETENTION_*` variable), how much is stored, and the database and disk size. **Review changes** shows what a shorter retention will delete and an estimated database size; deleting anything needs an explicit tick before **Save**. Changes apply within a minute, no restart.

Set `PIPULSE_PROTECT_READS=true` to require sign-in for everything, including the live feed.

PiPulse speaks plain HTTP: the password crosses the network once at sign-in. Keep it on your LAN; putting it behind a TLS reverse proxy is planned (see `docs/PLAN.md`, "Future: behind a reverse proxy").
````

- Configuration section: mention the Settings page for retention.
- Roadmap: split 5b into `5b-1 | Sign-in, settings, retention editor | ✅ Done`, `5b-2 | Rules in the browser, acknowledging alerts | ⏳ Next`, `5b-3 | Notifications (webhook) |`.

- [ ] **Step 2: CLAUDE.md**

Add a Phase 5b-1 paragraph under "Current status" (auth in `packages/api/src/auth.ts` + one hook in `auth-routes.ts`; hash file; in-memory sessions; `PIPULSE_PROTECT_READS`; `settings` table migration 5; retention env › saved › default re-read every housekeeping run via `retentionSource`; preview/confirm; automatic `VACUUM`; Settings page; test count). Set "Next up" to 5b-2 (rules in the browser, acknowledging, `swap_heavy`). Add conventions: every route goes through the one auth hook — never check auth inside a route; saved settings are read live (`retentionSource`), never cached at startup; `PIPULSE_TRUST_PROXY` stays out until a proxy exists.

- [ ] **Step 3: PLAN.md**

In the build plan, mark 5b as split: 5b-1 ✅ Done (exit criterion as in the spec), 5b-2 rules in the browser + acknowledging + `swap_heavy`, 5b-3 notifications. Remove the "Not built yet: a `PRAGMA optimize` / periodic `VACUUM`" line in "Keeping storage bounded" and say the automatic `VACUUM` exists (thresholds). In "Security considerations", update "Add real authentication" to describe what now exists.

- [ ] **Step 4: Check and commit**

Run: `npx prettier --write README.md CLAUDE.md docs/PLAN.md && npx prettier --check README.md CLAUDE.md docs/PLAN.md`

```bash
git add README.md CLAUDE.md docs/PLAN.md
git commit -m "Document sign-in, the Settings page and saved retention

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Exit criterion on the Pi 2

Manual; the human runs the Pi-side commands (password SSH only), the agent drives the checks from the Mac. **Every path is absolute.** Port 8889 already has a ufw rule.

- [ ] **Step 1: Copy the branch and a real database**

From the Mac:

```
rsync -az --exclude node_modules --exclude .git --exclude dist --exclude .playwright-mcp /Users/seviyon/Repositories/PiPulse/ seviyon@192.168.1.35:/home/seviyon/PiPulse-test/
```

On the Pi, build (nvm Node 22) and make a scratch database with at least a few days of data. Either copy the Phase 4 seeded database if it is still on the Mac, or let the server collect for a while; the raw-retention cut below needs raw rows older than the new limit.

```
nvm use 22 && cd /home/seviyon/PiPulse-test && npm ci && npm run build
```

- [ ] **Step 2: Read-only mode**

```
PIPULSE_DB_PATH=/tmp/pp-5b.sqlite PIPULSE_PORT=8889 node --disable-warning=ExperimentalWarning /home/seviyon/PiPulse-test/packages/api/dist/server.js
```

From the Mac: `curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' -d '{"retention":{}}' http://192.168.1.35:8889/api/settings` → `403`; `#/settings` shows values read-only with the "how to enable" box. Stop the server.

- [ ] **Step 3: Editing enabled**

On the Pi: `node /home/seviyon/PiPulse-test/packages/api/dist/hash-password.js > /tmp/pp-admin.hash && chmod 600 /tmp/pp-admin.hash`, then start with `PIPULSE_ADMIN_PASSWORD_HASH_FILE=/tmp/pp-admin.hash` added.

1. Unauthenticated `PUT` → `401`.
2. In the browser: sign in, set raw retention shorter than the oldest raw row (e.g. `1h` if the rules allow; the minimum is the longest rule look-back, 15 min), Review → the deletion line and estimate show; Save is disabled until the box is ticked; Save.
3. Within a minute `GET /api/settings` shows raw `rows` dropped and `oldest` within the new limit.
4. If the deletion freed ≥ 25 % of a file over 8 MB, the server log shows `[pipulse] vacuum: … MB → … MB in … s` and `ls -l /tmp/pp-5b.sqlite` is smaller. (If the scratch database is under 8 MB, note it and check the vacuum on the seeded database instead.)
5. Restart the server: `GET /api/settings` still shows raw `saved` with the new value, and the browser must sign in again.

- [ ] **Step 4: Read protection**

Restart with `PIPULSE_PROTECT_READS=true` too. A fresh browser (Playwright) at `http://192.168.1.35:8889/` shows only the sign-in form; `curl -s -o /dev/null -w '%{http_code}' http://192.168.1.35:8889/api/metrics/latest` → `401`; after signing in the dashboard works and the live indicator reaches Live.

- [ ] **Step 5: Clean up**

Stop the server; `rm -rf /home/seviyon/PiPulse-test /tmp/pp-5b.sqlite* /tmp/pp-admin.hash`.

- [ ] **Step 6: Record the result**

Update `CLAUDE.md`'s 5b-1 paragraph with what was verified (timings, vacuum sizes) and commit.
