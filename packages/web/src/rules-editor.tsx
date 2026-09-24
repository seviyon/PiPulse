import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
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
  /** A failed Disable/Enable/Revert/Delete: shown above the list, not inside any form. */
  const [rowError, setRowError] = useState<string>();
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

  /** Sends a form save; server field errors render under the open form. */
  const saveForm = async (id: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const result = await sendJson<{ rules: RuleEntry[] }>('PUT', path(id), body);
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

  /**
   * Sends a Disable/Enable/Revert/Delete: no form is open for these (or a
   * different rule's form might be), so a failure shows above the list
   * instead of inside anyone's form.
   */
  const sendRow = async (method: 'PUT' | 'DELETE', id: string, body?: Record<string, unknown>) => {
    setBusy(true);
    try {
      const result = await sendJson<{ rules: RuleEntry[] }>(method, path(id), body);
      setLoaded({ status: 'ready', entries: result.rules });
      setRowError(undefined);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) onSignedOut();
      else setRowError(`Couldn't update this rule: ${(error as Error).message}.`);
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
    if (await saveForm(draft.id.trim(), result.body)) setEditing(undefined);
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
  const field = (name: keyof RuleDraft, label: string, control: JSX.Element) => (
    <div class="form-field">
      <label for={`rule-${name}`}>{label}</label>
      {control}
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
      {rowError && (
        <p class="form-error" role="alert">
          {rowError}
        </p>
      )}
      <ul class="rule-list">
        {loaded.entries.map((entry) => {
          const toggle = toggleRequest(entry);
          return (
            <li
              key={entry.id}
              data-severity={entry.rule?.severity}
              data-disabled={entry.disabled ? 'true' : undefined}
            >
              {entry.rule && <span class="alert-message">{entry.rule.message}</span>}
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
                        void sendRow(
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
                      onClick={() => void sendRow('DELETE', entry.id)}
                    >
                      Revert
                    </button>
                  )}
                  {entry.kind === 'added' && (
                    <button
                      type="button"
                      class="link-button"
                      disabled={busy}
                      onClick={() => void sendRow('DELETE', entry.id)}
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
