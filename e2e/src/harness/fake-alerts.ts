import { startAlerts as realStartAlerts } from '@pipulse/alerts';
import { ALERTS_MARKER } from './readings.js';

// The module hook serves this file in place of '@pipulse/alerts' to the server only.
export * from '@pipulse/alerts';

export const ALERT_INTERVAL_ENV = 'PIPULSE_E2E_ALERT_INTERVAL_MS';

/** The real engine, checking every second (or ALERT_INTERVAL_ENV) instead of every 15, so raises and clears land quickly. */
export const startAlerts: typeof realStartAlerts = (db, options) => {
  const intervalMs = Number(process.env[ALERT_INTERVAL_ENV] ?? 1000);
  if (!Number.isFinite(intervalMs) || intervalMs < 50) {
    throw new Error(`${ALERT_INTERVAL_ENV} must be a number of at least 50 ms`);
  }
  // Observable proof that the redirect applied: the launcher looks for this line.
  console.log(`${ALERTS_MARKER} checking every ${intervalMs} ms`);
  return realStartAlerts(db, { ...options, intervalMs });
};
