import { startAlerts as realStartAlerts } from '@pipulse/alerts';

// The module hook serves this file in place of '@pipulse/alerts' to the server only.
export * from '@pipulse/alerts';

export const ALERT_INTERVAL_ENV = 'PIPULSE_E2E_ALERT_INTERVAL_MS';

/** The real engine, checking every second (or ALERT_INTERVAL_ENV) instead of every 15, so raises and clears land quickly. */
export const startAlerts: typeof realStartAlerts = (db, options) =>
  realStartAlerts(db, {
    ...options,
    intervalMs: Number(process.env[ALERT_INTERVAL_ENV] ?? 1000)
  });
