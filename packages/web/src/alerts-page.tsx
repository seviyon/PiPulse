import { useEffect, useState } from 'preact/hooks';
import { describeRule, rangeCovering, worstAlert } from './alerts.js';
import { formatDateTime, formatUptime, formatValue } from './format.js';
import { routeHash } from './router.js';
import { StatusIcon } from './tile.js';
import type { Alert, Config, PluginInfo } from './types.js';
import { apiFetch } from './api.js';

const DAY = 86_400_000;
/** Most cleared alerts the Recent list shows; a full page says it's cut short. */
const RECENT_LIMIT = 200;

interface AlertsPageProps {
  config: Config;
  /** Open alerts, kept current by the live feed. */
  open: Alert[];
  /** Current time on the server's clock. */
  now(): number;
}

const severityWord = (alert: Alert) => (alert.severity === 'critical' ? 'Critical' : 'Warning');

function AlertRow({ alert, plugins, now }: { alert: Alert; plugins: PluginInfo[]; now: number }) {
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
      </span>
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
export function AlertsPage({ config, open, now }: AlertsPageProps) {
  const [recent, setRecent] = useState<Recent>({ status: 'loading' });
  const openKey = open.map((alert) => alert.id).join(',');

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
        {sorted.length === 0 ? (
          <p class="waiting">No open alerts</p>
        ) : (
          <ul class="alert-list">
            {sorted.map((alert) => (
              <AlertRow key={alert.id} alert={alert} plugins={config.plugins} now={t} />
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
                  <AlertRow key={alert.id} alert={alert} plugins={config.plugins} now={t} />
                ))}
              </ul>
            </>
          ))}
      </section>
      <section aria-labelledby="alerts-rules">
        <h2 id="alerts-rules">Rules</h2>
        <ul class="rule-list">
          {(config.rules ?? []).map((rule) => (
            <li key={rule.id} data-severity={rule.severity}>
              <span>{describeRule(rule, config.plugins)}</span>
              <span class="alert-severity">
                <StatusIcon level={rule.severity} />
                {rule.severity === 'critical' ? 'Critical' : 'Warning'}
              </span>
              <span class="rule-source">{rule.source}</span>
            </li>
          ))}
        </ul>
        <p class="note">
          Rules are edited in the file named by PIPULSE_ALERTS_FILE, then PiPulse is restarted.
          Editing them here comes with the Settings page.
        </p>
      </section>
    </div>
  );
}
