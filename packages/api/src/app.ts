import type { Server as HttpsServer } from 'node:https';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PiPulseDb } from '@pipulse/storage';
import { registerAlertRoutes, type Notice } from './alert-routes.js';
import { registerAuth } from './auth-routes.js';
import { registerDashboard, registerLiveRoutes } from './live-routes.js';
import { registerHealthRoutes } from './health-routes.js';
import { registerMetricsRoutes } from './metrics-routes.js';
import { registerNotifyRoutes } from './notify-routes.js';
import { registerUpdatesRoutes } from './updates-routes.js';
import { isAllowedHost } from './host.js';
import { answerPlainHttp } from './plain-http.js';
import { registerSettingsRoutes } from './settings-routes.js';
import { createFeed } from './feed.js';
import type { ServerOptions } from './options.js';

/** Everything the dashboard needs comes from its own origin: scripts, styles, fonts, the API and the WebSocket. */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * Limits on what one client can hold open. Fastify 5 turns off Node's request timeout, so without
 * these a client that sends good headers and then trickles a body keeps its socket for as long as
 * it likes; every socket also costs a file descriptor, and systemd gives the service 4096.
 * A dashboard needs a WebSocket and a few short requests per open tab.
 */
export const DEFAULT_LIMITS = {
  /** Time to receive a whole request (headers and body). */
  requestTimeoutMs: 30_000,
  /** Idle time before a plain connection is dropped (an upgraded WebSocket is exempt: `ws` clears it). */
  connectionTimeoutMs: 60_000,
  /** Open connections at once; the next one is refused until one closes. */
  maxConnections: 256
};

/**
 * Builds (but does not start) the PiPulse Fastify server bound to `db`.
 * Kept separate from `server.ts`'s listen() call so tests can exercise
 * routes with Fastify's `inject()`/`injectWS()`, no open port required.
 */
export function buildServer(db: PiPulseDb, options: ServerOptions = {}): FastifyInstance {
  // Typed as the HTTP instance: routes and inject() are identical, and
  // server.ts reaches the https.Server (setSecureContext) through app.server.
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  // Node enforces requestTimeout only when it sweeps its connections, every 30 s by default: a
  // 30 s limit would then fire anywhere between 30 and 60 s. Sweeping more often makes it fire on time.
  const connectionsCheckingInterval = Math.max(100, Math.min(5000, limits.requestTimeoutMs / 2));
  const timeouts = {
    requestTimeout: limits.requestTimeoutMs,
    connectionTimeout: limits.connectionTimeoutMs
  };
  const app = (options.https
    ? Fastify({
        logger: false,
        ...timeouts,
        https: { ...options.https, minVersion: 'TLSv1.2', connectionsCheckingInterval }
      })
    : Fastify({
        logger: false,
        ...timeouts,
        http: { connectionsCheckingInterval }
      })) as unknown as FastifyInstance;
  app.server.maxConnections = limits.maxConnections;
  // Node ignores requestTimeout unless headersTimeout (60 s) is smaller than it.
  app.server.headersTimeout = Math.min(app.server.headersTimeout, limits.requestTimeoutMs / 2);
  // Whatever answers a request that asked to upgrade the connection must also end the connection.
  // Node hands every `Connection: Upgrade` request to @fastify/websocket, which closes the socket
  // itself only for routes it handled (from its own hooks, registered after ours). A refusal by
  // the host check, the sign-in check or the Origin check, or a plain 404, would otherwise leave
  // the socket open for good, and a few hundred of them use up the process's file descriptors.
  // A WebSocket that was accepted is hijacked and never "finishes", so it is not touched.
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.upgrade) reply.raw.once('finish', () => reply.raw.destroy());
  });
  // An old http:// bookmark gets a fixed hint page instead of a dropped connection.
  if (options.https) (app.server as unknown as HttpsServer).on('tlsClientError', answerPlainHttp);
  if (options.https && options.hstsSeconds !== undefined) {
    const hsts = `max-age=${options.hstsSeconds}`;
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('strict-transport-security', hsts);
      return payload;
    });
  }
  // What a browser is told about the pages and data it receives, on every response (the answers of
  // the host and auth hooks too): no script or style that is not this server's own, no framing (the
  // dashboard has buttons that change settings and rules, and a same-site page could frame it),
  // no sniffing, no referrer, and JSON that is never kept in a cache. The policy is as tight as the
  // built dashboard allows: it loads and runs with this exact header in Chromium and WebKit.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    // The matched route when there is one (a path written as /%61pi/... only matches decoded).
    const route = request.routeOptions?.url ?? '';
    if (route.startsWith('/api/') || request.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });
  const allowedOrigins = options.allowedOrigins ?? [];
  const allowedHosts = options.allowedHosts ?? [];
  if (allowedHosts.length > 0) {
    app.addHook('onRequest', async (request, reply) => {
      if (!isAllowedHost(request.headers.host, allowedHosts)) {
        return reply.status(421).send({ error: 'host not allowed' });
      }
    });
  }
  const auth = registerAuth(app, { ...options.auth, allowedOrigins });
  const notices = createFeed<Notice>();

  registerHealthRoutes(app, db, options);

  registerMetricsRoutes(app, db, options);

  registerAlertRoutes(app, db, {
    ...(options.alertRules ? { rules: options.alertRules } : {}),
    publish: notices.publish
  });
  registerNotifyRoutes(app, options.notify);
  registerUpdatesRoutes(app, options.updates);

  if (options.settings) registerSettingsRoutes(app, db, options.settings);

  registerLiveRoutes(app, db, options, { auth, notices, allowedOrigins });
  registerDashboard(app, options.webRoot);

  return app;
}
