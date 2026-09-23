# Phase 5b-2 Alert Rules in the Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The signed-in operator adds, edits, disables and reverts alert rules and acknowledges open alerts from the Alerts page, with changes in force within one check and no restart; `swap_heavy` measures swap traffic instead of swap fullness.

**Architecture:** `packages/storage` gains migration 6 (`alerts.acknowledged_at`, `alerts.rule_hash`). `packages/alerts` gains field-aware rule errors, a saved rules layer (settings key `alerts.rules`) merged above the file and the built-ins by a `createRuleSource()` read on every check, an engine that takes a rules function and closes alerts whose rule was removed (`rule_removed`) or changed (`rule_changed`, by fingerprint), and `acknowledgeAlert()`. `packages/collector` gains a `swap_io` plugin (pages/s from `/proc/vmstat`), which the built-in `swap_heavy` now watches. `packages/api` gains `alert-routes.ts` (rules `GET`/`PUT`/`DELETE`, acknowledge) and pushes `rules` and `acknowledged` messages over `/api/live`. `packages/web` gains a rules editor and Acknowledge buttons on the Alerts page, and follows rule changes live.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Node ≥ 22.13 (`node:sqlite`, `node:crypto`), Fastify 5 + `@fastify/websocket`, Preact, Vitest 5 (happy-dom for web).

**Spec:** `docs/superpowers/specs/2026-09-24-alert-rules-editor-design.md`

## Global Constraints

- Node.js `>=22.13.0`. No new runtime dependencies.
- No npm `pre*`/`post*` lifecycle hooks (this machine runs with `ignore-scripts=true`).
- Build order stays storage → collector → alerts → api → web. A test in one package runs against the **built** `dist/` of the packages it imports, so after changing an upstream package run `npm run build` (or `npm test`, which builds first) before its dependants' tests.
- Migrations 1–5 are never edited; migration 6 is appended.
- Every write goes through the one `onRequest` hook in `packages/api/src/auth-routes.ts`; no route checks auth itself. Non-`GET`/`HEAD` `/api/*` requests (so `PUT`, `DELETE`, `POST`) already need a session there.
- Saved settings are read live on every use, never cached at startup.
- Durations use the existing `parseDuration`: `s`, `min`, `h`, `d`, `w`, `y`, `forever`; a bare `m` is rejected.
- Rule layers merge by `id`, later wins: built-in → file → saved. An invalid `PIPULSE_ALERTS_FILE` still stops startup; an invalid saved entry never does.
- Saved layer: settings key `alerts.rules`, an array of rules-file-format entries, at most 200. A rule `PUT` body is at most 4096 bytes.
- `cleared_by` values: `'condition' | 'rule_removed' | 'rule_changed'`.
- Built-in `swap_heavy`: `swap_io` ≥ 250 pages/s for `10min`, message "Swapping heavily". `swap_full` stays `swap_used` ≥ 95 % for `10min`.
- Colour never carries meaning alone on the dashboard: always an icon and words.
- Each package's tests live in its `test/` folder; `npm test`, `npm run lint` and `npx prettier --check` on changed files pass before every commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec clarification: `PUT` and `DELETE /api/alerts/rules/:id` both answer `{ rules: RuleEntry[] }` (the full editor list after the change) rather than a single entry, so the page replaces its list in one step.

## Review Focus

