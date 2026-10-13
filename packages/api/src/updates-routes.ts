import type { FastifyInstance } from 'fastify';
import type { Updates, UpdatesView } from './updates.js';

const UNSUPPORTED: UpdatesView = { state: 'unsupported', reason: 'no-apt' };

/**
 * What `apt-get upgrade` would do, read-only. `POST /api/updates/check` is a write like any
 * other (it needs a session and a same-host Origin from the auth hook): it runs the check now,
 * at most once per MANUAL_GAP_MS.
 */
export function registerUpdatesRoutes(app: FastifyInstance, updates: Updates | undefined): void {
  app.get('/api/updates', async () => updates?.view() ?? UNSUPPORTED);
  app.post('/api/updates/check', async () =>
    updates ? updates.check({ manual: true }) : UNSUPPORTED
  );
}
