import { hostname, uptime } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import {
  chooseResolution,
  getHistory,
  getLatest,
  getSeries,
  type PiPulseDb,
  type Resolution,
  type RetentionPolicy,
  type Sample
} from '@pipulse/storage';
import { listAlerts, openAlerts, type AlertEvent, type Rule } from '@pipulse/alerts';
import { registerAuth, type AuthOptions } from './auth-routes.js';
import { isAllowedOrigin } from './origin.js';

export type { AuthOptions } from './auth-routes.js';

/** What the API exposes about each collector plugin via /api/config. */
export interface PluginInfo {
  id: string;
  label: string;
  unit: string;
  intervalMs: number;
}

export interface DeviceInfo {
  hostname: string;
  platform: string;
  arch: string;
  /** Richer details when the server can read them (see the collector's readDeviceInfo). */
  model?: string;
  os?: string;
  kernel?: string;
  memoryTotalMb?: number;
  cpus?: number;
}

/** An in-process publish/subscribe channel; the API never imports the producers directly. */
export interface Feed<T> {
  /** Registers a listener; returns a function that removes it. */
  subscribe(listener: (value: T) => void): () => void;
}

/** Live samples for the /api/live WebSocket. */
export type LiveFeed = Feed<Sample>;

export function createFeed<T>(): Feed<T> & { publish(value: T): void } {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(value) {
      for (const listener of listeners) {
        try {
          listener(value);
        } catch {
          // One broken subscriber (e.g. a socket mid-close) must not starve the others.
        }
      }
    }
  };
}

/** An in-process LiveFeed the scheduler publishes into. */
export function createLiveFeed(): LiveFeed & { publish(sample: Sample): void } {
  return createFeed<Sample>();
}

export interface ServerOptions {
  plugins?: PluginInfo[];
  device?: DeviceInfo;
  live?: LiveFeed;
  /**
   * How often /api/live pings each client. A client that hasn't answered
   * the previous ping by the next one is dropped, so connections that
   * vanished without a close (sleeping laptop, dropped Wi-Fi) don't leak.
   */
  heartbeatMs?: number;
  /** Drop a /api/live client once this many bytes are queued unsent to it. */
  maxBufferedBytes?: number;
  /**
   * Browser origins allowed to open /api/live besides the server's own
   * host (e.g. "https://pipulse.lan"). Browsers don't apply the same-origin
   * policy to WebSockets, so without this check any page could read the feed.
   */
  allowedOrigins?: string[];
  /** Retention the housekeeping job applies; /series never picks a resolution it has pruned. */
  retention?: RetentionPolicy;
  /** Directory holding the built dashboard (packages/web/dist); omitted = API only. */
  webRoot?: string;
  /** Time since boot in ms; defaults to os.uptime(). Injectable for tests. */
  uptimeMs?: () => number;
  /** The effective alert rules, served in /api/config for the dashboard. */
  rules?: Rule[];
  /** Alert raises and clears, pushed to /api/live clients. */
  alertFeed?: Feed<AlertEvent>;
  /** Sign-in and read protection; unset = read-only with public reads. */
  auth?: AuthOptions;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

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

const alertsQuerySchema = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['active', 'cleared', 'all'] },
    from: { type: 'integer', minimum: 0 },
    to: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 1000 }
  },
  additionalProperties: false
} as const;

/**
 * Builds (but does not start) the PiPulse Fastify server bound to `db`.
 * Kept separate from `server.ts`'s listen() call so tests can exercise
 * routes with Fastify's `inject()`/`injectWS()`, no open port required.
 */
export function buildServer(db: PiPulseDb, options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const allowedOrigins = options.allowedOrigins ?? [];
  const auth = registerAuth(app, { ...options.auth, allowedOrigins });
  const plugins = options.plugins ?? [];
  const device = options.device ?? {
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch
  };

  app.get('/health', async () => ({ status: 'ok' }));

  const readUptimeMs = options.uptimeMs ?? (() => uptime() * 1000);

  // serverTime lets the dashboard measure staleness and pick history windows
  // on the Pi's clock rather than the viewer's, which may disagree. Uptime is
  // sent as a duration, read fresh per request, not as a boot timestamp: the
  // Pi has no RTC, so a boot time computed before NTP syncs stays wrong by
  // however far the clock later jumps.
  app.get('/api/config', async () => ({
    device,
    plugins,
    serverTime: Date.now(),
    uptimeMs: readUptimeMs(),
    rules: options.rules ?? []
  }));

  app.get('/api/metrics/latest', async () => getLatest(db));

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
      const resolution =
        requested === 'auto'
          ? chooseResolution(db, request.params.id, from, to, now, options.retention)
          : requested;
      return { resolution, points: getSeries(db, request.params.id, from, to, resolution) };
    }
  );

  app.get<{
    Querystring: {
      state?: 'active' | 'cleared' | 'all';
      from?: number;
      to?: number;
      limit?: number;
    };
  }>('/api/alerts', { schema: { querystring: alertsQuerySchema } }, async (request, reply) => {
    const to = request.query.to ?? Date.now();
    const from = request.query.from ?? to - 30 * 24 * 60 * 60 * 1000;
    if (from > to) {
      return reply.status(400).send({ error: 'from must not be after to' });
    }
    return listAlerts(db, {
      state: request.query.state ?? 'all',
      from,
      to,
      limit: request.query.limit ?? 100
    });
  });

  const live = options.live;
  if (live) {
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;

    void app.register(websocket);
    // The plugin's own preClose sends each client a graceful close, and the
    // HTTP server then waits for the handshake — up to ws's 30 s timeout for
    // a client that never answers. Terminate instead so shutdown is prompt.
    app.addHook('preClose', (done) => {
      for (const client of app.websocketServer.clients) client.terminate();
      done();
    });

    void app.register(async (scope) => {
      scope.get(
        '/api/live',
        {
          websocket: true,
          preValidation: async (request, reply) => {
            if (!isAllowedOrigin(request.headers.origin, request.headers.host, allowedOrigins)) {
              return reply.status(403).send({ error: 'origin not allowed' });
            }
          }
        },
        (socket, request) => {
          if (auth.protectReads && !auth.signedIn(request)) {
            socket.close(4401, 'sign in required');
            return;
          }
          socket.send(
            JSON.stringify({ type: 'snapshot', samples: getLatest(db), alerts: openAlerts(db) })
          );

          const send = (message: object) => {
            // A client that stopped reading would otherwise queue messages forever.
            if (socket.bufferedAmount > maxBufferedBytes) {
              socket.terminate();
              return;
            }
            socket.send(JSON.stringify(message));
          };
          const unsubscribe = live.subscribe((sample) => send({ type: 'sample', ...sample }));
          const unsubscribeAlerts =
            options.alertFeed?.subscribe((event) =>
              send({ type: 'alert', event: event.type, alert: event.alert })
            ) ?? (() => {});

          let alive = true;
          socket.on('pong', () => {
            alive = true;
          });
          const heartbeat = setInterval(() => {
            if (!alive) {
              socket.terminate();
              return;
            }
            alive = false;
            socket.ping();
          }, heartbeatMs);

          socket.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
            unsubscribeAlerts();
          });
        }
      );
    });
  }

  if (options.webRoot) {
    void app.register(fastifyStatic, { root: options.webRoot });
  }

  return app;
}