1. **A rule body with an unknown field** (`{"id":"x", …, "bogus":1}`): must be a `400` naming the field. Fastify's default validator _strips_ properties not in a schema with `additionalProperties: false` instead of rejecting them (see the comment in `packages/api/test/alerts.test.ts`), so the route schema must be just `{ type: 'object' }` and `parseRuleEntry` must do the rejecting. Test in Task 6.
2. **A `rules` WebSocket message arriving on the dashboard**: it must update tile colours without reconnecting the socket or reloading history. `App`'s live effect depends on `config`, so rules must live in their own state, not be written into `config`. Test in Task 8.
3. **A saved rule that becomes invalid later** (the operator shortens `PIPULSE_RETENTION_RAW` below a saved rule's `for`): the server still starts, the saved entry shows a problem, and the rule below it (if any) stays in force. Test in Task 3.
4. **Editing a rule whose open alert was acknowledged**: the old alert closes as `rule_changed` and the re-raised alert is a new row, not acknowledged — loud again. Test in Task 4.
5. **Disabling a `*` rule with several silent metrics** (`not_collecting`): every one of its open alerts closes as `rule_removed` on the next check, not only at startup. Test in Task 4.

---

## File Structure

| File                                                    | Change | Responsibility                                                                                                                                                                      |
| ------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/storage/src/migrations.ts`                    | modify | Migration 6: `acknowledged_at`, `rule_hash` columns                                                                                                                                 |
| `packages/alerts/src/store.ts`                          | modify | `Alert` gains `acknowledgedAt`, `ruleHash`; `raiseAlert` stores a hash; `acknowledgeAlert`; `rule_changed`                                                                          |
| `packages/alerts/src/rules.ts`                          | modify | Field-aware `AlertRulesError`, exported `parseRuleEntry` (saved entries may be full rules with `disabled`), `ruleProblem`, `durationText`, `ruleToEntry`; `swap_heavy` on `swap_io` |
| `packages/alerts/src/source.ts`                         | create | `createRuleSource()`: the three layers merged on every read; editor entries; `save`/`remove` with validation                                                                        |
| `packages/alerts/src/engine.ts`                         | modify | Rules as a function; per-check `rule_removed`/`rule_changed`; `ruleHash()`                                                                                                          |
| `packages/collector/src/swap-io.ts`                     | create | `swap_io` plugin                                                                                                                                                                    |
| `packages/collector/src/index.ts`                       | modify | Register `swap_io` after `swap_used`                                                                                                                                                |
| `packages/api/src/alert-routes.ts`                      | create | Rules `GET`/`PUT`/`DELETE`, acknowledge; `Notice` messages                                                                                                                          |
| `packages/api/src/settings-routes.ts`                   | modify | `rawAtLeast` becomes a function; `durationText` moves to alerts                                                                                                                     |
| `packages/api/src/index.ts`                             | modify | Register alert routes; `/api/config` rules from the source; notices on `/api/live`                                                                                                  |
| `packages/api/src/server.ts`                            | modify | Build the rule source; wire engine, routes, retention check                                                                                                                         |
| `packages/web/src/types.ts`                             | modify | `RuleEntry`, `acknowledgedAt`, `rules` and `acknowledged` messages                                                                                                                  |
| `packages/web/src/alerts.ts`                            | modify | `applyAlertEvent` handles `acknowledged`; `unacknowledged()`                                                                                                                        |
| `packages/web/src/api.ts`                               | modify | `sendJson` accepts `DELETE`                                                                                                                                                         |
| `packages/web/src/rule-form.ts`                         | create | Pure form helpers: draft ↔ rules-file body, error field mapping, enable/disable request                                                                                             |
| `packages/web/src/rules-editor.tsx`                     | create | Rules section: rows, actions, inline form                                                                                                                                           |
| `packages/web/src/alerts-page.tsx`                      | modify | Acknowledge button and tag; uses `RulesSection`                                                                                                                                     |
| `packages/web/src/app.tsx`                              | modify | Live `rules` state, badge counts unacknowledged, passes session to Alerts page                                                                                                      |
| `packages/web/src/tile.tsx`                             | modify | Muted acknowledged alert line                                                                                                                                                       |
| `packages/web/src/history.ts`                           | modify | `swap_io` history-only                                                                                                                                                              |
| `packages/web/src/styles.css`                           | modify | Rule actions, form, acknowledged styles                                                                                                                                             |
| `README.md`, `CLAUDE.md`, `docs/PLAN.md`, alerting spec | modify | Status and the changed conventions                                                                                                                                                  |

---

### Task 1: Migration 6 and alert acknowledgement in the store

**Files:**

- Modify: `packages/storage/src/migrations.ts` (append after migration 5, ~line 167)
- Modify: `packages/alerts/src/store.ts`
- Test: `packages/storage/test/migrations.test.ts`, `packages/alerts/test/store.test.ts`

**Interfaces:**

- Produces: `Alert` gains `acknowledgedAt: number | null` and `ruleHash: string | null`; `clearedBy: 'condition' | 'rule_removed' | 'rule_changed' | null`.
- Produces: `raiseAlert(db, alert: NewAlert): Alert` where `NewAlert = Pick<Alert, 'ruleId' | 'metric' | 'severity' | 'message' | 'value' | 'raisedAt'> & { ruleHash?: string | null }`.
- Produces: `clearAlert(db, id, clearedAt, clearedBy: 'condition' | 'rule_removed' | 'rule_changed'): Alert`.
- Produces: `acknowledgeAlert(db, id: number, at: number): Alert | 'not_found' | 'cleared'`.

- [ ] **Step 1: Write the failing migration test**

Append inside the existing top-level `describe` in `packages/storage/test/migrations.test.ts` (it already has a `columns(db, table)` helper and imports `openDb`, `SCHEMA_VERSION`):

```ts
it('adds acknowledged_at and rule_hash to alerts (migration 6)', () => {
  const db = openDb(join(dir, 'six.db'));
  expect(SCHEMA_VERSION).toBe(6);
  expect(columns(db, 'alerts')).toEqual(expect.arrayContaining(['acknowledged_at', 'rule_hash']));
  db.close();
});
```

- [ ] **Step 2: Write the failing store tests**

Append to `packages/alerts/test/store.test.ts` (add `acknowledgeAlert` to the import from `'../src/index.js'`):

```ts
describe('acknowledgeAlert', () => {
  it('marks an open alert once and keeps the first time', () => {
    const alert = raiseAlert(db, { ...base, raisedAt: 1000 });
    expect(alert.acknowledgedAt).toBeNull();
    expect(acknowledgeAlert(db, alert.id, 2000)).toMatchObject({
      id: alert.id,
      acknowledgedAt: 2000
    });
    expect(acknowledgeAlert(db, alert.id, 3000)).toMatchObject({ acknowledgedAt: 2000 });
    expect(openAlerts(db)[0]).toMatchObject({ acknowledgedAt: 2000 });
  });

  it('refuses a cleared alert and reports an unknown one', () => {
    const alert = raiseAlert(db, { ...base, raisedAt: 1000 });
    clearAlert(db, alert.id, 1500, 'condition');
    expect(acknowledgeAlert(db, alert.id, 2000)).toBe('cleared');
    expect(acknowledgeAlert(db, 999, 2000)).toBe('not_found');
  });
});

describe('raiseAlert', () => {
  it('stores the fingerprint of the rule that raised it, null when not given', () => {
    expect(raiseAlert(db, { ...base, raisedAt: 1000, ruleHash: 'abc' }).ruleHash).toBe('abc');
    expect(raiseAlert(db, { ...base, metric: 'other', raisedAt: 1000 }).ruleHash).toBeNull();
  });

  it('can be closed as rule_changed', () => {
    const alert = raiseAlert(db, { ...base, raisedAt: 1000 });
    expect(clearAlert(db, alert.id, 2000, 'rule_changed').clearedBy).toBe('rule_changed');
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npm run build --workspace=packages/storage && npx vitest run packages/storage/test/migrations.test.ts packages/alerts/test/store.test.ts`
Expected: FAIL — `SCHEMA_VERSION` is 5; `acknowledgeAlert` is not exported.

- [ ] **Step 4: Add migration 6**

In `packages/storage/src/migrations.ts`, after the migration 5 function (before the closing `];`):

```ts
// 6: 5b-2. acknowledged_at marks an open alert as seen until it clears;
// rule_hash fingerprints the rule that raised it, so an alert whose rule
// was edited in the browser is closed as 'rule_changed' and re-raised
// under the new rule. Both NULL on alerts raised before this migration.
(db) => {
  db.exec(`
      ALTER TABLE alerts ADD COLUMN acknowledged_at INTEGER;
      ALTER TABLE alerts ADD COLUMN rule_hash TEXT;
    `);
};
```

- [ ] **Step 5: Update the store**

In `packages/alerts/src/store.ts`:

```ts
export type ClearedBy = 'condition' | 'rule_removed' | 'rule_changed';

export interface Alert {
  id: number;
  ruleId: string;
  metric: string;
  severity: Severity;
  message: string;
  /** The reading that raised it; null for a silence alert. */
  value: number | null;
  raisedAt: number;
  clearedAt: number | null;
  clearedBy: ClearedBy | null;
  /** When someone marked it as seen; null until then. Cleared with the alert. */
  acknowledgedAt: number | null;
  /** Fingerprint of the rule that raised it (see ruleHash); null before migration 6. */
  ruleHash: string | null;
}

export type NewAlert = Pick<
  Alert,
  'ruleId' | 'metric' | 'severity' | 'message' | 'value' | 'raisedAt'
> & { ruleHash?: string | null };

const COLUMNS = `id, rule_id AS ruleId, metric, severity, message, value,
  raised_at AS raisedAt, cleared_at AS clearedAt, cleared_by AS clearedBy,
  acknowledged_at AS acknowledgedAt, rule_hash AS ruleHash`;
```

Replace `raiseAlert` and `clearAlert`, and add `acknowledgeAlert`:

```ts
export function raiseAlert(db: PiPulseDb, alert: NewAlert): Alert {
  return db
    .prepare(
      `INSERT INTO alerts (rule_id, metric, severity, message, value, raised_at, rule_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`
    )
    .get(
      alert.ruleId,
      alert.metric,
      alert.severity,
      alert.message,
      alert.value,
      alert.raisedAt,
      alert.ruleHash ?? null
    ) as unknown as Alert;
}

export function clearAlert(
  db: PiPulseDb,
  id: number,
  clearedAt: number,
  clearedBy: ClearedBy
): Alert {
  return db
    .prepare(`UPDATE alerts SET cleared_at = ?, cleared_by = ? WHERE id = ? RETURNING ${COLUMNS}`)
    .get(clearedAt, clearedBy, id) as unknown as Alert;
}

/**
 * Marks an open alert as seen. Acknowledging again keeps the first time; a
 * cleared alert can't be acknowledged (the next raise is a new row anyway).
 */
export function acknowledgeAlert(
  db: PiPulseDb,
  id: number,
  at: number
): Alert | 'not_found' | 'cleared' {
  const updated = db
    .prepare(
      `UPDATE alerts SET acknowledged_at = COALESCE(acknowledged_at, ?)
       WHERE id = ? AND cleared_at IS NULL RETURNING ${COLUMNS}`
    )
    .get(at, id) as unknown as Alert | undefined;
  if (updated) return updated;
  return db.prepare('SELECT 1 FROM alerts WHERE id = ?').get(id) ? 'cleared' : 'not_found';
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npm run build --workspace=packages/storage && npx vitest run packages/storage packages/alerts`
Expected: PASS (existing tests that compare whole alert objects with `toEqual` may now need `acknowledgedAt: null, ruleHash: null` added to their expected objects — add them; don't loosen to `toMatchObject`).

- [ ] **Step 7: Commit**

```bash
git add packages/storage packages/alerts
git commit -m "Add migration 6 and acknowledging alerts in the store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Field-aware rule parsing, saved-entry shapes and rule helpers

**Files:**

- Modify: `packages/alerts/src/rules.ts`
- Test: `packages/alerts/test/rules.test.ts`

**Interfaces:**

- Produces: `class AlertRulesError extends Error { constructor(message: string, readonly field?: string, readonly detail?: string) }` — `field` is the rules-file field at fault (`'id'`, `'metric'`, `'atLeast'`, `'for'`, …, or `'condition'` when the number of conditions is wrong); `detail` is the problem without the "where" prefix.
- Produces: `Rule.source: 'built-in' | 'file' | 'saved'`.
- Produces: `interface Entry { id: string; disabled: boolean; rule?: Rule }` and `parseRuleEntry(raw: unknown, where: string, source: 'file' | 'saved'): Entry`.
- Produces: `ruleProblem(rule: Rule, known: string[], rawRetentionMs: number): { field: string; message: string } | undefined`.
- Produces: `durationText(ms: number): string` (`0` → `"0s"`, else largest whole of `d`/`h`/`min`, else whole `s` rounded up) and `ruleToEntry(rule: Rule): Record<string, unknown>` (rules-file format).

- [ ] **Step 1: Write the failing tests**

Append to `packages/alerts/test/rules.test.ts` (extend the import with `durationText`, `parseRuleEntry`, `ruleProblem`, `ruleToEntry`):

```ts
describe('parseRuleEntry', () => {
  const full = {
    id: 'my_rule',
    metric: 'cpu_load',
    atLeast: 50,
    for: '1min',
    severity: 'warning',
    message: 'Busy'
  };

  it('names the field at fault, with the problem apart from where it is', () => {
    const fieldOf = (raw: unknown) => {
      try {
        parseRuleEntry(raw, 'rule', 'saved');
      } catch (error) {
        const e = error as AlertRulesError;
        return [e.field, e.detail];
      }
      return undefined;
    };
    expect(fieldOf({ ...full, bogus: 1 })).toEqual(['bogus', 'unknown field "bogus"']);
    expect(fieldOf({ ...full, id: 'Bad Id' })).toEqual(['id', 'id must be lowercase snake_case']);
    expect(fieldOf({ ...full, severity: 'loud' })[0]).toBe('severity');
    expect(fieldOf({ ...full, message: ' ' })[0]).toBe('message');
    expect(fieldOf({ ...full, for: '5m' })[0]).toBe('for');
    expect(fieldOf({ ...full, atLeast: 'x' })[0]).toBe('atLeast');
    expect(fieldOf({ ...full, atMost: 3 })[0]).toBe('condition');
    expect(fieldOf({ ...full, metric: '*' })[0]).toBe('metric');
  });

  it('reads a bare disable, and in the saved layer a full rule that is switched off', () => {
    expect(parseRuleEntry({ id: 'cpu_busy', disabled: true }, 'rule', 'saved')).toEqual({
      id: 'cpu_busy',
      disabled: true
    });
    const off = parseRuleEntry({ ...full, disabled: true }, 'rule', 'saved');
    expect(off).toMatchObject({
      id: 'my_rule',
      disabled: true,
      rule: { atLeast: 50, source: 'saved' }
    });
  });

  it('keeps the file ignoring the other fields of a disabled entry', () => {
    expect(parseRuleEntry({ ...full, disabled: true, for: 'nonsense' }, 'rule', 'file')).toEqual({
      id: 'my_rule',
      disabled: true
    });
  });
});

describe('ruleProblem', () => {
  const rule = builtinRules(4).find((r) => r.id === 'cpu_warm')!;
  it('flags an unknown metric and a look-back beyond raw retention', () => {
    expect(ruleProblem(rule, ['cpu_load'], 2 * DAY)?.field).toBe('metric');
    expect(ruleProblem(rule, ['cpu_temperature'], 5 * MIN)?.field).toBe('for');
    expect(ruleProblem(rule, ['cpu_temperature'], 2 * DAY)).toBeUndefined();
  });
});

describe('ruleToEntry', () => {
  it('writes a rule back in the rules-file format, and parses back to the same rule', () => {
    for (const rule of builtinRules(4)) {
      const entry = ruleToEntry(rule);
      expect(parseRuleEntry(entry, 'rule', 'file').rule).toEqual({ ...rule, source: 'file' });
    }
    expect(durationText(0)).toBe('0s');
    expect(durationText(10 * MIN)).toBe('10min');
    expect(durationText(2 * DAY)).toBe('2d');
  });
});
```

Also add `'swap_io'` to the `metrics` id list at the top of the file (Task 5 moves `swap_heavy` onto it; adding it now is harmless).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run packages/alerts/test/rules.test.ts`
Expected: FAIL — `parseRuleEntry` is not exported.

- [ ] **Step 3: Implement**

In `packages/alerts/src/rules.ts`:

1. `Rule.source` becomes `'built-in' | 'file' | 'saved'` (update its doc comment: "built-in, from the rules file, or saved from the browser").
2. Replace the error class:

```ts
/**
 * A problem with the rules; its message is one line meant for the operator.
 * `field` names the rules-file field at fault and `detail` is the problem
 * alone, so the editor can show it under that field.
 */
export class AlertRulesError extends Error {
  constructor(
    message: string,
    readonly field?: string,
    readonly detail?: string
  ) {
    super(message);
  }
}
```

3. Replace the `Entry` type and `parseEntry` with an exported `parseRuleEntry`. The body is the current `parseEntry` with these changes (keep every existing message text exactly, the file tests assert them):

```ts
/** A parsed file or saved entry; `rule` is absent for a bare `{ id, disabled: true }`. */
export interface Entry {
  id: string;
  disabled: boolean;
  rule?: Rule;
}

export function parseRuleEntry(raw: unknown, where: string, source: 'file' | 'saved'): Entry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AlertRulesError(`${where} must be an object`, 'rule', 'must be an object');
  }
  const r = raw as Record<string, unknown>;
  const label = typeof r['id'] === 'string' ? ` ("${r['id']}")` : '';
  const fail: (problem: string, field: string) => never = (problem, field) => {
    throw new AlertRulesError(`${where}${label}: ${problem}`, field, problem);
  };
  for (const key of Object.keys(r)) if (!FIELDS.has(key)) fail(`unknown field "${key}"`, key);

  const id = r['id'];
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(id))
    fail('id must be lowercase snake_case', 'id');
  const ruleId = id as string;
  if (r['disabled'] !== undefined && typeof r['disabled'] !== 'boolean')
    fail('disabled must be true or false', 'disabled');
  const disabled = r['disabled'] === true;
  const bare = Object.keys(r).every((key) => key === 'id' || key === 'disabled');
  // The file has always ignored a disabled entry's other fields; the saved
  // layer keeps them, so an added rule can be switched off and on again.
  if (disabled && (bare || source === 'file')) return { id: ruleId, disabled: true };
```

…then the rest of the existing body with every `fail(msg)` given its field: the duration helper passes `field`; `needs exactly one of …` → `'condition'`; `metric must be a plugin id` and `metric "*" is only allowed with noReadingFor` → `'metric'`; severity → `'severity'`; message → `'message'`; `for is not allowed with noReadingFor` → `'for'`; `clearAfter is not allowed …` → `'clearAfter'`; `bitsSet must be …` → `'bitsSet'`; `${condition} must be a number` → `condition`. `rule.source` is `source`. It ends with `return { id: ruleId, disabled, rule };`.

4. `parseFile` calls `parseRuleEntry(raw, `${name} rules[${i}]`, 'file')`.

5. Extract the per-rule checks from `resolveRules`:

```ts
/** Why `rule` can't run on this host: an unknown metric, or a look-back beyond raw readings. */
export function ruleProblem(
  rule: Rule,
  known: string[],
  rawRetentionMs: number
): { field: string; message: string } | undefined {
  if (rule.metric !== '*' && !known.includes(rule.metric)) {
    return {
      field: 'metric',
      message: `unknown metric "${rule.metric}" (known: ${known.join(', ')})`
    };
  }
  for (const [field, ms] of [
    ['for', rule.forMs],
    ['clearAfter', rule.clearAfterMs]
  ] as const) {
    if (ms > rawRetentionMs) {
      return {
        field,
        message: `${field} is longer than raw retention (PIPULSE_RETENTION_RAW); alerts only read raw readings`
      };
    }
  }
  return undefined;
}
```

and in `resolveRules` the merge loop becomes `if (entry.disabled) { …existing… } else rules.set(entry.id, entry.rule!);` and the validation loop becomes:

```ts
const known = options.metrics.map((metric) => metric.id);
for (const rule of rules.values()) {
  const problem = ruleProblem(rule, known, options.rawRetentionMs);
  if (problem) {
    throw new AlertRulesError(
      `alert rule "${rule.id}": ${problem.message}`,
      problem.field,
      problem.message
    );
  }
}
```

6. Add the duration and entry helpers (move `durationText` here from `packages/api/src/settings-routes.ts`; Task 6 deletes the copy there):

```ts
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "15min", "2h", "1d": the largest whole unit, as the rules file writes durations. */
export function durationText(ms: number): string {
  if (ms === 0) return '0s';
  if (ms % DAY === 0) return `${ms / DAY}d`;
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms % MIN === 0) return `${ms / MIN}min`;
  return `${Math.ceil(ms / 1000)}s`;
}

/** A resolved rule written back in the rules-file format, e.g. to fill the editor's form. */
export function ruleToEntry(rule: Rule): Record<string, unknown> {
  const entry: Record<string, unknown> = { id: rule.id, metric: rule.metric };
  if (rule.atLeast !== undefined) entry['atLeast'] = rule.atLeast;
  if (rule.atMost !== undefined) entry['atMost'] = rule.atMost;
  if (rule.bitsSet !== undefined) entry['bitsSet'] = rule.bitsSet;
  if (rule.noReadingFor !== undefined) {
    entry['noReadingFor'] = rule.noReadingFor === 'auto' ? 'auto' : durationText(rule.noReadingFor);
  } else {
    entry['for'] = durationText(rule.forMs);
    entry['clearAfter'] = durationText(rule.clearAfterMs);
  }
  entry['severity'] = rule.severity;
  entry['message'] = rule.message;
  return entry;
}
```

(`MIN` already exists at the top of the file; put `HOUR`/`DAY` next to it.)

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run packages/alerts`
Expected: PASS, including every existing file-rule test (messages unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/alerts
git commit -m "Name the field at fault in alert rule errors and parse saved entries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The rule source (saved layer over file over built-ins)

**Files:**

- Create: `packages/alerts/src/source.ts`
- Modify: `packages/alerts/src/index.ts` (add `export * from './source.js';`)
- Test: `packages/alerts/test/source.test.ts`

**Interfaces:**

- Consumes: `parseRuleEntry`, `resolveRules`, `ruleProblem`, `ruleToEntry`, `AlertRulesError`, `Entry`, `Rule`, `MetricInfo`, `RulesFile` (Task 2); `getSettings`, `saveSettings` from `@pipulse/storage`.
- Produces:

```ts
export const SAVED_RULES_KEY = 'alerts.rules';
export const MAX_SAVED_RULES = 200;
export type RuleKind = 'built-in' | 'file' | 'edited' | 'added';
export interface RuleEntry {
  id: string;
  kind: RuleKind;
  disabled: boolean;
  rule: Rule | null; // what runs (or would, if enabled); null for an orphaned disable
  written: Record<string, unknown> | null; // rules-file format, for the form
  overrides: Rule | null; // the file/built-in rule a saved entry replaces or disables
  problem: string | null; // why a saved entry is not in force
  saved: boolean; // a saved entry exists for this id
}
export interface RuleSet {
  rules: Rule[];
  entries: RuleEntry[];
}
export type SaveResult = { ok: true } | { ok: false; errors: Record<string, string> };
export interface RuleSource {
  read(): RuleSet;
  save(raw: unknown, now?: number): SaveResult;
  remove(id: string, now?: number): boolean;
}
export function createRuleSource(
  db: PiPulseDb,
  options: {
    cores: number;
    metrics: MetricInfo[];
    file?: RulesFile;
    rawRetention: () => { ms: number; text: string };
    onProblem?: (message: string) => void;
  }
): RuleSource;
```

- [ ] **Step 1: Write the failing tests**

Create `packages/alerts/test/source.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSettings, openDb, saveSettings, type PiPulseDb } from '@pipulse/storage';
import {
  AlertRulesError,
  createRuleSource,
  MAX_SAVED_RULES,
  SAVED_RULES_KEY
} from '../src/index.js';

const MIN = 60_000;
const DAY = 86_400_000;
const metrics = [
  'cpu_load',
  'load_1',
  'cpu_temperature',
  'throttled',
  'swap_used',
  'swap_io',
  'disk_used',
  'boot_used'
].map((id) => ({ id, intervalMs: 10_000 }));
const busy = {
  id: 'test_busy',
  metric: 'cpu_load',
  atLeast: 50,
  for: '1min',
  severity: 'warning',
  message: 'Busy'
};

let db: PiPulseDb;
let raw: { ms: number; text: string };
let problems: string[];
beforeEach(() => {
  db = openDb(':memory:');
  raw = { ms: 2 * DAY, text: '2d' };
  problems = [];
});
afterEach(() => db.close());

const source = (file?: object) =>
  createRuleSource(db, {
    cores: 4,
    metrics,
    rawRetention: () => raw,
    onProblem: (message) => problems.push(message),
    ...(file ? { file: { name: 'alerts.json', text: JSON.stringify(file) } } : {})
  });
const ids = (rules: { id: string }[]) => rules.map((rule) => rule.id);

describe('createRuleSource', () => {
  it('lists built-ins and file rules with their kind when nothing is saved', () => {
    const { rules, entries } = source({ rules: [{ ...busy, id: 'from_file' }] }).read();
    expect(ids(rules)).toContain('cpu_busy');
    expect(entries.find((e) => e.id === 'cpu_busy')).toMatchObject({
      kind: 'built-in',
      saved: false,
      disabled: false,
      problem: null,
      written: { id: 'cpu_busy', atLeast: 90, for: '15min' }
    });
    expect(entries.find((e) => e.id === 'from_file')).toMatchObject({ kind: 'file' });
  });

  it('adds, edits, disables and reverts through save and remove, read live', () => {
    const s = source();
    expect(s.save(busy)).toEqual({ ok: true });
    expect(s.save({ ...busy, id: 'cpu_hot', atLeast: 75, severity: 'critical' })).toEqual({
      ok: true
    });
    expect(s.save({ id: 'cpu_busy', disabled: true })).toEqual({ ok: true });

    const { rules, entries } = s.read();
    expect(ids(rules)).toContain('test_busy');
    expect(ids(rules)).not.toContain('cpu_busy');
    expect(rules.find((r) => r.id === 'cpu_hot')).toMatchObject({ atLeast: 75, source: 'saved' });
    expect(entries.find((e) => e.id === 'test_busy')).toMatchObject({ kind: 'added', saved: true });
    expect(entries.find((e) => e.id === 'cpu_hot')).toMatchObject({
      kind: 'edited',
      overrides: { atLeast: 80, source: 'built-in' }
    });
    expect(entries.find((e) => e.id === 'cpu_busy')).toMatchObject({
      kind: 'built-in',
      disabled: true,
      saved: true,
      written: { id: 'cpu_busy', atLeast: 90 }
    });

    expect(s.remove('cpu_hot')).toBe(true);
    expect(s.remove('cpu_busy')).toBe(true);
    expect(s.remove('cpu_busy')).toBe(false);
    const after = s.read();
    expect(after.rules.find((r) => r.id === 'cpu_hot')).toMatchObject({ atLeast: 80 });
    expect(ids(after.rules)).toContain('cpu_busy');
  });

  it('keeps an added rule that is switched off, and replaces an entry in place', () => {
    const s = source();
    s.save(busy);
    s.save({ ...busy, disabled: true });
    expect(ids(s.read().rules)).not.toContain('test_busy');
    expect(s.read().entries.find((e) => e.id === 'test_busy')).toMatchObject({
      kind: 'added',
      disabled: true,
      rule: { atLeast: 50 }
    });
    expect(getSettings(db)[SAVED_RULES_KEY]).toHaveLength(1);
  });

  it('answers field errors instead of saving an invalid entry', () => {
    const s = source();
    expect(s.save({ ...busy, severity: 'loud' })).toEqual({
      ok: false,
      errors: { severity: 'severity must be warning or critical' }
    });
    expect(s.save({ ...busy, metric: 'nope' })).toMatchObject({
      ok: false,
      errors: { metric: expect.stringContaining('unknown metric') }
    });
    expect(s.save({ ...busy, for: '3d' })).toEqual({
      ok: false,
      errors: { for: 'longer than raw retention (2d); raise it on the Settings page first' }
    });
    expect(s.save({ id: 'not_a_rule', disabled: true })).toMatchObject({
      ok: false,
      errors: { id: expect.any(String) }
    });
    expect(getSettings(db)[SAVED_RULES_KEY]).toBeUndefined();
  });

  it('refuses more than the saved-rule cap', () => {
    const s = source();
    saveSettings(db, {
      [SAVED_RULES_KEY]: Array.from({ length: MAX_SAVED_RULES }, (_, i) => ({
        ...busy,
        id: `r${i}`
      }))
    });
    expect(s.save({ ...busy, id: 'one_more' })).toMatchObject({
      ok: false,
      errors: { id: expect.any(String) }
    });
    expect(s.save({ ...busy, id: 'r0', atLeast: 60 })).toEqual({ ok: true });
  });

  it('skips a saved entry that became invalid, keeps the rule below, and reports it once', () => {
    const s = source();
    s.save({ ...busy, id: 'cpu_hot', for: '1d' });
    raw = { ms: 12 * 60 * MIN, text: '12h' };
    const first = s.read();
    s.read();
    expect(first.rules.find((r) => r.id === 'cpu_hot')).toMatchObject({ source: 'built-in' });
    expect(first.entries.find((e) => e.id === 'cpu_hot')).toMatchObject({
      kind: 'edited',
      problem: 'longer than raw retention (12h); raise it on the Settings page first',
      written: { for: '1d' }
    });
    expect(problems).toEqual([
      'saved alert rule "cpu_hot" is not in force: longer than raw retention (12h); raise it on the Settings page first'
    ]);
  });

  it('shows a corrupt saved row as a problem instead of throwing', () => {
    saveSettings(db, { [SAVED_RULES_KEY]: [{ id: 'weird', metric: 5 }, 'nonsense'] });
    const { entries } = source().read();
    expect(entries.find((e) => e.id === 'weird')).toMatchObject({
      kind: 'added',
      problem: expect.any(String),
      rule: null
    });
  });

  it('still refuses a bad rules file at creation', () => {
    expect(() => source({ rules: [{ id: 'x' }] })).toThrow(AlertRulesError);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run packages/alerts/test/source.test.ts`
Expected: FAIL — `createRuleSource` is not exported.

- [ ] **Step 3: Implement `packages/alerts/src/source.ts`**

```ts
import { getSettings, saveSettings, type PiPulseDb } from '@pipulse/storage';
import {
  AlertRulesError,
  parseRuleEntry,
  resolveRules,
  ruleProblem,
  ruleToEntry,
  type Entry,
  type MetricInfo,
  type Rule,
  type RulesFile
} from './rules.js';

/** The settings key holding the rules saved from the browser. */
export const SAVED_RULES_KEY = 'alerts.rules';
/** Keeps the settings row small; nobody needs more rules on one Pi. */
export const MAX_SAVED_RULES = 200;

export type RuleKind = 'built-in' | 'file' | 'edited' | 'added';

/** One row of the rules editor. */
export interface RuleEntry {
  id: string;
  kind: RuleKind;
  disabled: boolean;
  /** What runs (or would, once enabled); null for a disable whose rule no longer exists. */
  rule: Rule | null;
  /** The rule in the rules-file format, for the editor's form. */
  written: Record<string, unknown> | null;
  /** The file or built-in rule a saved entry replaces or disables. */
  overrides: Rule | null;
  /** Why a saved entry is not in force. */
  problem: string | null;
  /** A saved entry exists for this id, so removing it reverts, enables or deletes. */
  saved: boolean;
}

export interface RuleSet {
  /** The rules in force: what the engine checks and /api/config serves. */
  rules: Rule[];
  entries: RuleEntry[];
}

export type SaveResult = { ok: true } | { ok: false; errors: Record<string, string> };

export interface RuleSource {
  read(): RuleSet;
  save(raw: unknown, now?: number): SaveResult;
  remove(id: string, now?: number): boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const idOf = (raw: unknown) => (isRecord(raw) && typeof raw['id'] === 'string' ? raw['id'] : '?');

function readSaved(db: PiPulseDb): unknown[] {
  const value = getSettings(db)[SAVED_RULES_KEY];
  return Array.isArray(value) ? value : [];
}

/**
 * The alert rules from three layers merged by id, later wins: built-ins,
 * PIPULSE_ALERTS_FILE, and entries saved from the browser. The file is read
 * and validated once here (a bad file throws, so startup stops); the saved
 * layer is read afresh on every read(), so a change is in force on the
 * engine's next check. A saved entry that can't run is skipped, never fatal:
 * it shows up with a `problem` and the rule below it, if any, stays in force.
 */
export function createRuleSource(
  db: PiPulseDb,
  options: {
    cores: number;
    metrics: MetricInfo[];
    file?: RulesFile;
    /** Raw retention in force, read on every use. */
    rawRetention: () => { ms: number; text: string };
    /** Told about each distinct problem with a saved entry, once. */
    onProblem?: (message: string) => void;
  }
): RuleSource {
  // Look-backs are checked per saved entry against the retention in force;
  // server.ts checks the file and built-ins against it at startup.
  const base = resolveRules({
    cores: options.cores,
    metrics: options.metrics,
    rawRetentionMs: Infinity,
    ...(options.file ? { file: options.file } : {})
  });
  const below = new Map(base.map((rule) => [rule.id, rule]));
  const known = options.metrics.map((metric) => metric.id);
  const reported = new Set<string>();

  /** Validates one saved entry against the rules below it and this host. */
  const check = (raw: unknown): Entry => {
    const entry = parseRuleEntry(raw, 'rule', 'saved');
    if (!entry.rule) {
      if (!below.has(entry.id)) {
        const problem = `no built-in or file rule "${entry.id}" to disable`;
        throw new AlertRulesError(problem, 'id', problem);
      }
      return entry;
    }
    const problem = ruleProblem(entry.rule, known, Infinity);
    if (problem) throw new AlertRulesError(problem.message, problem.field, problem.message);
    const retention = options.rawRetention();
    for (const [field, ms] of [
      ['for', entry.rule.forMs],
      ['clearAfter', entry.rule.clearAfterMs]
    ] as const) {
      if (ms > retention.ms) {
        const detail = `longer than raw retention (${retention.text}); raise it on the Settings page first`;
        throw new AlertRulesError(detail, field, detail);
      }
    }
    return entry;
  };

  const kindOf = (rule: Rule): RuleKind => (rule.source === 'file' ? 'file' : 'built-in');

  const read = (): RuleSet => {
    const saved = new Map<string, { raw: unknown; entry?: Entry; problem?: string }>();
    for (const raw of readSaved(db)) {
      const id = idOf(raw);
      try {
        saved.set(id, { raw, entry: check(raw) });
      } catch (error) {
        if (!(error instanceof AlertRulesError)) throw error;
        const problem = error.detail ?? error.message;
        saved.set(id, { raw, problem });
        const line = `saved alert rule "${id}" is not in force: ${problem}`;
        if (!reported.has(line)) {
          reported.add(line);
          options.onProblem?.(line);
        }
      }
    }

    const view = (
      id: string,
      s: { raw: unknown; entry?: Entry; problem?: string },
      under: Rule | null
    ): RuleEntry => {
      const rule = s.entry?.rule ?? null;
      const bareDisable = s.entry !== undefined && rule === null;
      return {
        id,
        kind: under ? (bareDisable ? kindOf(under) : 'edited') : 'added',
        disabled: s.entry?.disabled ?? false,
        rule: rule ?? under,
        written: bareDisable && under ? ruleToEntry(under) : isRecord(s.raw) ? s.raw : null,
        overrides: under,
        problem: s.problem ?? null,
        saved: true
      };
    };

    const rules: Rule[] = [];
    const entries: RuleEntry[] = [];
    for (const rule of base) {
      const s = saved.get(rule.id);
      if (!s) {
        rules.push(rule);
        entries.push({
          id: rule.id,
          kind: kindOf(rule),
          disabled: false,
          rule,
          written: ruleToEntry(rule),
          overrides: null,
          problem: null,
          saved: false
        });
        continue;
      }
      entries.push(view(rule.id, s, rule));
      if (!s.entry) rules.push(rule);
      else if (!s.entry.disabled && s.entry.rule) rules.push(s.entry.rule);
    }
    for (const [id, s] of saved) {
      if (below.has(id)) continue;
      entries.push(view(id, s, null));
      if (s.entry && !s.entry.disabled && s.entry.rule) rules.push(s.entry.rule);
    }
    return { rules, entries };
  };

  return {
    read,
    save(raw, now = Date.now()) {
      let entry: Entry;
      try {
        entry = check(raw);
      } catch (error) {
        if (!(error instanceof AlertRulesError)) throw error;
        return { ok: false, errors: { [error.field ?? 'rule']: error.detail ?? error.message } };
      }
      const list = readSaved(db);
      const at = list.findIndex((item) => idOf(item) === entry.id);
      if (at >= 0) list[at] = raw;
      else if (list.length >= MAX_SAVED_RULES) {
        return { ok: false, errors: { id: `at most ${MAX_SAVED_RULES} rules can be saved` } };
      } else list.push(raw);
      saveSettings(db, { [SAVED_RULES_KEY]: list }, now);
      return { ok: true };
    },
    remove(id, now = Date.now()) {
      const list = readSaved(db);
      const rest = list.filter((item) => idOf(item) !== id);
      if (rest.length === list.length) return false;
      saveSettings(db, { [SAVED_RULES_KEY]: rest.length > 0 ? rest : undefined }, now);
      return true;
    }
  };
}
```

The saved `'nonsense'` string in the corrupt-row test gets id `'?'` and becomes an `added` entry with a problem; that's fine (Delete can't target it, but it harms nothing and the next save of any rule rewrites the list without dropping it — acceptable for a hand-corrupted row).

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run packages/alerts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/alerts
git commit -m "Merge alert rules saved from the browser over the file and built-ins

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Engine follows rule changes

**Files:**

- Modify: `packages/alerts/src/engine.ts`
- Test: `packages/alerts/test/engine.test.ts`

**Interfaces:**

- Consumes: `raiseAlert` with `ruleHash`, `clearAlert(…, 'rule_changed')`, `acknowledgeAlert` (Task 1).
- Produces: `startAlerts(db, { rules: Rule[] | (() => Rule[]), … })`; `ruleHash(rule: Rule): string` exported.

- [ ] **Step 1: Write the failing tests**

Append to `packages/alerts/test/engine.test.ts` (add `acknowledgeAlert` to the import):

```ts
describe('startAlerts with a rule source', () => {
  function startWith(rules: () => Rule[], onError?: (error: unknown) => void) {
    const engine = startAlerts(db, {
      rules,
      metrics,
      intervalMs: 1e9,
      now: () => now,
      onChange: (event) => events.push(event),
      ...(onError ? { onError } : {})
    });
    engines.push(engine);
    return engine;
  }

  it('closes a changed rule as rule_changed and re-raises under the new rule at once', () => {
    readings('cpu_temperature', T0 - 3 * MIN, T0, 85);
    let rules: Rule[] = [hot];
    const engine = startWith(() => rules);
    const first = openAlerts(db)[0]!;
    acknowledgeAlert(db, first.id, T0);

    rules = [{ ...hot, severity: 'warning', message: 'Warm now' }];
    engine.check();

    expect(events.map((e) => [e.type, e.alert.clearedBy, e.alert.severity])).toEqual([
      ['raised', null, 'critical'],
      ['cleared', 'rule_changed', 'critical'],
      ['raised', null, 'warning']
    ]);
    expect(openAlerts(db)).toMatchObject([{ message: 'Warm now', acknowledgedAt: null }]);
  });

  it('closes every alert of a removed * rule as rule_removed on the next check', () => {
    readings('cpu_temperature', T0 - 30 * MIN, T0 - 20 * MIN, 50);
    readings('disk_used', T0 - 30 * MIN, T0 - 20 * MIN, 50, 60_000);
    let rules: Rule[] = [silent];
    const engine = startWith(() => rules);
    now = T0 + 10 * MIN;
    engine.check();
    expect(openAlerts(db)).toHaveLength(2);

    rules = [];
    engine.check();
    expect(openAlerts(db)).toEqual([]);
    expect(events.filter((e) => e.type === 'cleared').map((e) => e.alert.clearedBy)).toEqual([
      'rule_removed',
      'rule_removed'
    ]);
  });

  it('leaves alerts raised before rule fingerprints alone', () => {
    readings('cpu_temperature', T0 - 3 * MIN, T0, 85);
    const old = raiseAlert(db, {
      ruleId: 'cpu_hot',
      metric: 'cpu_temperature',
      severity: 'critical',
      message: 'CPU running hot',
      value: 85,
      raisedAt: T0 - MIN
    });
    startWith(() => [hot]);
    expect(openAlerts(db).map((a) => a.id)).toEqual([old.id]);
    expect(events).toEqual([]);
  });

  it('reports a rule source that throws and still runs the next check', () => {
    readings('cpu_temperature', T0 - 3 * MIN, T0, 85);
    let broken = true;
    const errors: unknown[] = [];
    const engine = startWith(
      () => {
        if (broken) throw new Error('settings unreadable');
        return [hot];
      },
      (error) => errors.push(error)
    );
    expect(errors).toHaveLength(1);
    broken = false;
    engine.check();
    expect(openAlerts(db)).toHaveLength(1);
  });
});
```

(The silence test relies on the existing `not_collecting` behaviour: silence counts from the later of the newest reading and engine start, so advancing `now` by 10 min past start raises for both metrics. If the existing `silent` tests in this file use a different pattern to raise, copy that pattern.)

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run packages/alerts/test/engine.test.ts`
Expected: FAIL — type error / `rules is not iterable`.

- [ ] **Step 3: Implement**

In `packages/alerts/src/engine.ts`:

```ts
import { createHash } from 'node:crypto';
```

```ts
/**
 * A fingerprint of everything that decides when a rule raises and what its
 * alert says. An open alert whose rule no longer matches it was raised under
 * an older version of the rule (edited in the browser) and is closed.
 */
export function ruleHash(rule: Rule): string {
  const fields = [
    rule.id,
    rule.metric,
    rule.atLeast ?? null,
    rule.atMost ?? null,
    rule.bitsSet ?? null,
    rule.noReadingFor ?? null,
    rule.forMs,
    rule.clearAfterMs,
    rule.severity,
    rule.message
  ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 16);
}
```

Change the options type to `rules: Rule[] | (() => Rule[]);`, update the doc comment ("Rules may be a function, read on every check, so rules saved from the browser apply without a restart. Each check closes alerts whose rule or metric is no longer watched (`rule_removed`) and alerts raised under an older version of their rule (`rule_changed`)…"), delete the startup-only `watched`/`openAlerts` loop, and make `check`:

```ts
const check = () => {
  try {
    const t = now();
    // The Pi has no RTC: NTP can move the clock hours at once after boot,
    // and a long pause looks the same. Count silence afresh from here.
    if (lastCheck !== undefined && (t < lastCheck || t - lastCheck > 3 * intervalMs)) since = t;
    lastCheck = t;
    const rules = typeof options.rules === 'function' ? options.rules() : options.rules;
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    const open = new Map<string, Alert>();
    for (const alert of openAlerts(db)) {
      const rule = byId.get(alert.ruleId);
      if (!rule || !targets(rule).some((metric) => metric.id === alert.metric)) {
        emit({ type: 'cleared', alert: clearAlert(db, alert.id, t, 'rule_removed') });
      } else if (alert.ruleHash !== null && alert.ruleHash !== ruleHash(rule)) {
        emit({ type: 'cleared', alert: clearAlert(db, alert.id, t, 'rule_changed') });
      } else {
        open.set(key(alert.ruleId, alert.metric), alert);
      }
    }
    for (const rule of rules) {
      // …the existing per-metric loop unchanged, except raiseAlert also gets
      // ruleHash: ruleHash(rule)
    }
  } catch (error) {
    options.onError?.(error);
  }
};
```

(`targets` stays as is; it already takes a rule. Import the `Alert` type from `./store.js` if not already imported.)

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run packages/alerts`
Expected: PASS, including the existing "closes a removed rule's alert at start" test.

- [ ] **Step 5: Commit**

```bash
git add packages/alerts
git commit -m "Let the alert engine follow rule changes between checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `swap_io` plugin and a rate-based `swap_heavy`

**Files:**

- Create: `packages/collector/src/swap-io.ts`
- Modify: `packages/collector/src/index.ts` (import, re-export, `builtinPlugins` after `swapUsedPlugin`)
- Modify: `packages/alerts/src/rules.ts` (`swap_heavy`)
- Modify: `packages/web/src/history.ts` (`historyOnly`)
- Test: `packages/collector/test/swap-io.test.ts`, `packages/collector/test/contract.test.ts` / `plugins.test.ts` (plugin order lists), `packages/alerts/test/rules.test.ts`, `packages/web/test/history.test.ts`

**Interfaces:**

- Produces: `swapPages(vmstat: string): number | null`, `createSwapIoPlugin(options?: { read?: () => Promise<string | null>; now?: () => number }): CollectorPlugin`, `swapIoPlugin` (id `swap_io`, label `Swap traffic`, unit `pages/s`, `intervalMs` 10000).

- [ ] **Step 1: Write the failing plugin tests**

Create `packages/collector/test/swap-io.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSwapIoPlugin, swapPages } from '../src/index.js';

const vmstat = (pswpin: number, pswpout: number) =>
  `nr_free_pages 1234\npswpin ${pswpin}\npswpout ${pswpout}\npgfault 99\n`;

function plugin(texts: (string | null)[], times: number[]) {
  return createSwapIoPlugin({
    read: async () => texts.shift() ?? null,
    now: () => times.shift()!
  });
}

describe('swapPages', () => {
  it('adds pages swapped in and out since boot', () => {
    expect(swapPages(vmstat(100, 50))).toBe(150);
  });
  it('is null when a counter is missing', () => {
    expect(swapPages('pswpin 5\n')).toBeNull();
  });
});

describe('swap_io', () => {
  it('reports pages/s between two polls, null on the first', async () => {
    const p = plugin([vmstat(100, 0), vmstat(300, 300)], [0, 10_000]);
    expect(await p.collect()).toBeNull();
    expect(await p.collect()).toBe(50);
  });

  it('is null after a counter goes backwards, then measures from there', async () => {
    const p = plugin([vmstat(500, 0), vmstat(10, 0), vmstat(30, 0)], [0, 10_000, 20_000]);
    await p.collect();
    expect(await p.collect()).toBeNull();
    expect(await p.collect()).toBe(2);
  });

  it('is null where /proc/vmstat is missing', async () => {
    const p = plugin([null, null], [0, 10_000]);
    expect(await p.collect()).toBeNull();
    expect(await p.collect()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run packages/collector/test/swap-io.test.ts`
Expected: FAIL — `createSwapIoPlugin` is not exported.

- [ ] **Step 3: Implement `packages/collector/src/swap-io.ts`**

```ts
import { readFile } from 'node:fs/promises';
import type { CollectorPlugin } from './index.js';

/** Pages swapped in plus out since boot, from /proc/vmstat; null if either counter is missing. */
export function swapPages(vmstat: string): number | null {
  const counter = (name: string) => {
    const match = new RegExp(`^${name} (\\d+)$`, 'm').exec(vmstat);
    return match ? Number(match[1]) : undefined;
  };
  const pagesIn = counter('pswpin');
  const pagesOut = counter('pswpout');
  return pagesIn === undefined || pagesOut === undefined ? null : pagesIn + pagesOut;
}

/** /proc/vmstat, or null where there is none (not Linux). */
async function readVmstat(): Promise<string | null> {
  try {
    return await readFile('/proc/vmstat', 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Swap traffic in pages/s: how hard the system is swapping right now.
 * Unlike swap_used, it stays near zero when idle pages merely sit parked in
 * a small swap file, so it is what the swap_heavy alert watches.
 */
export function createSwapIoPlugin(
  options: { read?: () => Promise<string | null>; now?: () => number } = {}
): CollectorPlugin {
  const read = options.read ?? readVmstat;
  // Monotonic, so an NTP jump can't produce a negative or huge rate.
  const now = options.now ?? (() => performance.now());
  let previous: { pages: number; at: number } | undefined;
  return {
    id: 'swap_io',
    label: 'Swap traffic',
    unit: 'pages/s',
    intervalMs: 10000,
    apiVersion: 1,
    async collect() {
      const text = await read();
      const pages = text === null ? null : swapPages(text);
      const at = now();
      const before = previous;
      previous = pages === null ? undefined : { pages, at };
      if (pages === null || !before || pages < before.pages || at <= before.at) return null;
      return Math.round(((pages - before.pages) / ((at - before.at) / 1000)) * 100) / 100;
    }
  };
}

export const swapIoPlugin = createSwapIoPlugin();
```

In `packages/collector/src/index.ts`: `import { swapIoPlugin } from './swap-io.js';` next to the vcgencmd import, `export { createSwapIoPlugin, swapIoPlugin, swapPages } from './swap-io.js';`, and insert `swapIoPlugin,` right after `swapUsedPlugin,` in `builtinPlugins`. Update the expected id lists in `contract.test.ts` (`describe('builtinPlugins'…)`) and `plugins.test.ts` line ~128 if they list every id.

- [ ] **Step 4: Move `swap_heavy` onto `swap_io`**

In `builtinRules` in `packages/alerts/src/rules.ts`:

```ts
    rule({
      id: 'swap_heavy',
      // Pages moving to and from swap, not how full it is: a small swap file
      // holding idle pages sits "full" for weeks without any pressure.
      // 250 pages/s is about 1 MB/s with 4 KiB pages.
      metric: 'swap_io',
      atLeast: 250,
      forMs: 10 * MIN,
      severity: 'warning',
      message: 'Swapping heavily'
    }),
```

Add to the `ships the agreed defaults` test in `rules.test.ts`:

```ts
expect(byId.get('swap_heavy')).toMatchObject({ metric: 'swap_io', atLeast: 250, forMs: 10 * MIN });
expect(byId.get('swap_full')).toMatchObject({ metric: 'swap_used', atLeast: 95 });
```

- [ ] **Step 5: Keep `swap_io` off the Now page**

In `packages/web/src/history.ts`: `export const historyOnly: ReadonlySet<string> = new Set(['load_1', 'swap_io']);` and extend its comment ("…and swap traffic explains a swap-use chart rather than being a reading to watch"). Add to `packages/web/test/history.test.ts`:

```ts
it('keeps swap traffic off the Now page', () => {
  expect(historyOnly.has('swap_io')).toBe(true);
});
```

(Import `historyOnly` if the test file doesn't yet.) Because `builtinPlugins` lists `swap_io` right after `swap_used`, History draws its chart right below swap use with no further change.

- [ ] **Step 6: Run everything touched**

Run: `npm test`
Expected: PASS. If an API or web test builds rules against a metrics list without `swap_io` and now fails with `unknown metric "swap_io"`, add `swap_io` to that list.

- [ ] **Step 7: Commit**

```bash
git add packages/collector packages/alerts packages/web
git commit -m "Watch swap traffic, not swap fullness, for swap_heavy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Rule and acknowledge endpoints, live notices

**Files:**

- Create: `packages/api/src/alert-routes.ts`
- Modify: `packages/api/src/index.ts`, `packages/api/src/settings-routes.ts`
- Test: `packages/api/test/alert-routes.test.ts`, `packages/api/test/settings-routes.test.ts`

**Interfaces:**

- Consumes: `RuleSource`, `RuleEntry`, `acknowledgeAlert`, `durationText`, `Alert`, `Rule` from `@pipulse/alerts`.
- Produces: `interface AlertRulesOptions { source: RuleSource; recheck?: () => void }`; `ServerOptions.alertRules?: AlertRulesOptions`; `SettingsOptions.rawAtLeast?: () => LookBack | undefined`; WebSocket messages `{ type: 'rules', rules: Rule[] }` and `{ type: 'alert', event: 'acknowledged', alert: Alert }`.
- Endpoints: `GET /api/alerts/rules` → `{ rules: RuleEntry[] }`; `PUT /api/alerts/rules/:id` → `200 { rules }` | `400 { errors }` | `413`; `DELETE /api/alerts/rules/:id` → `200 { rules }` | `404`; `POST /api/alerts/:id/acknowledge` → `200 Alert` | `404` | `409`.

- [ ] **Step 1: Write the failing tests**

Create `packages/api/test/alert-routes.test.ts`:

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { clearAlert, createRuleSource, raiseAlert, type RuleSource } from '@pipulse/alerts';
import { hashPassword, parsePasswordHash, type PasswordHash } from '../src/auth.js';
import { buildServer, createLiveFeed } from '../src/index.js';

const DAY = 86_400_000;
const metrics = [
  'cpu_load',
  'load_1',
  'cpu_temperature',
  'throttled',
  'swap_used',
  'swap_io',
  'disk_used',
  'boot_used'
].map((id) => ({ id, intervalMs: 10_000 }));
const busy = { metric: 'cpu_load', atLeast: 50, for: '1min', severity: 'warning', message: 'Busy' };

let passwordHash: PasswordHash;
beforeAll(async () => {
  passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
});

let db: PiPulseDb;
let source: RuleSource;
let recheck: ReturnType<typeof vi.fn>;
let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  db = openDb(':memory:');
  source = createRuleSource(db, {
    cores: 4,
    metrics,
    rawRetention: () => ({ ms: 2 * DAY, text: '2d' })
  });
  recheck = vi.fn();
  app = buildServer(db, {
    live: createLiveFeed(),
    auth: { passwordHash, failureDelayMs: 0 },
    alertRules: { source, recheck }
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'secret' }
  });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  db.close();
});

const put = (id: string, payload: object, headers: Record<string, string> = { cookie }) =>
  app.inject({ method: 'PUT', url: `/api/alerts/rules/${id}`, headers, payload });
const del = (id: string) =>
  app.inject({ method: 'DELETE', url: `/api/alerts/rules/${id}`, headers: { cookie } });
const configRules = async () =>
  ((await app.inject({ method: 'GET', url: '/api/config' })).json().rules as { id: string }[]).map(
    (r) => r.id
  );

describe('rule routes', () => {
  it('lists every rule for the editor', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/alerts/rules' });
    expect(res.statusCode).toBe(200);
    expect(res.json().rules.find((e: { id: string }) => e.id === 'cpu_busy')).toMatchObject({
      kind: 'built-in',
      saved: false
    });
  });

  it('adds a rule, puts it in force at once, and rechecks', async () => {
    const res = await put('test_busy', busy);
    expect(res.statusCode).toBe(200);
    expect(res.json().rules.find((e: { id: string }) => e.id === 'test_busy')).toMatchObject({
      kind: 'added'
    });
    expect(await configRules()).toContain('test_busy');
    expect(recheck).toHaveBeenCalledOnce();
  });

  it('answers per-field errors, including unknown fields and a too-long look-back', async () => {
    expect((await put('x', { ...busy, severity: 'loud' })).json()).toEqual({
      errors: { severity: 'severity must be warning or critical' }
    });
    const unknown = await put('x', { ...busy, bogus: 1 });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ errors: { bogus: 'unknown field "bogus"' } });
    expect((await put('x', { ...busy, for: '3d' })).json().errors.for).toMatch(
      /raw retention \(2d\)/
    );
    expect((await put('x', { ...busy, id: 'y' })).json().errors.id).toBeDefined();
    expect((await put('Bad', busy)).statusCode).toBe(400);
    expect(recheck).not.toHaveBeenCalled();
  });

  it('refuses a body over 4 KB', async () => {
    const res = await put('x', { ...busy, message: 'a'.repeat(5000) });
    expect(res.statusCode).toBe(413);
  });

  it('disables a built-in and reverts it', async () => {
    expect((await put('cpu_busy', { disabled: true })).statusCode).toBe(200);
    expect(await configRules()).not.toContain('cpu_busy');
    expect((await del('cpu_busy')).statusCode).toBe(200);
    expect(await configRules()).toContain('cpu_busy');
    expect((await del('cpu_busy')).statusCode).toBe(404);
  });

  it('needs a session, and a password to be configured', async () => {
    expect((await put('test_busy', busy, {})).statusCode).toBe(401);
    const readOnly = buildServer(db, { alertRules: { source } });
    const res = await readOnly.inject({
      method: 'PUT',
      url: '/api/alerts/rules/test_busy',
      payload: busy
    });
    expect(res.statusCode).toBe(403);
    await readOnly.close();
  });
});

describe('POST /api/alerts/:id/acknowledge', () => {
  const raise = () =>
    raiseAlert(db, {
      ruleId: 'cpu_hot',
      metric: 'cpu_temperature',
      severity: 'critical',
      message: 'Hot',
      value: 85,
      raisedAt: 1000
    });
  const ack = (id: number | string, headers: Record<string, string> = { cookie }) =>
    app.inject({ method: 'POST', url: `/api/alerts/${id}/acknowledge`, headers });

  it('acknowledges an open alert once', async () => {
    const alert = raise();
    const first = await ack(alert.id);
    expect(first.statusCode).toBe(200);
    const at = first.json().acknowledgedAt;
    expect(at).toEqual(expect.any(Number));
    expect((await ack(alert.id)).json().acknowledgedAt).toBe(at);
  });

  it('answers 409 for a cleared alert, 404 for an unknown one, 401 without a session', async () => {
    const alert = raise();
    expect((await ack(alert.id, {})).statusCode).toBe(401);
    clearAlert(db, alert.id, 2000, 'condition');
    expect((await ack(alert.id)).statusCode).toBe(409);
    expect((await ack(999)).statusCode).toBe(404);
    expect((await ack('abc')).statusCode).toBe(400);
  });
});

describe('/api/live notices', () => {
  it('pushes the rules in force after a change and an acknowledgement', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
    const messages: { type: string; event?: string; rules?: { id: string }[] }[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await once(socket, 'open');

    await put('test_busy', busy);
    const alert = raiseAlert(db, {
      ruleId: 'cpu_hot',
      metric: 'cpu_temperature',
      severity: 'critical',
      message: 'Hot',
      value: 85,
      raisedAt: 1000
    });
    await app.inject({
      method: 'POST',
      url: `/api/alerts/${alert.id}/acknowledge`,
      headers: { cookie }
    });

    await vi.waitFor(() =>
      expect(messages.map((m) => m.type)).toEqual(['snapshot', 'rules', 'alert'])
    );
    expect(messages[1]!.rules!.map((r) => r.id)).toContain('test_busy');
    expect(messages[2]!.event).toBe('acknowledged');
    socket.close();
  });
});
```

In `packages/api/test/settings-routes.test.ts`, change the `start()` option to a function and add a test that the check is live:

```ts
let lookBack: LookBack | undefined;
// in start():
rawAtLeast: (() => lookBack,
  // in the file's beforeEach (or at the top of start()):
  (lookBack = longestLookBack(builtinRules(4))));
```

```ts
it('checks raw retention against the rules in force now, not at startup', async () => {
  await start();
  lookBack = { ms: 3 * DAY, ruleId: 'test_long', text: '3d' };
  const res = await put({ retention: { raw: '2d' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().errors.raw).toMatch(/test_long/);
});
```

(Import `type LookBack` from `@pipulse/storage`. If `validateRetention`'s raw error wording doesn't include the rule id, match whatever the existing "shorter than a rule's look-back" test in this file matches.)

- [ ] **Step 2: Run to see them fail**

Run: `npm run build && npx vitest run packages/api/test/alert-routes.test.ts packages/api/test/settings-routes.test.ts`
Expected: FAIL — `alertRules` is not a server option; `rawAtLeast` is not a function.

- [ ] **Step 3: Implement `packages/api/src/alert-routes.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { PiPulseDb } from '@pipulse/storage';
import { acknowledgeAlert, type Alert, type Rule, type RuleSource } from '@pipulse/alerts';

export interface AlertRulesOptions {
  /** The rule layers; saving and removing go through it. */
  source: RuleSource;
  /** Runs an alert check now, so a saved change shows without waiting up to 15 s. */
  recheck?: () => void;
}

/** Messages the API itself pushes to /api/live clients. */
export type Notice =
  { type: 'rules'; rules: Rule[] } | { type: 'alert'; event: 'acknowledged'; alert: Alert };

const RULE_ID = /^[a-z][a-z0-9_]*$/;
/** A rule is a few hundred bytes; this leaves room for a long message. */
const RULE_BODY_LIMIT = 4096;

/**
 * Rule editing and acknowledging. Auth is decided by the one hook in
 * auth-routes.ts (every PUT, DELETE and POST here needs a session). The body
 * schema is deliberately only { type: 'object' }: Fastify strips properties
 * a stricter schema doesn't list, and an unknown field must be an error the
 * operator sees, which parseRuleEntry reports with its name.
 */
export function registerAlertRoutes(
  app: FastifyInstance,
  db: PiPulseDb,
  options: { rules?: AlertRulesOptions; publish(notice: Notice): void; now?: () => number }
): void {
  const now = options.now ?? Date.now;

  app.post<{ Params: { id: number } }>(
    '/api/alerts/:id/acknowledge',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } }
        }
      }
    },
    async (request, reply) => {
      const result = acknowledgeAlert(db, request.params.id, now());
      if (result === 'not_found') return reply.status(404).send({ error: 'no such alert' });
      if (result === 'cleared') {
        return reply.status(409).send({ error: 'this alert has already cleared' });
      }
      options.publish({ type: 'alert', event: 'acknowledged', alert: result });
      return result;
    }
  );

  const rules = options.rules;
  if (!rules) return;

  const changed = () => {
    rules.recheck?.();
    const { rules: inForce, entries } = rules.source.read();
    options.publish({ type: 'rules', rules: inForce });
    return { rules: entries };
  };

  app.get('/api/alerts/rules', async () => ({ rules: rules.source.read().entries }));

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/alerts/rules/:id',
    { bodyLimit: RULE_BODY_LIMIT, schema: { body: { type: 'object' } } },
    async (request, reply) => {
      const { id } = request.params;
      if (!RULE_ID.test(id)) {
        return reply.status(400).send({ errors: { id: 'id must be lowercase snake_case' } });
      }
      if (request.body['id'] !== undefined && request.body['id'] !== id) {
        return reply.status(400).send({ errors: { id: 'id must match the rule being saved' } });
      }
      const result = rules.source.save({ ...request.body, id }, now());
      if (!result.ok) return reply.status(400).send({ errors: result.errors });
      return changed();
    }
  );

  app.delete<{ Params: { id: string } }>('/api/alerts/rules/:id', async (request, reply) => {
    if (!rules.source.remove(request.params.id, now())) {
      return reply.status(404).send({ error: 'nothing is saved for this rule' });
    }
    return changed();
  });
}
```

Note `{ ...request.body, id }` puts `id` last; with the mismatch check above, it only fills in a missing `id`.

- [ ] **Step 4: Wire it into `buildServer`**

In `packages/api/src/index.ts`:

```ts
import { registerAlertRoutes, type AlertRulesOptions, type Notice } from './alert-routes.js';
export type { AlertRulesOptions } from './alert-routes.js';
```

`ServerOptions` gains:

```ts
  /** Rule editing and the live rule set; when set, /api/config serves its rules in force. */
  alertRules?: AlertRulesOptions;
