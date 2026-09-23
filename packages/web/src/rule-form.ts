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
    if (draft.condition === 'bitsSet' && (!Number.isInteger(number) || number <= 0)) {
      return {
        ok: false,
        errors: { value: 'Enter a mask like 0xf.' }
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
