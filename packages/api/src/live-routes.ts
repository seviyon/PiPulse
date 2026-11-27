import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { openAlerts } from '@pipulse/alerts';
import { getLatest, type PiPulseDb } from '@pipulse/storage';
import type { Notice } from './alert-routes.js';
import type { registerAuth } from './auth-routes.js';
import { clientKey } from './auth.js';
import type { Feed } from './feed.js';
import { isAllowedOrigin } from './origin.js';
import type { ServerOptions } from './options.js';

/** The largest frame a /api/live client may send; the dashboard sends none. */
const MAX_CLIENT_FRAME_BYTES = 1024;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
// A dashboard tab holds one socket for as long as it is open, and the server refuses connections
// over DEFAULT_LIMITS.maxConnections: without these, one device could hold them all.
const DEFAULT_MAX_LIVE_CLIENTS = 64;
const DEFAULT_MAX_LIVE_CLIENTS_PER_ADDRESS = 16;

type LiveLimitName =
  'heartbeatMs' | 'maxBufferedBytes' | 'maxLiveClients' | 'maxLiveClientsPerAddress';

/** The WebSocket limits in force: what the options say, else the defaults. */
export function liveLimits(
  options: Pick<ServerOptions, LiveLimitName>
): Record<LiveLimitName, number> {
  return {
    heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
    maxLiveClients: options.maxLiveClients ?? DEFAULT_MAX_LIVE_CLIENTS,
    maxLiveClientsPerAddress:
      options.maxLiveClientsPerAddress ?? DEFAULT_MAX_LIVE_CLIENTS_PER_ADDRESS
  };
}

/** Whether a client has fallen too far behind to keep: more than the limit is queued unsent to it. */
export function fallenBehind(bufferedAmount: number, maxBufferedBytes: number): boolean {
  return bufferedAmount > maxBufferedBytes;
}

export interface LiveDeps {
  auth: ReturnType<typeof registerAuth>;
  notices: Feed<Notice>;
  allowedOrigins: string[];
}

/** The /api/live WebSocket: a snapshot on connect, then samples, alerts, rule edits and notices. */
export function registerLiveRoutes(
  app: FastifyInstance,
  db: PiPulseDb,
  options: Pick<ServerOptions, 'live' | 'alertFeed' | 'alertRules' | LiveLimitName>,
  { auth, notices, allowedOrigins }: LiveDeps
): void {
  const live = options.live;
  if (live) {
    const { heartbeatMs, maxBufferedBytes, maxLiveClients, maxLiveClientsPerAddress } =
      liveLimits(options);
    // Sockets held now, by address (an IPv6 host counts by its /64), until each has closed.
    const held = new Map<string, number>();
    let total = 0;
    const take = (address: string): (() => void) | undefined => {
      const mine = held.get(address) ?? 0;
      if (total >= maxLiveClients || mine >= maxLiveClientsPerAddress) return undefined;
      total++;
      held.set(address, mine + 1);
      return () => {
        total--;
        const left = held.get(address)! - 1;
        if (left === 0) held.delete(address);
        else held.set(address, left);
      };
    };

    // Clients only listen: any frame beyond a few bytes is refused (close code 1009) instead of
    // being buffered, as ws's default of 100 MiB would, once per connection.
    void app.register(websocket, { options: { maxPayload: MAX_CLIENT_FRAME_BYTES } });
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
          // First, so that a socket still waiting to finish its close below counts too. Dropped
          // without a closing handshake, which a client could leave unanswered; the dashboard
          // reconnects with its usual backoff.
          const release = take(clientKey(request.ip));
          if (!release) {
            socket.terminate();
            return;
          }
          socket.on('close', release);
          if (auth.protectReads && !auth.signedIn(request)) {
            socket.close(4401, 'sign in required');
            return;
          }
          // The rules in force ride along, so a client that reconnects after
          // missing a `rules` notice isn't left colouring tiles by stale rules.
          socket.send(
            JSON.stringify({
              type: 'snapshot',
              samples: getLatest(db, Date.now()),
              alerts: openAlerts(db),
              ...(options.alertRules ? { rules: options.alertRules.source.read().rules } : {})
            })
          );

          const send = (message: object) => {
            // A client that stopped reading would otherwise queue messages forever.
            if (fallenBehind(socket.bufferedAmount, maxBufferedBytes)) {
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
          const unsubscribeNotices = notices.subscribe(send);

          let alive = true;
          socket.on('pong', () => {
            alive = true;
          });
          const heartbeat = setInterval(() => {
            // A tab that signed out, or whose session ran out, must not keep receiving data.
            if (auth.protectReads && !auth.signedIn(request)) {
              socket.close(4401, 'sign in required');
              return;
            }
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
            unsubscribeNotices();
          });
        }
      );
    });
  }
}

/** The built dashboard, served after every API route is registered; omitted = API only. */
export function registerDashboard(app: FastifyInstance, webRoot: string | undefined): void {
  if (webRoot) {
    void app.register(fastifyStatic, { root: webRoot });
  }
}
