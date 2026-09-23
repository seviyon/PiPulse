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
