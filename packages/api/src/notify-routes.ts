import type { FastifyInstance } from 'fastify';
import type { WebhookStatus } from '@pipulse/notify';

/** Read-only webhook status for the Settings page; never the URL beyond its host, never headers. */
export function registerNotifyRoutes(
  app: FastifyInstance,
  notify: { status(): WebhookStatus[] } | undefined
): void {
  app.get('/api/notify', async () => notify?.status() ?? []);
}