```

In `buildServer`, after `registerAuth`: `const notices = createFeed<Notice>();`. `/api/config` answers `rules: options.alertRules ? options.alertRules.source.read().rules : (options.rules ?? [])`. After the `/api/alerts` route: `registerAlertRoutes(app, db, { ...(options.alertRules ? { rules: options.alertRules } : {}), publish: notices.publish });`. In the WebSocket handler, next to `unsubscribeAlerts`: `const unsubscribeNotices = notices.subscribe(send);` and call it in the `close` handler.

- [ ] **Step 5: Make the retention check live**

In `packages/api/src/settings-routes.ts`: delete the local `MIN`/`HOUR`/`DAY` (if unused after) and `durationText`, import `durationText` from `@pipulse/alerts`; `SettingsOptions.rawAtLeast?: () => LookBack | undefined;` with the doc comment "Raw retention may not be shorter than the longest look-back of the alert rules in force, read on every check (rules can change in the browser)."; and in `check`: `validateRetention(proposal, options.getRetention(), options.rawAtLeast?.())`.

- [ ] **Step 6: Run to see them pass**

Run: `npm run build && npx vitest run packages/api`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api
git commit -m "Add rule editing and acknowledging endpoints with live notices

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Server wiring

**Files:**

- Modify: `packages/api/src/server.ts`
- Test: `packages/api/test/server.test.ts` (existing startup tests must still pass)

**Interfaces:**

- Consumes: `createRuleSource` (Task 3), `startAlerts` with a rules function (Task 4), `alertRules` and `rawAtLeast` function (Task 6).

- [ ] **Step 1: Replace `readRules()` with a rule source**

In `packages/api/src/server.ts`, replace `readRules`/`RULES` with:

```ts
/**
 * Alert rules: built-ins, PIPULSE_ALERTS_FILE over them, and rules saved
 * from the browser over both, re-read on every check. A bad file stops
 * startup with one line; a bad saved rule is logged and skipped.
 */
