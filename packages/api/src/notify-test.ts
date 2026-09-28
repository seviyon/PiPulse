import { hostname } from 'node:os';
import {
  createWebhookAction,
  parseNotifyConfig,
  readNotifyFile,
  renderPayload
} from '@pipulse/notify';
import type { Alert } from '@pipulse/alerts';

/**
 * Sends a test message to each webhook in PIPULSE_NOTIFY_FILE (or the one
 * named) directly, not through the outbox, and prints the outcome:
 *   node packages/api/dist/notify-test.js [webhook-id]
 * Exits 1 if any send failed or the file is invalid, 2 if the variable is unset.
 */
const path = process.env['PIPULSE_NOTIFY_FILE'];
if (!path) {
  console.error('PIPULSE_NOTIFY_FILE is not set');
  process.exit(2);
}
let webhooks;
try {
  webhooks = parseNotifyConfig(readNotifyFile(path));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const only = process.argv[2];
const chosen = only ? webhooks.filter((w) => w.id === only) : webhooks;
if (chosen.length === 0) {
  console.error(only ? `no webhook "${only}" in ${path}` : `no webhooks in ${path}`);
  process.exit(1);
}
const sample: Alert = {
  id: 0,
  ruleId: 'test',
  metric: 'cpu_temperature',
  severity: 'warning',
  message: 'PiPulse test notification',
  value: 42,
  raisedAt: Date.now(),
  clearedAt: null,
  clearedBy: null,
  acknowledgedAt: null,
  ruleHash: null
};
const context = {
  hostname: hostname(),
  metrics: [{ id: 'cpu_temperature', label: 'CPU temperature', unit: '°C' }]
};
let failed = false;
for (const webhook of chosen) {
  try {
    await createWebhookAction(webhook).deliver(
      renderPayload(webhook.body, 'test', sample, context),
      AbortSignal.timeout(webhook.timeoutMs)
    );
    console.log(`${webhook.id}: delivered`);
  } catch (error) {
    failed = true;
    console.log(
      `${webhook.id}: failed (${error instanceof Error ? error.message : String(error)})`
    );
  }
}
process.exit(failed ? 1 : 0);
