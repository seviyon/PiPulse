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
          ...describeChange(
            level,
            review.preview.deletions[level],
            body.retention[level],
            draft[level]
          )
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
