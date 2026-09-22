import { hostname } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { getHistory, getLatest, type PiPulseDb, type Sample } from '@pipulse/storage';

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
}

/**
 * A source of live samples for the /api/live WebSocket. Kept as a small
 * interface so the API never depends on the collector's scheduler directly.
 */
export interface LiveFeed {
  /** Registers a listener; returns a function that removes it. */
  subscribe(listener: (sample: Sample) => void): () => void;
}

/** An in-process LiveFeed the scheduler publishes into. */
export function createLiveFeed(): LiveFeed & { publish(sample: Sample): void } {
  const listeners = new Set<(sample: Sample) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(sample) {
      for (const listener of listeners) {
        try {
          listener(sample);
        } catch {
          // One broken subscriber (e.g. a socket mid-close) must not starve the others.
        }
      }
    }
  };
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
  /** Directory holding the built dashboard (packages/web/dist); omitted = API only. */
  webRoot?: string;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Accepts non-browser clients (no Origin header), same-host pages, and
 * explicitly allowed origins; rejects every other cross-site page.
 */
function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowed: string[]
): boolean {
  if (origin === undefined) return true;
  if (allowed.includes(origin)) return true;
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    // e.g. the literal "null" origin sent by sandboxed iframes and file:// pages
    return false;
  }
}

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

/**
 * Builds (but does not start) the PiPulse Fastify server bound to `db`.
 * Kept separate from `server.ts`'s listen() call so tests can exercise
 * routes with Fastify's `inject()`/`injectWS()`, no open port required.
 */
export function buildServer(db: PiPulseDb, options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const plugins = options.plugins ?? [];
  const device = options.device ?? {
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch
  };

  app.get('/health', async () => ({ status: 'ok' }));

  // serverTime lets the dashboard measure staleness and pick history windows
  // on the Pi's clock rather than the viewer's, which may disagree.
  app.get('/api/config', async () => ({ device, plugins, serverTime: Date.now() }));

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

  const live = options.live;
  if (live) {
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    const allowedOrigins = options.allowedOrigins ?? [];

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
        (socket) => {
          socket.send(JSON.stringify({ type: 'snapshot', samples: getLatest(db) }));

          const unsubscribe = live.subscribe((sample) => {
            // A client that stopped reading would otherwise queue samples forever.
            if (socket.bufferedAmount > maxBufferedBytes) {
              socket.terminate();
              return;
            }
            socket.send(JSON.stringify({ type: 'sample', ...sample }));
          });

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
