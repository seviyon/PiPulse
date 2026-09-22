import Fastify, { type FastifyInstance } from 'fastify';
import { getHistory, getLatest, type PiPulseDb } from '@pipulse/storage';

interface HistoryQuery {
  from?: string;
  to?: string;
}

/**
 * Builds (but does not start) the PiPulse Fastify server bound to `db`.
 * Kept separate from `server.ts`'s listen() call so tests can exercise
 * routes with Fastify's `inject()`, no open port required.
 */
export function buildServer(db: PiPulseDb): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/api/metrics/latest', async () => getLatest(db));

  app.get<{ Params: { id: string }; Querystring: HistoryQuery }>(
    '/api/metrics/:id/history',
    async (request, reply) => {
      const { id } = request.params;
      const now = Date.now();
      const from = request.query.from ? Number(request.query.from) : now - 60 * 60 * 1000;
      const to = request.query.to ? Number(request.query.to) : now;

      if (Number.isNaN(from) || Number.isNaN(to)) {
        return reply.status(400).send({ error: 'from/to must be unix ms timestamps' });
      }

      return getHistory(db, id, from, to);
    }
  );

  return app;
}
