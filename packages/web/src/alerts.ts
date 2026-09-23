import type { Alert } from './types.js';

/** Applies one live raise or clear to the open alerts, newest first. */
export function applyAlertEvent(open: Alert[], event: 'raised' | 'cleared', alert: Alert): Alert[] {
  const rest = open.filter((a) => a.id !== alert.id);
  return event === 'raised' ? [alert, ...rest] : rest;
}

/** The alert to show for a group: critical before warning, then the one open longest. */
export function worstAlert(alerts: Alert[]): Alert | undefined {
  return [...alerts].sort(
    (a, b) =>
      Number(b.severity === 'critical') - Number(a.severity === 'critical') ||
      a.raisedAt - b.raisedAt
  )[0];
}
