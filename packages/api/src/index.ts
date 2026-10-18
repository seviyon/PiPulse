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

export {
  healthBody,
  readGeneratedExtras,
  tlsView,
  type GeneratedExtras,
  type MetadataProblem,
  type TlsView
} from './tls-status.js';
export type { AuthOptions } from './auth-routes.js';
export type { AlertRulesOptions } from './alert-routes.js';
export { longestLookBack, rawRetentionProblem, type SettingsOptions } from './settings-routes.js';
export type { DeviceInfo, PluginInfo, ServerOptions } from './options.js';
export { createFeed, createLiveFeed, type Feed, type LiveFeed } from './feed.js';

/** Everything the dashboard needs comes from its own origin: scripts, styles, fonts, the API and the WebSocket. */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * Builds (but does not start) the PiPulse Fastify server bound to `db`.
 * Kept separate from `server.ts`'s listen() call so tests can exercise
 * routes with Fastify's `inject()`/`injectWS()`, no open port required.
 */
export function buildServer(db: PiPulseDb, options: ServerOptions = {}): FastifyInstance {
  // Typed as the HTTP instance: routes and inject() are identical, and
  // server.ts reaches the https.Server (setSecureContext) through app.server.
  const app = (options.https
    ? Fastify({ logger: false, https: { ...options.https, minVersion: 'TLSv1.2' } })
    : Fastify({ logger: false })) as unknown as FastifyInstance;
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
        // A refused WebSocket upgrade must close its socket itself: @fastify/websocket does that
        // from its own onRequest hook, which has not run yet when this one answers.
        if (request.headers.upgrade) {
          reply.raw.once('finish', () => reply.raw.socket?.destroy());
        }
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
