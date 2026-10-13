import type { FastifyInstance } from 'fastify';
import type { Updates, UpdatesView } from './updates.js';
import type { Upgrade } from './upgrade.js';

const UNSUPPORTED: UpdatesView = { state: 'unsupported', reason: 'no-apt' };

/**
 * What `apt-get upgrade` would do, read-only, plus the state of the opt-in upgrade button.
 * `POST /api/updates/check` and `POST /api/updates/upgrade` are writes like any other (a session
 * and a same-host Origin from the auth hook). The check runs now, at most once per MANUAL_GAP_MS;
 * the upgrade only rings a doorbell, and the root helper decides whether to act.
 */
export function registerUpdatesRoutes(
  app: FastifyInstance,
  updates: Updates | undefined,
  upgrade?: Upgrade
): void {
  let wasBusy = false;
  const withUpgrade = (view: UpdatesView) => ({
    ...view,
    ...(upgrade ? { upgrade: upgrade.view() } : {})
  });
  app.get('/api/updates', async () => {
    const view = updates?.view() ?? UNSUPPORTED;
    const current = upgrade?.view();
    // An upgrade just ended: what was waiting has changed, so look again.
    const busy = current?.available === true && ['requested', 'running'].includes(current.state);
    if (wasBusy && !busy && updates) void updates.check();
    wasBusy = busy;
    return withUpgrade(view);
  });
  app.post('/api/updates/check', async () =>
    withUpgrade(updates ? await updates.check({ manual: true }) : UNSUPPORTED)
  );
  app.post(
    '/api/updates/upgrade',
    {
      schema: {
        body: {
          type: 'object',
          required: ['confirm'],
          properties: { confirm: { const: 'upgrade' } },
          additionalProperties: false
        }
      }
    },
    async (_request, reply) => {
      const result = upgrade?.request() ?? {
        ok: false as const,
        status: 403 as const,
        error: 'upgrading from here is not turned on'
      };
      if (!result.ok) return reply.status(result.status).send({ error: result.error });
      wasBusy = true;
      return reply.status(202).send({ upgrade: upgrade!.view() });
    }
  );
}
