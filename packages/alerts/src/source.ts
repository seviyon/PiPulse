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
/** `create`'s error when the id is already a built-in, file or saved rule. */
export const RULE_ID_TAKEN = 'a rule with this id already exists; edit it instead';
/**
 * `not_saved`: nothing is saved for that id. `errors`: refused, because
 * removing the entry would put the rule below into force with a look-back
 * longer than raw retention.
 */
export type RemoveResult = 'removed' | 'not_saved' | { errors: Record<string, string> };

type Retention = { ms: number; text: string };

export interface RuleSource {
  read(): RuleSet;
  save(raw: unknown, now?: number): SaveResult;
  /** Like save, but refuses (RULE_ID_TAKEN) an id already used by any layer, so Add can't overwrite. */
  create(raw: unknown, now?: number): SaveResult;
  remove(id: string, now?: number): RemoveResult;
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
  // Only rules in force must fit raw retention: each saved entry that would
  // run is checked against it here, and server.ts checks the file and
  // built-ins in force at startup. A disabled entry never runs, so it only
  // has to parse.
  const base = resolveRules({
    cores: options.cores,
    metrics: options.metrics,
    rawRetentionMs: Infinity,
    ...(options.file ? { file: options.file } : {})
  });
  const below = new Map(base.map((rule) => [rule.id, rule]));
  const known = options.metrics.map((metric) => metric.id);
  const reported = new Set<string>();

  /** Raw retention, read at most once per call (it queries the settings table). */
  const retentionOnce = () => {
    let retention: Retention | undefined;
    return () => (retention ??= options.rawRetention());
  };

  /** Throws for the first of `rule`'s look-backs that raw retention can't serve. */
  const checkLookBack = (rule: Rule, retention: Retention) => {
    for (const [field, ms] of [
      ['for', rule.forMs],
      ['clearAfter', rule.clearAfterMs]
    ] as const) {
      if (ms > retention.ms) {
        const detail = `longer than raw retention (${retention.text}); raise it on the Settings page first`;
        throw new AlertRulesError(detail, field, detail);
      }
    }
  };

  /** Validates one saved entry against the rules below it and this host. */
  const check = (raw: unknown, retention: () => Retention): Entry => {
    const entry = parseRuleEntry(raw, 'rule', 'saved');
    if (!entry.rule) {
      if (!below.has(entry.id)) {
        const problem = `no built-in or file rule "${entry.id}" to disable`;
        throw new AlertRulesError(problem, 'id', problem);
      }
      return entry;
    }
    if (entry.disabled) return entry;
    const problem = ruleProblem(entry.rule, known, Infinity);
    if (problem) throw new AlertRulesError(problem.message, problem.field, problem.message);
    checkLookBack(entry.rule, retention());
    return entry;
  };

  const kindOf = (rule: Rule): RuleKind => (rule.source === 'file' ? 'file' : 'built-in');

  const read = (): RuleSet => {
    const retention = retentionOnce();
    const saved = new Map<string, { raw: unknown; entry?: Entry; problem?: string }>();
    for (const raw of readSaved(db)) {
      const id = idOf(raw);
      try {
        saved.set(id, { raw, entry: check(raw, retention) });
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

  /**
   * Validates `raw` and writes it into the saved list read as `list` (so a
   * caller can check that same list for an id conflict first, in the one
   * synchronous call, before anything is written).
   */
  const write = (raw: unknown, now: number, list: unknown[]): SaveResult => {
    let entry: Entry;
    try {
      entry = check(raw, retentionOnce());
    } catch (error) {
      if (!(error instanceof AlertRulesError)) throw error;
      return { ok: false, errors: { [error.field ?? 'rule']: error.detail ?? error.message } };
    }
    const at = list.findIndex((item) => idOf(item) === entry.id);
    if (at >= 0) list[at] = raw;
    else if (list.length >= MAX_SAVED_RULES) {
      return { ok: false, errors: { id: `at most ${MAX_SAVED_RULES} rules can be saved` } };
    } else list.push(raw);
    saveSettings(db, { [SAVED_RULES_KEY]: list }, now);
    return { ok: true };
  };

  return {
    read,
    save(raw, now = Date.now()) {
      return write(raw, now, readSaved(db));
    },
    create(raw, now = Date.now()) {
      const list = readSaved(db);
      const id = idOf(raw);
      if (below.has(id) || list.some((item) => idOf(item) === id)) {
        return { ok: false, errors: { id: RULE_ID_TAKEN } };
      }
      return write(raw, now, list);
    },
    remove(id, now = Date.now()) {
      const list = readSaved(db);
      const rest = list.filter((item) => idOf(item) !== id);
      if (rest.length === list.length) return 'not_saved';
      // Reverting an edit or enabling a disabled rule puts the rule below
      // back in force, so it must fit raw retention like any rule in force.
      const under = below.get(id);
      if (under) {
        try {
          checkLookBack(under, options.rawRetention());
        } catch (error) {
          if (!(error instanceof AlertRulesError)) throw error;
          return { errors: { [error.field ?? 'rule']: error.detail ?? error.message } };
        }
      }
      saveSettings(db, { [SAVED_RULES_KEY]: rest.length > 0 ? rest : undefined }, now);
      return 'removed';
    }
  };
}
