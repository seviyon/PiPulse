import { useEffect, useState } from 'preact/hooks';
import { getJson } from './api.js';
import { formatDateTime } from './format.js';
import { StatusIcon } from './tile.js';
import type { WebhookStatus } from './types.js';

type Loaded =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; webhooks: WebhookStatus[] };

/** "raised and cleared, warning and up" / "raised only, critical only". */
function filtersText(webhook: WebhookStatus): string {
  const events = webhook.events.join(' and ') + (webhook.events.length === 1 ? ' only' : '');
  const severity = webhook.minSeverity === 'critical' ? 'critical only' : 'warning and up';
  return `${events}, ${severity}`;
}

/** Failing while the newest attempt on record failed. */
function isFailing(webhook: WebhookStatus): boolean {
  return (
    webhook.lastFailure !== null &&
    (webhook.lastSuccessAt === null || webhook.lastFailure.at > webhook.lastSuccessAt)
  );
}

/**
 * Webhooks from PIPULSE_NOTIFY_FILE and how their deliveries are going.
 * Read-only: webhooks are configured in the file, not in the browser.
 */
export function NotificationsSection() {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });

  useEffect(() => {
    getJson<unknown>('/api/notify').then(
      // An older server has no status to give; treat that as nothing configured.
      (body) => setLoaded({ status: 'ready', webhooks: Array.isArray(body) ? body : [] }),
      () => setLoaded({ status: 'error' })
    );
  }, []);

  return (
    <section aria-labelledby="settings-notifications">
      <h2 id="settings-notifications">Notifications</h2>
      <div class="note">
        <p>
          Webhooks are set in the file named by <code>PIPULSE_NOTIFY_FILE</code>; test one with{' '}
          <code>node packages/api/dist/notify-test.js</code>.
        </p>
      </div>
      {loaded.status === 'loading' && <p class="waiting">Loading</p>}
      {loaded.status === 'error' && (
        <p class="waiting">Couldn't load the notification status from the PiPulse server.</p>
      )}
      {loaded.status === 'ready' && loaded.webhooks.length === 0 && (
        <p class="waiting">No webhooks configured — set PIPULSE_NOTIFY_FILE.</p>
      )}
      {loaded.status === 'ready' && loaded.webhooks.length > 0 && (
        <ul class="webhook-list">
          {loaded.webhooks.map((webhook) => (
            <li key={webhook.id}>
              <strong>{webhook.id}</strong>
              <span class="rule-source">{webhook.host}</span>
              <span>{filtersText(webhook)}</span>
              {isFailing(webhook) && (
                <span class="alert-severity">
                  <StatusIcon level="warning" />
                  Failing
                </span>
              )}
              {webhook.lastSuccessAt !== null && (
                <span>Last delivered {formatDateTime(webhook.lastSuccessAt)}</span>
              )}
              {webhook.lastFailure && (
                <span>
                  Last failed {formatDateTime(webhook.lastFailure.at)} ({webhook.lastFailure.reason}
                  )
                </span>
              )}
              {webhook.pending > 0 && <span>{webhook.pending} waiting</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