function readRuleSource(): RuleSource {
  const path = process.env['PIPULSE_ALERTS_FILE'];
  try {
    return createRuleSource(db, {
      cores: cpus().length,
      metrics: METRICS,
      rawRetention: () => {
        const raw = getRetention().raw;
        return { ms: raw.ms, text: raw.text };
      },
      onProblem: (message) => console.warn(`[pipulse] ${message}`),
      ...(path ? { file: readRulesFile(path) } : {})
    });
  } catch (error) {
    fail(error);
  }
}
const RULES = readRuleSource();
// The file and built-ins must fit the raw retention in force; saved rules
// that don't are skipped instead (see createRuleSource).
const BASE_LOOK_BACK = longestLookBack(
  RULES.read().entries.flatMap((entry) =>
    entry.saved ? (entry.overrides ?? []) : (entry.rule ?? [])
  )
);
const RAW_PROBLEM = rawRetentionProblem(RETENTION.raw, BASE_LOOK_BACK);
if (RAW_PROBLEM) fail(RAW_PROBLEM);
const rulesInForce = () => RULES.read().rules;
```

(`BASE_LOOK_BACK` takes each entry's file/built-in rule: for a saved entry that is `overrides` — null for added rules, which are skipped — and for the rest the rule itself.)

Update imports: drop `resolveRules`, `type Rule` if now unused; add `createRuleSource`, `type RuleSource`.

- [ ] **Step 2: Wire the engine, routes and settings to it**

The alert engine must exist before `buildServer` so `recheck` can reach it, but it must not start checking before the scheduler is up either — so hand the API a function that calls the engine once it exists:

```ts
let alerts: { check(): void; stop(): void } | undefined;
```

`buildServer` options: remove `rules: RULES,`; add `alertRules: { source: RULES, recheck: () => alerts?.check() },`; `settings: { getRetention, metrics: METRICS, rawAtLeast: () => longestLookBack(rulesInForce()) }`.

Where the engine starts: `alerts = startAlerts(db, { rules: rulesInForce, metrics: METRICS, … })` (rest unchanged). In `shutdown()`: `alerts?.stop();`.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Smoke-test locally**

Run in one terminal: `PIPULSE_DB_PATH=/tmp/pp-5b2.db PIPULSE_PORT=8899 node packages/api/dist/server.js`
Then: `curl -s localhost:8899/api/alerts/rules | head -c 300` → JSON with `"rules":[{"id":"cpu_warm","kind":"built-in"…`; `curl -s -X PUT localhost:8899/api/alerts/rules/x -H 'content-type: application/json' -d '{}'` → `403` (no password configured). Stop the server and `rm /tmp/pp-5b2.db*`.

- [ ] **Step 5: Commit**

```bash
git add packages/api
git commit -m "Run the server's alert rules from the live rule source

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Dashboard follows rules live; acknowledged alerts go quiet

**Files:**

- Modify: `packages/web/src/types.ts`, `packages/web/src/alerts.ts`, `packages/web/src/api.ts`, `packages/web/src/app.tsx`, `packages/web/src/tile.tsx`, `packages/web/src/styles.css`
- Test: `packages/web/test/alerts.test.ts`, `packages/web/test/app.test.tsx`, `packages/web/test/tile.test.tsx`

**Interfaces:**

- Produces (types.ts): `Rule.source: 'built-in' | 'file' | 'saved'`; `Alert.clearedBy` adds `'rule_changed'`; `Alert.acknowledgedAt?: number | null` (optional: older servers); `RuleKind`, `RuleEntry` (same shape as Task 3's, with `Rule` the web type); `LiveMessage` adds `{ type: 'alert'; event: 'raised' | 'cleared' | 'acknowledged'; alert: Alert }` and `{ type: 'rules'; rules: Rule[] }`.
- Produces (alerts.ts): `applyAlertEvent(open, event: 'raised' | 'cleared' | 'acknowledged', alert)`, `unacknowledged(open: Alert[]): Alert[]`.
- Produces (api.ts): `sendJson(method: 'POST' | 'PUT' | 'DELETE', path, body?)`.

- [ ] **Step 1: Write the failing tests**

`packages/web/test/alerts.test.ts`:

```ts
describe('acknowledged alerts', () => {
  it('replaces an acknowledged alert in place and leaves it open', () => {
    const a = alert({ id: 1 });
    const b = alert({ id: 2 });
    const acked = { ...a, acknowledgedAt: 5 };
    expect(applyAlertEvent([a, b], 'acknowledged', acked)).toEqual([acked, b]);
  });

  it('counts only unacknowledged alerts as loud', () => {
    expect(
      unacknowledged([alert({ id: 1, acknowledgedAt: 5 }), alert({ id: 2 })]).map((a) => a.id)
    ).toEqual([2]);
  });
});
```

(Use the file's existing alert factory; add `unacknowledged` to the import.)

`packages/web/test/tile.test.tsx` — render a tile with `alert={{ …, acknowledgedAt: NOW - MIN }}` (copy the file's existing alert-line test) and assert:

```ts
const line = root.querySelector('.alert-line')!;
expect(line.getAttribute('data-acknowledged')).toBe('true');
expect(line.textContent).toContain('acknowledged');
```

`packages/web/test/app.test.tsx` — the file already drives a fake WebSocket; add, following its existing live-message tests:

```ts
it('recolours tiles on a rules message without reconnecting', async () => {
  // …render <App />, wait for Live as the existing tests do, then:
  const socketsBefore = sockets.length;
  push({ type: 'rules', rules: [{ ...hotRule, atLeast: 10 }] });
  await settle();
  expect(sockets.length).toBe(socketsBefore);
  // the CPU temperature tile (reading above 10) now shows the rule's severity
  expect(tile('CPU temperature').getAttribute('data-status')).toBe('critical');
});

it('leaves acknowledged alerts out of the nav badge', async () => {
  // …render, go Live, then:
  push({
    type: 'snapshot',
    samples: [],
    alerts: [alertOf({ id: 1, acknowledgedAt: 5 }), alertOf({ id: 2, severity: 'warning' })]
  });
  await settle();
  expect(badge().textContent).toContain('1');
  expect(badge().getAttribute('data-severity')).toBe('warning');
  push({
    type: 'alert',
    event: 'acknowledged',
    alert: alertOf({ id: 2, severity: 'warning', acknowledgedAt: 6 })
  });
  await settle();
  expect(root.querySelector('.badge')).toBeNull();
});
```

Adapt the names (`sockets`, `push`, `settle`, `tile`, `badge`, `hotRule`, `alertOf`) to the helpers `app.test.tsx` already has — read the file's existing "badge" and "tile colour" tests first and add these beside them, reusing their fixtures. The two properties that must be asserted are: the WebSocket constructor count doesn't change on a `rules` message, and the badge ignores alerts with `acknowledgedAt`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run packages/web`
Expected: FAIL.

- [ ] **Step 3: Implement**

`types.ts`: apply the type changes listed under Interfaces; `RuleEntry`:

```ts
export type RuleKind = 'built-in' | 'file' | 'edited' | 'added';

/** One row of the rules editor, from GET /api/alerts/rules (mirrors @pipulse/alerts). */
export interface RuleEntry {
  id: string;
  kind: RuleKind;
  disabled: boolean;
  rule: Rule | null;
  /** The rule in the rules-file format ("10min", 0xf as a number). */
  written: Record<string, unknown> | null;
  overrides: Rule | null;
  problem: string | null;
  saved: boolean;
}
```

`alerts.ts`:

```ts
/** Applies one live raise, clear or acknowledgement to the open alerts, newest first. */
export function applyAlertEvent(
  open: Alert[],
  event: 'raised' | 'cleared' | 'acknowledged',
  alert: Alert
): Alert[] {
  if (event === 'acknowledged') return open.map((a) => (a.id === alert.id ? alert : a));
  const rest = open.filter((a) => a.id !== alert.id);
  return event === 'raised' ? [alert, ...rest] : rest;
}

/** Open alerts nobody has acknowledged yet: what the nav badge counts. */
export function unacknowledged(open: Alert[]): Alert[] {
  return open.filter((alert) => !alert.acknowledgedAt);
}
```

`api.ts`: widen `sendJson`'s `method` to `'POST' | 'PUT' | 'DELETE'`.

`app.tsx`:

- New state next to `openAlerts`: `/** Rules pushed live after an edit; the config's rules until the first push. */ const [liveRules, setLiveRules] = useState<Rule[]>();`. Where the config is loaded (the effect that calls `setConfig`), also `setLiveRules(undefined)`.
- In `onMessage`: add `else if (message.type === 'rules') setLiveRules(message.rules);` before the sample branch (the `else` currently treats anything else as a sample — keep the `rules` check above it). Never write rules into `config`: the live effect depends on `config` and would reconnect.
- `const rules = liveRules ?? config.rules ?? [];` after the `!config` guard; pass `rules={rules}` to `Tile`.
- Badge: `const loud = unacknowledged(openAlerts); const worstOpen = worstAlert(loud);` and use `loud.length` in the badge and its `aria-label`.
- Tile `alert=` stays `worstAlert(openAlerts.filter(...))` (acknowledged alerts still show, muted).

`tile.tsx` alert line:

```tsx
{
  alert && (
    <p
      class="note alert-line"
      data-severity={alert.severity}
      data-acknowledged={alert.acknowledgedAt ? 'true' : undefined}
    >
      <StatusIcon level={alert.severity} />
      Alert since {formatTime(alert.raisedAt)} ({formatUptime(now - alert.raisedAt)})
      {alert.acknowledgedAt ? ' · acknowledged' : ''}
    </p>
  );
}
```

`styles.css`, next to `.alert-line`:

```css
.alert-line[data-acknowledged='true'] {
  opacity: 0.65;
}
```

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run packages/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web
git commit -m "Follow rule changes live and quieten acknowledged alerts on the dashboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Rule form helpers

**Files:**

- Create: `packages/web/src/rule-form.ts`
- Test: `packages/web/test/rule-form.test.ts`

**Interfaces:**

- Consumes: `RuleEntry`, `Severity` (Task 8).
- Produces:

```ts
export type Condition = 'atLeast' | 'atMost' | 'bitsSet' | 'noReadingFor';
export interface RuleDraft {
  id: string;
  metric: string;
  condition: Condition;
  value: string;
  for: string;
  clearAfter: string;
  severity: Severity;
  message: string;
}
export type FormField = keyof RuleDraft | 'form';
export type FormErrors = Partial<Record<FormField, string>>;
export const CONDITIONS: { id: Condition; label: string }[];
export function emptyDraft(metric: string): RuleDraft;
export function draftOf(written: Record<string, unknown>): RuleDraft;
export function bodyOf(
  draft: RuleDraft
): { ok: true; body: Record<string, unknown> } | { ok: false; errors: FormErrors };
export function formErrors(server: Record<string, string>): FormErrors;
export function toggleRequest(
  entry: RuleEntry
): { method: 'PUT'; body: Record<string, unknown> } | { method: 'DELETE' };
```

- [ ] **Step 1: Write the failing tests**

Create `packages/web/test/rule-form.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bodyOf, draftOf, emptyDraft, formErrors, toggleRequest } from '../src/rule-form.js';
import type { RuleEntry } from '../src/types.js';

const written = {
  id: 'cpu_hot',
  metric: 'cpu_temperature',
  atLeast: 80,
  for: '2min',
  clearAfter: '2min',
  severity: 'critical',
  message: 'CPU running hot'
};

describe('draftOf / bodyOf', () => {
  it('round-trips a threshold rule', () => {
    const draft = draftOf(written);
    expect(draft).toMatchObject({ condition: 'atLeast', value: '80', for: '2min' });
    expect(bodyOf(draft)).toEqual({ ok: true, body: written });
  });

  it('shows a bit mask in hex and reads hex or decimal back', () => {
    const draft = draftOf({ ...written, atLeast: undefined, bitsSet: 15 });
    expect(draft).toMatchObject({ condition: 'bitsSet', value: '0xf' });
    expect(bodyOf({ ...draft, value: '0x50000' })).toMatchObject({
      ok: true,
      body: { bitsSet: 0x50000 }
    });
    expect(bodyOf({ ...draft, value: '16' })).toMatchObject({ ok: true, body: { bitsSet: 16 } });
  });

  it('sends no for or clearAfter with a silence rule, and leaves empty ones out', () => {
    const silence = {
      ...emptyDraft('*'),
      id: 'quiet',
      condition: 'noReadingFor' as const,
      value: 'auto',
      for: '5min',
      message: 'Quiet'
    };
    const result = bodyOf(silence);
    expect(result).toMatchObject({ ok: true, body: { noReadingFor: 'auto' } });
    expect(result.ok && 'for' in result.body).toBe(false);
    const threshold = bodyOf({
      ...emptyDraft('cpu_load'),
      id: 'x',
      value: '5',
      for: '',
      message: 'm'
    });
    expect(threshold.ok && 'for' in threshold.body).toBe(false);
  });

  it('catches a value that is not a number before asking the server', () => {
    expect(bodyOf({ ...emptyDraft('cpu_load'), value: 'lots' })).toEqual({
      ok: false,
      errors: { value: 'Enter a number.' }
    });
    expect(bodyOf({ ...emptyDraft('cpu_load'), condition: 'bitsSet', value: '0xZZ' })).toEqual({
      ok: false,
      errors: { value: 'Enter a mask like 0xf.' }
    });
  });
});

describe('formErrors', () => {
  it('puts each server error under its form field', () => {
    expect(formErrors({ atLeast: 'a', bitsSet: 'b' }).value).toBe('b');
    expect(formErrors({ for: 'f', condition: 'c', rule: 'r' })).toEqual({
      for: 'f',
      condition: 'c',
      form: 'r'
    });
  });
});

describe('toggleRequest', () => {
  const entry = (over: Partial<RuleEntry>): RuleEntry => ({
    id: 'cpu_hot',
    kind: 'built-in',
    disabled: false,
    rule: null,
    written,
    overrides: null,
    problem: null,
    saved: false,
    ...over
  });
  it('disables a built-in with a bare entry and enables it by removing that entry', () => {
    expect(toggleRequest(entry({}))).toEqual({
      method: 'PUT',
      body: { id: 'cpu_hot', disabled: true }
    });
    expect(toggleRequest(entry({ disabled: true, saved: true }))).toEqual({ method: 'DELETE' });
  });
  it('keeps the settings of an edited or added rule while it is off', () => {
    expect(toggleRequest(entry({ kind: 'added' }))).toEqual({
      method: 'PUT',
      body: { ...written, disabled: true }
    });
    expect(
      toggleRequest(
        entry({ kind: 'edited', disabled: true, written: { ...written, disabled: true } })
      )
    ).toEqual({
      method: 'PUT',
      body: written
    });
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run packages/web/test/rule-form.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/web/src/rule-form.ts`**

```ts
import type { RuleEntry, Severity } from './types.js';

export type Condition = 'atLeast' | 'atMost' | 'bitsSet' | 'noReadingFor';

/** The rule form's fields, all as typed. */
export interface RuleDraft {
  id: string;
  metric: string;
  condition: Condition;
  value: string;
  for: string;
  clearAfter: string;
  severity: Severity;
  message: string;
}

export type FormField = keyof RuleDraft | 'form';
export type FormErrors = Partial<Record<FormField, string>>;

export const CONDITIONS: { id: Condition; label: string }[] = [
  { id: 'atLeast', label: 'At least' },
  { id: 'atMost', label: 'At most' },
  { id: 'bitsSet', label: 'Any of these flags set' },
  { id: 'noReadingFor', label: 'No reading for' }
];

export function emptyDraft(metric: string): RuleDraft {
  return {
    id: '',
    metric,
    condition: 'atLeast',
    value: '',
    for: '5min',
    clearAfter: '',
    severity: 'warning',
    message: ''
  };
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** A rule in the rules-file format as form fields; a mask shows in hex. */
export function draftOf(written: Record<string, unknown>): RuleDraft {
  const condition = CONDITIONS.find(({ id }) => written[id] !== undefined)?.id ?? 'atLeast';
  const raw = written[condition];
  return {
    id: text(written['id']),
    metric: text(written['metric']),
    condition,
    value:
      condition === 'bitsSet' && typeof raw === 'number'
        ? `0x${raw.toString(16)}`
        : raw === undefined
          ? ''
          : String(raw),
    for: text(written['for']),
    clearAfter: text(written['clearAfter']),
    severity: written['severity'] === 'critical' ? 'critical' : 'warning',
    message: text(written['message'])
  };
}

/** The draft as a rules-file entry for PUT, or what the browser can already tell is wrong. */
export function bodyOf(
  draft: RuleDraft
): { ok: true; body: Record<string, unknown> } | { ok: false; errors: FormErrors } {
  const body: Record<string, unknown> = { id: draft.id.trim(), metric: draft.metric };
  const value = draft.value.trim();
  if (draft.condition === 'noReadingFor') {
    body['noReadingFor'] = value;
  } else {
    const number =
      draft.condition === 'bitsSet' && /^0x/i.test(value)
        ? /^0x[0-9a-f]+$/i.test(value)
          ? parseInt(value.slice(2), 16)
          : NaN
        : value === ''
          ? NaN
          : Number(value);
    if (!Number.isFinite(number)) {
      return {
        ok: false,
        errors: {
          value: draft.condition === 'bitsSet' ? 'Enter a mask like 0xf.' : 'Enter a number.'
        }
      };
    }
    body[draft.condition] = number;
    if (draft.for.trim()) body['for'] = draft.for.trim();
    if (draft.clearAfter.trim()) body['clearAfter'] = draft.clearAfter.trim();
  }
  body['severity'] = draft.severity;
  body['message'] = draft.message.trim();
  return { ok: true, body };
}

const FIELDS: FormField[] = [
  'id',
  'metric',
  'condition',
  'for',
  'clearAfter',
  'severity',
  'message'
];

/** The server's per-field errors placed under the form's fields. */
export function formErrors(server: Record<string, string>): FormErrors {
  const errors: FormErrors = {};
  for (const [field, message] of Object.entries(server)) {
    const at: FormField = ['atLeast', 'atMost', 'bitsSet', 'noReadingFor'].includes(field)
      ? 'value'
      : (FIELDS.find((f) => f === field) ?? 'form');
    errors[at] = message;
  }
  return errors;
}

/**
 * Disable or Enable: a built-in or file rule is switched off by a bare
 * saved entry and back on by removing it; an edited or added rule is saved
 * with or without `disabled`, so its settings survive being off.
 */
export function toggleRequest(
  entry: RuleEntry
): { method: 'PUT'; body: Record<string, unknown> } | { method: 'DELETE' } {
  const lower = entry.kind === 'built-in' || entry.kind === 'file';
  const { disabled: _disabled, ...written } = entry.written ?? { id: entry.id };
  if (!entry.disabled) {
    return lower
      ? { method: 'PUT', body: { id: entry.id, disabled: true } }
      : { method: 'PUT', body: { ...written, disabled: true } };
  }
  return lower ? { method: 'DELETE' } : { method: 'PUT', body: written };
}
```

Note: `bodyOf` puts keys in the order `id, metric, <condition>, for, clearAfter, severity, message`, matching `ruleToEntry`, so the round-trip test's `toEqual` holds.

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run packages/web/test/rule-form.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web
git commit -m "Add the rule form's draft and request helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Rules editor and Acknowledge on the Alerts page

**Files:**

- Create: `packages/web/src/rules-editor.tsx`
- Modify: `packages/web/src/alerts-page.tsx`, `packages/web/src/app.tsx`, `packages/web/src/styles.css`
- Test: `packages/web/test/rules-editor.test.tsx` (create), `packages/web/test/alerts-page.test.tsx`

**Interfaces:**

- Consumes: `rule-form.ts` (Task 9); `sendJson`, `getJson`, `HttpError`, `Session` (api.ts); `describeRule`, `applyAlertEvent` (alerts.ts); `RuleEntry`, `Rule`, `PluginInfo`, `Alert` (types.ts).
- Produces: `RulesSection(props: { plugins: PluginInfo[]; rules: Rule[]; session: Session; onSignedOut(): void })`; `AlertsPage` props gain `rules: Rule[]`, `session: Session`, `onSessionChange(session: Session): void`, `onAcknowledged(alert: Alert): void`.

- [ ] **Step 1: Write the failing editor tests**

Create `packages/web/test/rules-editor.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { RulesSection } from '../src/rules-editor.js';
import type { PluginInfo, RuleEntry } from '../src/types.js';
import type { Session } from '../src/api.js';

const plugins: PluginInfo[] = [
  { id: 'cpu_load', label: 'CPU load', unit: '%', intervalMs: 5000 },
  { id: 'cpu_temperature', label: 'CPU temperature', unit: '°C', intervalMs: 10_000 }
];
const hot = {
  id: 'cpu_hot',
  metric: 'cpu_temperature',
  atLeast: 80,
  forMs: 120_000,
  clearAfterMs: 120_000,
  severity: 'critical' as const,
  message: 'CPU running hot',
  source: 'built-in' as const
};
const entry = (over: Partial<RuleEntry>): RuleEntry => ({
  id: 'cpu_hot',
  kind: 'built-in',
  disabled: false,
  rule: hot,
  written: {
    id: 'cpu_hot',
    metric: 'cpu_temperature',
    atLeast: 80,
    for: '2min',
    clearAfter: '2min',
    severity: 'critical',
    message: 'CPU running hot'
  },
  overrides: null,
  problem: null,
  saved: false,
  ...over
});
const signedIn: Session = { editable: true, signedIn: true, protectReads: false };

let entries: RuleEntry[];
let answer: (url: string, init?: RequestInit) => Response;
let root: HTMLElement;
beforeEach(() => {
  entries = [entry({})];
  answer = () => Response.json({ rules: entries });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => answer(url, init))
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
const show = async (session = signedIn) => {
  render(
    <RulesSection plugins={plugins} rules={[]} session={session} onSignedOut={() => {}} />,
    root
  );
  await settle();
};
const button = (name: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === name)!;
const calls = () => vi.mocked(fetch).mock.calls.map(([url, init]) => [init?.method ?? 'GET', url]);
const input = (id: string, value: string) =>
  act(() => {
    const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

describe('<RulesSection>', () => {
  it('lists rules in words with their kind and any problem', async () => {
    entries = [
      entry({}),
      entry({ id: 'x', kind: 'added', rule: null, problem: 'unknown metric "gone"', saved: true })
    ];
    await show();
    expect(root.textContent).toContain('CPU temperature ≥ 80 °C for 2 min');
    expect(root.textContent).toContain('Built-in');
    expect(root.textContent).toContain('Not in force: unknown metric "gone"');
  });

  it('is read-only when signed out, pointing at sign-in', async () => {
    await show({ editable: true, signedIn: false, protectReads: false });
    expect(root.querySelectorAll('button')).toHaveLength(0);
    expect(root.textContent).toContain('Sign in');
  });

  it('disables and reverts with the right requests', async () => {
    await show();
    await act(() => button('Disable').click());
    await settle();
    expect(calls().at(-1)).toEqual(['PUT', '/api/alerts/rules/cpu_hot']);
    entries = [entry({ kind: 'edited', saved: true, overrides: hot })];
    render(null, root);
    await show();
    expect(button('Revert')).toBeDefined();
    await act(() => button('Revert').click());
    await settle();
    expect(calls().at(-1)).toEqual(['DELETE', '/api/alerts/rules/cpu_hot']);
  });

  it('adds a rule through the form and shows server errors under their fields, focusing the first', async () => {
    await show();
    await act(() => button('Add rule').click());
    await input('rule-id', 'test_busy');
    await input('rule-metric', 'cpu_load');
    await input('rule-value', '50');
    await input('rule-message', 'Busy');
    answer = (_url, init) =>
      init?.method === 'PUT'
        ? Response.json({ errors: { for: 'longer than raw retention (2d)' } }, { status: 400 })
        : Response.json({ rules: entries });
    await act(() => button('Save rule').click());
    await settle();
    const error = root.querySelector('#rule-for-error');
    expect(error?.textContent).toContain('longer than raw retention');
    expect(document.activeElement?.id).toBe('rule-for');
    const [, init] = vi.mocked(fetch).mock.calls.at(-1)!;
    expect(JSON.parse(String(init!.body))).toMatchObject({
      id: 'test_busy',
      metric: 'cpu_load',
      atLeast: 50
    });
  });

  it('offers "Every metric" only for a no-reading rule', async () => {
    await show();
    await act(() => button('Add rule').click());
    const options = () =>
      [...root.querySelectorAll('#rule-metric option')].map((o) => o.textContent);
    expect(options()).not.toContain('Every metric');
    await input('rule-condition', 'noReadingFor');
    expect(options()).toContain('Every metric');
    expect(root.querySelector('#rule-clearAfter')).toBeNull();
  });

  it('falls back to signed out on a 401', async () => {
    const onSignedOut = vi.fn();
    render(
      <RulesSection plugins={plugins} rules={[]} session={signedIn} onSignedOut={onSignedOut} />,
      root
    );
    await settle();
    answer = (_url, init) =>
      init?.method ? new Response('{}', { status: 401 }) : Response.json({ rules: entries });
    await act(() => button('Disable').click());
    await settle();
    expect(onSignedOut).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Update the Alerts page tests**

In `packages/web/test/alerts-page.test.tsx`:

- The `fetch` stub answers by URL: `vi.fn(async (url: string) => String(url).startsWith('/api/alerts/rules') ? Response.json({ rules: [] }) : Response.json(history))`.
- Add a helper `const historyCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => !String(url).startsWith('/api/alerts/rules'));` and use it wherever the file reads `mock.calls[0]` or counts calls (`waitForFetchCalls(n)` → wait for `historyCalls().length === n`).
- Every `render(<AlertsPage … />)` gains `rules={config.rules ?? []} session={NO_SESSION} onSessionChange={() => {}} onAcknowledged={() => {}}` (import `NO_SESSION` from `../src/api.js`).
- Remove the assertions on the old read-only Rules list and its "edited in the file named by PIPULSE_ALERTS_FILE" note (the editor tests cover the section now).
- Add:

```tsx
it('acknowledges an open alert when signed in, and tags acknowledged ones', async () => {
  const onAcknowledged = vi.fn();
  const acked = alert({ id: 1, acknowledgedAt: NOW });
  vi.mocked(fetch).mockImplementation(async (url, init) =>
    init?.method === 'POST'
      ? Response.json(acked)
      : String(url).startsWith('/api/alerts/rules')
        ? Response.json({ rules: [] })
        : Response.json(history)
  );
  render(
    <AlertsPage
      config={config}
      rules={[]}
      open={[alert({ id: 1 }), alert({ id: 2, acknowledgedAt: NOW - MIN })]}
      now={() => NOW}
      session={{ editable: true, signedIn: true, protectReads: false }}
      onSessionChange={() => {}}
      onAcknowledged={onAcknowledged}
    />,
    root
  );
  await settle();
  const buttons = [...section('Open').querySelectorAll('button')].filter(
    (b) => b.textContent === 'Acknowledge'
  );
  expect(buttons).toHaveLength(1);
  expect(section('Open').textContent).toContain('Acknowledged');
  await act(() => buttons[0]!.click());
  await vi.waitFor(() => expect(onAcknowledged).toHaveBeenCalledWith(acked));
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/alerts/1/acknowledge')).toBe(
    true
  );
});

it('marks alerts closed because their rule changed', async () => {
  history = [alert({ id: 5, clearedAt: NOW - MIN, clearedBy: 'rule_changed' })];
  render(
    <AlertsPage
      config={config}
      rules={[]}
      open={[]}
      now={() => NOW}
      session={NO_SESSION}
      onSessionChange={() => {}}
      onAcknowledged={() => {}}
    />,
    root
  );
  await settle();
  expect(section('Recent').textContent).toContain('rule changed');
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run packages/web/test/rules-editor.test.tsx packages/web/test/alerts-page.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement `packages/web/src/rules-editor.tsx`**

```tsx
import { useEffect, useRef, useState } from 'preact/hooks';
import { describeRule } from './alerts.js';
import { getJson, HttpError, sendJson, type Session } from './api.js';
import {
  bodyOf,
  CONDITIONS,
  draftOf,
  emptyDraft,
  formErrors,
  toggleRequest,
  type FormErrors,
  type RuleDraft
} from './rule-form.js';
import { routeHash } from './router.js';
import { StatusIcon } from './tile.js';
import type { PluginInfo, Rule, RuleEntry, RuleKind } from './types.js';

const KIND_LABELS: Record<RuleKind, string> = {
  'built-in': 'Built-in',
  file: 'File',
  edited: 'Edited',
  added: 'Added'
};

type Loaded =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; entries: RuleEntry[] };
/** The form: `id` set while editing that rule, unset while adding one. */
type Editing = { id?: string; draft: RuleDraft };

const path = (id: string) => `/api/alerts/rules/${encodeURIComponent(id)}`;

/**
 * The rules in force and how they came to be, with Edit, Disable/Enable,
 * Revert (edited) or Delete (added), and Add rule when signed in. Reloads
 * whenever the live rule set changes, so another tab's edit shows here too.
 */
export function RulesSection({
  plugins,
  rules,
  session,
  onSignedOut
}: {
  plugins: PluginInfo[];
  /** The live rules in force; a new array means something changed. */
  rules: Rule[];
  session: Session;
  onSignedOut(): void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [editing, setEditing] = useState<Editing>();
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const canEdit = session.editable && session.signedIn;

  useEffect(() => {
    let cancelled = false;
    getJson<{ rules: RuleEntry[] }>('/api/alerts/rules').then(
      (body) => !cancelled && setLoaded({ status: 'ready', entries: body.rules }),
      () => !cancelled && setLoaded({ status: 'error' })
    );
    return () => {
      cancelled = true;
    };
  }, [rules]);

  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);

  /** Sends one change; true when it was saved. */
  const send = async (method: 'PUT' | 'DELETE', id: string, body?: Record<string, unknown>) => {
    setBusy(true);
    try {
      const result = await sendJson<{ rules: RuleEntry[] }>(method, path(id), body);
      setLoaded({ status: 'ready', entries: result.rules });
      setErrors({});
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) onSignedOut();
      else if (error instanceof HttpError && error.status === 400) {
        const server = (error.body as { errors?: Record<string, string> } | undefined)?.errors;
        setErrors(server ? formErrors(server) : { form: 'The PiPulse server refused this rule.' });
      } else {
        setErrors({ form: `Couldn't save: ${(error as Error).message}.` });
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    const draft = editing.id ? { ...editing.draft, id: editing.id } : editing.draft;
    const result = bodyOf(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    if (await send('PUT', draft.id.trim(), result.body)) setEditing(undefined);
  };

  if (loaded.status === 'loading') return <p class="waiting">Loading</p>;
  if (loaded.status === 'error') {
    return <p class="waiting">Couldn't load the alert rules from the PiPulse server.</p>;
  }

  const set = (field: keyof RuleDraft) => (event: Event) => {
    const value = (event.currentTarget as HTMLInputElement).value;
    setEditing((current) => {
      if (!current) return current;
      const draft = { ...current.draft, [field]: value };
      // "Every metric" only makes sense for silence.
      if (field === 'condition' && value !== 'noReadingFor' && draft.metric === '*') {
        draft.metric = plugins[0]?.id ?? '';
      }
      return { ...current, draft };
    });
  };
  const field = (name: keyof RuleDraft, label: string, input: preact.JSX.Element) => (
    <div class="form-field">
      <label for={`rule-${name}`}>{label}</label>
      {input}
      {errors[name] && (
        <p class="form-error" id={`rule-${name}-error`}>
          {errors[name]}
        </p>
      )}
    </div>
  );
  const invalid = (name: keyof RuleDraft) =>
    errors[name]
      ? { 'aria-invalid': 'true' as const, 'aria-describedby': `rule-${name}-error` }
      : {};

  const ruleForm = editing && (
    <form
      ref={form}
      class="rule-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {!editing.id &&
        field(
          'id',
          'Id (lowercase, e.g. cpu_busy_short)',
          <input id="rule-id" value={editing.draft.id} onInput={set('id')} {...invalid('id')} />
        )}
      {field(
        'condition',
        'Condition',
        <select
          id="rule-condition"
          value={editing.draft.condition}
          onChange={set('condition')}
          {...invalid('condition')}
        >
          {CONDITIONS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      )}
      {field(
        'metric',
        'Metric',
        <select
          id="rule-metric"
          value={editing.draft.metric}
          onChange={set('metric')}
          {...invalid('metric')}
        >
          {editing.draft.condition === 'noReadingFor' && <option value="*">Every metric</option>}
          {plugins.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      )}
      {field(
        'value',
        editing.draft.condition === 'noReadingFor'
          ? 'For (e.g. 5min, or auto)'
          : editing.draft.condition === 'bitsSet'
            ? 'Flags (e.g. 0xf)'
            : 'Value',
        <input
          id="rule-value"
          value={editing.draft.value}
          onInput={set('value')}
          {...invalid('value')}
        />
      )}
      {editing.draft.condition !== 'noReadingFor' && (
        <>
          {field(
            'for',
            'Lasting (e.g. 10min)',
            <input
              id="rule-for"
              value={editing.draft.for}
              onInput={set('for')}
              {...invalid('for')}
            />
          )}
          {field(
            'clearAfter',
            'Clear after (empty = same)',
            <input
              id="rule-clearAfter"
              value={editing.draft.clearAfter}
              onInput={set('clearAfter')}
              {...invalid('clearAfter')}
            />
          )}
        </>
      )}
      {field(
        'severity',
        'Severity',
        <select
          id="rule-severity"
          value={editing.draft.severity}
          onChange={set('severity')}
          {...invalid('severity')}
        >
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
        </select>
      )}
      {field(
        'message',
        'Message',
        <input
          id="rule-message"
          value={editing.draft.message}
          onInput={set('message')}
          {...invalid('message')}
        />
      )}
      {errors.form && <p class="form-error">{errors.form}</p>}
      <div class="rule-actions">
        <button type="submit" disabled={busy}>
          Save rule
        </button>
        <button
          type="button"
          class="link-button"
          onClick={() => {
            setEditing(undefined);
            setErrors({});
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <>
      {canEdit ? (
        !editing && (
          <button
            type="button"
            onClick={() => {
              setErrors({});
              setEditing({ draft: emptyDraft(plugins[0]?.id ?? '') });
            }}
          >
            Add rule
          </button>
        )
      ) : (
        <p class="note">
          {session.editable ? (
            <>
              <a href={routeHash({ page: 'settings' })}>Sign in</a> to edit rules and acknowledge
              alerts.
            </>
          ) : (
            'Rules are read-only: no admin password is configured (PIPULSE_ADMIN_PASSWORD_HASH_FILE).'
          )}
        </p>
      )}
      {editing && !editing.id && ruleForm}
      <ul class="rule-list">
        {loaded.entries.map((entry) => {
          const toggle = toggleRequest(entry);
          return (
            <li
              key={entry.id}
              data-severity={entry.rule?.severity}
              data-disabled={entry.disabled ? 'true' : undefined}
            >
              <span>{entry.rule ? describeRule(entry.rule, plugins) : entry.id}</span>
              {entry.rule && (
                <span class="alert-severity">
                  <StatusIcon level={entry.rule.severity} />
                  {entry.rule.severity === 'critical' ? 'Critical' : 'Warning'}
                </span>
              )}
              <span class="rule-source">
                {KIND_LABELS[entry.kind]}
                {entry.disabled && ' · Disabled'}
              </span>
              {entry.problem && (
                <span class="rule-problem">
                  <StatusIcon level="warning" />
                  Not in force: {entry.problem}
                </span>
              )}
              {canEdit && (
                <span class="rule-actions">
                  {entry.written && entry.rule && (
                    <button
                      type="button"
                      class="link-button"
                      disabled={busy}
                      onClick={() => {
                        setErrors({});
                        setEditing({ id: entry.id, draft: draftOf(entry.written!) });
                      }}
                    >
                      Edit
                    </button>
                  )}
                  {entry.rule && (
                    <button
                      type="button"
                      class="link-button"
                      disabled={busy}
                      onClick={() =>
                        void send(
                          toggle.method,
                          entry.id,
                          toggle.method === 'PUT' ? toggle.body : undefined
                        )
                      }
                    >
                      {entry.disabled ? 'Enable' : 'Disable'}
                    </button>
                  )}
                  {entry.kind === 'edited' && (
                    <button
                      type="button"
                      class="link-button"
                      disabled={busy}
                      onClick={() => void send('DELETE', entry.id)}
                    >
                      Revert
                    </button>
                  )}
                  {entry.kind === 'added' && (
                    <button
                      type="button"
                      class="link-button"
                      disabled={busy}
                      onClick={() => void send('DELETE', entry.id)}
                    >
                      Delete
                    </button>
                  )}
                </span>
              )}
              {editing?.id === entry.id && ruleForm}
            </li>
          );
        })}
      </ul>
    </>
  );
}
```

Format it with Prettier (`npx prettier --write packages/web/src/rules-editor.tsx`); the inline handlers above are compressed for the plan. If `preact.JSX.Element` isn't resolvable as a global namespace in this project, `import type { JSX } from 'preact';` and use `JSX.Element`. `sendJson` currently types `body` as optional `unknown`; passing `undefined` for `DELETE` sends no body.

- [ ] **Step 5: Update `alerts-page.tsx`**

- Imports: `import { HttpError, sendJson, type Session } from './api.js';` (alongside the existing `apiFetch`), `import { RulesSection } from './rules-editor.js';`, and `Rule` from `./types.js`; drop `describeRule` if nothing else uses it.
- Props gain `rules: Rule[]`, `session: Session`, `onSessionChange(session: Session): void`, `onAcknowledged(alert: Alert): void`.
- `AlertRow` gains `canAcknowledge: boolean` and `onAcknowledge?: () => void`; after the `when` span:

```tsx
{
  alert.acknowledgedAt ? (
    <span class="alert-acknowledged">Acknowledged {formatDateTime(alert.acknowledgedAt)}</span>
  ) : (
    canAcknowledge &&
    alert.clearedAt === null && (
      <button type="button" class="link-button" onClick={onAcknowledge}>
        Acknowledge
      </button>
    )
  );
}
```

and in the `when` span add `{alert.clearedBy === 'rule_changed' && ' · rule changed'}` next to the `rule_removed` line.

- In `AlertsPage`:

```tsx
const canEdit = session.editable && session.signedIn;
const signedOut = () => onSessionChange({ ...session, signedIn: false });
const acknowledge = (alert: Alert) => {
  sendJson<Alert>('POST', `/api/alerts/${alert.id}/acknowledge`).then(
    onAcknowledged,
    (error: unknown) => {
      if (error instanceof HttpError && error.status === 401) signedOut();
    }
  );
};
```

Open rows get `canAcknowledge={canEdit} onAcknowledge={() => acknowledge(alert)}`; Recent rows `canAcknowledge={false}`. Replace the Rules section body (the `<ul class="rule-list">…` and the file note) with `<RulesSection plugins={config.plugins} rules={rules} session={session} onSignedOut={signedOut} />`.

- [ ] **Step 6: Pass the new props from `app.tsx`**

```tsx
<AlertsPage
  config={config}
  rules={rules}
  open={openAlerts}
  now={() => Date.now() + clockOffset.current}
  session={session}
  onSessionChange={(next) => {
    setSession(next);
    if (next.protectReads && !next.signedIn) setNeedSignIn(true);
  }}
  onAcknowledged={(alert) => setOpenAlerts((open) => applyAlertEvent(open, 'acknowledged', alert))}
/>
```

- [ ] **Step 7: Styles**

Append to `packages/web/src/styles.css` beside the `.rule-list` rules (reuse existing tokens; check the file's colour variables rather than inventing new ones):

```css
.rule-list li[data-disabled='true'] {
  opacity: 0.6;
}

.rule-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.rule-problem {
  display: inline-flex;
  gap: 0.35rem;
  align-items: center;
}

.rule-form {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  margin: 0.75rem 0;
  width: 100%;
}

.rule-form .form-field {
  display: grid;
  gap: 0.25rem;
}

.alert-acknowledged {
  font-size: 0.85em;
  opacity: 0.8;
}
```

- [ ] **Step 8: Run to see them pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Check it in a browser**

Build and run locally with a password (`node packages/api/dist/hash-password.js > /tmp/pp-hash` then `PIPULSE_ADMIN_PASSWORD_HASH_FILE=/tmp/pp-hash PIPULSE_DB_PATH=/tmp/pp-5b2.db PIPULSE_PORT=8899 node packages/api/dist/server.js`), open `http://localhost:8899/#/alerts`, sign in on Settings, and check at phone width (375 px) and desktop: Add rule form fits without horizontal scroll, errors appear under fields, Disable/Enable/Revert work, a second tab updates after an edit. Clean up `/tmp/pp-*` afterwards.

- [ ] **Step 10: Commit**

```bash
git add packages/web
git commit -m "Edit alert rules and acknowledge alerts on the Alerts page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docs

**Files:**

- Modify: `README.md` (roadmap row 5b-2), `docs/PLAN.md` (5b-2 row, parity notes on swap), `CLAUDE.md`, `docs/superpowers/specs/2026-09-23-alerting-design.md` (built-in `swap_heavy` row), rules-file documentation wherever `PIPULSE_ALERTS_FILE` is documented (grep for it).

- [ ] **Step 1: Update the docs**

- `CLAUDE.md`: replace the convention "Alert rules are data from the built-ins and the operator's file only, never from the API. Anything that writes (rule editing, acknowledging) waits for 5b's authentication." with: "Alert rules come from three layers merged by `id` — built-ins, `PIPULSE_ALERTS_FILE`, then rules saved from the browser (settings key `alerts.rules`) — read live by `createRuleSource()` on every check. A bad file stops startup; a bad saved rule is skipped and shown as 'Not in force'. Rules are always data validated by `parseRuleEntry`, never code." Mark 5b-2 in progress (the "done" paragraph is written after the exit criterion is verified on the Pi).
- Alerting spec's built-in table: `swap_heavy` → `swap_io` ≥ 250 pages/s, 10min, with a line pointing at the 5b-2 spec.
- `README.md`/`docs/PLAN.md`: 5b-2 row says "In progress" until verification.

- [ ] **Step 2: Format, lint, test**

Run: `npm run format && npm run lint && npm test`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md docs
git commit -m "Document rules edited in the browser and the new swap_heavy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the tasks

Deploy to the Pi 2 (port 8889) and run the spec's exit criterion; then record it as verified in `CLAUDE.md`, `README.md` and `docs/PLAN.md` (as with 5b-1) and open the PR.
