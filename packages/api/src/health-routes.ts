import { uptime } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { hostName } from '@pipulse/tls';
import type { PiPulseDb } from '@pipulse/storage';
import { createHealth } from './health.js';
import type { ServerOptions } from './options.js';
import { healthBody, type TlsView } from './tls-status.js';
import { nodeSupport } from './version.js';

/** The liveness, health and config routes. */
export function registerHealthRoutes(
  app: FastifyInstance,
  db: PiPulseDb,
  options: ServerOptions
): void {
  const plugins = options.plugins ?? [];
  const device = options.device ?? {
    hostname: hostName(),
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
  const health = options.health ?? createHealth(db);
  const readTls =
    options.tls ?? ((): TlsView => ({ mode: 'http', reason: 'default', inContainer: false }));
  app.get('/api/health', async (_request, reply) => {
    const body = healthBody(health.check(), readTls(), options.auth?.passwordHash !== undefined);
    return body.status === 'failing' ? reply.status(503).send(body) : body;
  });

  const node = options.node ?? nodeSupport();
  app.get('/api/config', async () => ({
    version: options.version ?? 'dev',
    node,
    device,
    plugins,
    serverTime: Date.now(),
    uptimeMs: readUptimeMs(),
    rules: options.alertRules ? options.alertRules.source.read().rules : (options.rules ?? []),
    tls: readTls()
  }));
}
