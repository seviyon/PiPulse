import type { FastifyInstance } from 'fastify';
import {
  chooseResolution,
  getHistory,
  getLatest,
  getSeries,
  MAX_RAW_ROWS,
  MAX_SERIES_ROWS,
  policyOf,
  rawRowsExceed,
  seriesRowsExceed,
  type PiPulseDb,
  type Resolution
} from '@pipulse/storage';
import type { ServerOptions } from './options.js';

/** What /history and raw /series answer (400) when a window holds more than MAX_RAW_ROWS readings. */
const TOO_MANY_RAW = `That window holds more than ${MAX_RAW_ROWS} raw readings: ask for a shorter window, or resolution=1m, 1h or 1d (or auto).`;

/** What /series answers (400) when a rolled-up window holds more than MAX_SERIES_ROWS points. */
const tooManySeries = (resolution: string) =>
  `That window holds more than ${MAX_SERIES_ROWS} points at resolution=${resolution}: ask for a shorter window, a coarser resolution (1h, 1d), or auto.`;

interface HistoryQuery {
  from?: number;
  to?: number;
}

const historyQuerySchema = {
  type: 'object',
  properties: {
    from: { type: 'integer', minimum: 0 },
    to: { type: 'integer', minimum: 0 }
  },
  additionalProperties: false
} as const;

const seriesQuerySchema = {
  type: 'object',
  properties: {
    ...historyQuerySchema.properties,
    resolution: { type: 'string', enum: ['auto', 'raw', '1m', '1h', '1d'] }
  },
  additionalProperties: false
} as const;

/** The metric readings: the newest of each, raw history, and rolled-up series. */
export function registerMetricsRoutes(
  app: FastifyInstance,
  db: PiPulseDb,
  options: Pick<ServerOptions, 'settings' | 'retention'>
): void {
  app.get('/api/metrics/latest', async () => getLatest(db, Date.now()));

  app.get<{ Params: { id: string }; Querystring: HistoryQuery }>(
    '/api/metrics/:id/history',
    { schema: { querystring: historyQuerySchema } },
    async (request, reply) => {
      const now = Date.now();
      const to = request.query.to ?? now;
      const from = request.query.from ?? to - 60 * 60 * 1000;

      if (from > to) {
        return reply.status(400).send({ error: 'from must not be after to' });
      }

      if (rawRowsExceed(db, request.params.id, from, to)) {
        return reply.status(400).send({ error: TOO_MANY_RAW });
      }
      return getHistory(db, request.params.id, from, to);
    }
  );

  app.get<{
    Params: { id: string };
    Querystring: HistoryQuery & { resolution?: Resolution | 'auto' };
  }>(
    '/api/metrics/:id/series',
    { schema: { querystring: seriesQuerySchema } },
    async (request, reply) => {
      const now = Date.now();
      const to = request.query.to ?? now;
      const from = request.query.from ?? to - 24 * 60 * 60 * 1000;

      if (from > to) {
        return reply.status(400).send({ error: 'from must not be after to' });
      }

      const requested = request.query.resolution ?? 'auto';
      const retention = options.settings
        ? policyOf(options.settings.getRetention())
        : options.retention;
      const resolution =
        requested === 'auto'
          ? chooseResolution(db, request.params.id, from, to, now, retention)
          : requested;
      if (resolution === 'raw' && rawRowsExceed(db, request.params.id, from, to)) {
        return reply.status(400).send({ error: TOO_MANY_RAW });
      }
      if (
        resolution !== 'raw' &&
        seriesRowsExceed(db, request.params.id, from, to, resolution, MAX_SERIES_ROWS)
      ) {
        return reply.status(400).send({ error: tooManySeries(resolution) });
      }
      return { resolution, points: getSeries(db, request.params.id, from, to, resolution) };
    }
  );
}
