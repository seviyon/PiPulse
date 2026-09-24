import { useEffect, useState } from 'preact/hooks';
import { rangeCovering, worstAlert } from './alerts.js';
import { formatDateTime, formatUptime, formatValue } from './format.js';
import { routeHash } from './router.js';
import { RulesSection } from './rules-editor.js';
import { StatusIcon } from './tile.js';
import type { Alert, Config, PluginInfo, Rule } from './types.js';
import { apiFetch, HttpError, sendJson, type Session } from './api.js';

const DAY = 86_400_000;
/** Most cleared alerts the Recent list shows; a full page says it's cut short. */
const RECENT_LIMIT = 200;

interface AlertsPageProps {
  config: Config;
  rules: Rule[];
  /** Open alerts, kept current by the live feed. */
  open: Alert[];
  /** Current time on the server's clock. */
  now(): number;
  session: Session;
  onSessionChange(session: Session): void;
  onAcknowledged(alert: Alert): void;
}

const severityWord = (alert: Alert) => (alert.severity === 'critical' ? 'Critical' : 'Warning');

function AlertRow({
  alert,
  plugins,
  now,
  canAcknowledge,
  onAcknowledge
}: {
  alert: Alert;
  plugins: PluginInfo[];
  now: number;
  canAcknowledge: boolean;
  onAcknowledge?: () => void;
}) {
  const plugin = plugins.find((p) => p.id === alert.metric);
  const value = alert.value === null ? undefined : formatValue(alert.value, plugin?.unit ?? '');
  const when =
    alert.clearedAt === null
      ? `since ${formatDateTime(alert.raisedAt)} · ${formatUptime(now - alert.raisedAt)}`
      : `${formatDateTime(alert.raisedAt)} → ${formatDateTime(alert.clearedAt)} (${formatUptime(alert.clearedAt - alert.raisedAt)})`;
  return (
    <li class="alert" data-severity={alert.severity}>
      <span class="alert-severity">
        <StatusIcon level={alert.severity} />
        {severityWord(alert)}
      </span>
      <span class="alert-message">{alert.message}</span>
      {value && (
        <span class="alert-value">{value.unit ? `${value.text} ${value.unit}` : value.text}</span>
      )}
      <span class="alert-when">
        {when}
        {alert.clearedBy === 'rule_removed' && ' · rule removed'}
        {alert.clearedBy === 'rule_changed' && ' · rule changed'}
      </span>
      {alert.acknowledgedAt ? (
        <span class="alert-acknowledged">Acknowledged {formatDateTime(alert.acknowledgedAt)}</span>
      ) : (
        canAcknowledge &&
        alert.clearedAt === null && (
          <button type="button" class="link-button" onClick={onAcknowledge}>
            Acknowledge
          </button>
        )
      )}
      <a href={routeHash({ page: 'history', range: rangeCovering(alert.raisedAt, now) })}>
        History
      </a>
    </li>
  );
}

type Recent = { status: 'loading' } | { status: 'error' } | { status: 'ready'; alerts: Alert[] };

/**
 * Open alerts (live), the last 30 days of cleared ones, and the rules in
 * force. History is refetched whenever the open set changes, so an alert
 * that just cleared moves from Open to Recent.
 */
export function AlertsPage({
  config,
  rules,
  open,
  now,
  session,
  onSessionChange,
  onAcknowledged
}: AlertsPageProps) {
  const [recent, setRecent] = useState<Recent>({ status: 'loading' });
  /** A failed acknowledge (not a 401): shown in the Open section. */
  const [ackError, setAckError] = useState<string>();
  const openKey = open.map((alert) => alert.id).join(',');
  const canEdit = session.editable && session.signedIn;
  const signedOut = () => onSessionChange({ ...session, signedIn: false });
  const acknowledge = (alert: Alert) => {
    sendJson<Alert>('POST', `/api/alerts/${alert.id}/acknowledge`).then(
      (acked) => {
        setAckError(undefined);
        onAcknowledged(acked);
      },
      (error: unknown) => {
        if (error instanceof HttpError && error.status === 401) signedOut();
        else setAckError(`Couldn't acknowledge: ${(error as Error).message}.`);
      }
    );
  };

  useEffect(() => {
    let cancelled = false;
    const to = now();
    apiFetch(`/api/alerts?state=cleared&from=${to - 30 * DAY}&to=${to}&limit=${RECENT_LIMIT}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`alerts answered ${response.status}`);
        return (await response.json()) as Alert[];
      })
      .then(
        (alerts) => {
          if (!cancelled) setRecent({ status: 'ready', alerts });
        },
        () => {
          if (!cancelled) setRecent({ status: 'error' });
        }
      );
    return () => {
      cancelled = true;
    };
  }, [openKey]);

  const t = now();
  const sorted = [...open].sort((a, b) => (worstAlert([a, b]) === a ? -1 : 1));

  return (
    <div class="alerts-page">
      <section aria-labelledby="alerts-open">
        <h2 id="alerts-open">Open</h2>
        {ackError && (
          <p class="form-error" role="alert">
            {ackError}
          </p>
        )}
        {sorted.length === 0 ? (
          <p class="waiting">No open alerts</p>
        ) : (
          <ul class="alert-list">
            {sorted.map((alert) => (
              <AlertRow
                key={alert.id}
                alert={alert}
                plugins={config.plugins}
                now={t}
                canAcknowledge={canEdit}
                onAcknowledge={() => acknowledge(alert)}
              />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="alerts-recent">
        <h2 id="alerts-recent">Recent</h2>
        {recent.status === 'loading' && <p class="waiting">Loading</p>}
        {recent.status === 'error' && (
          <p class="waiting">Couldn't load the alert history from the PiPulse server.</p>
        )}
        {recent.status === 'ready' &&
          (recent.alerts.length === 0 ? (
            <p class="waiting">Nothing cleared in the last 30 days</p>
          ) : (
            <>
              {recent.alerts.length >= RECENT_LIMIT && (
                <p class="waiting">Showing the newest {RECENT_LIMIT} of the last 30 days</p>
              )}
              <ul class="alert-list">
                {recent.alerts.map((alert) => (
                  <AlertRow
                    key={alert.id}
                    alert={alert}
                    plugins={config.plugins}
                    now={t}
                    canAcknowledge={false}
                  />
                ))}
              </ul>
            </>
          ))}
      </section>
      <section aria-labelledby="alerts-rules">
        <h2 id="alerts-rules">Rules</h2>
        <RulesSection
          plugins={config.plugins}
          rules={rules}
          session={session}
          onSignedOut={signedOut}
        />
      </section>
    </div>
  );
}
