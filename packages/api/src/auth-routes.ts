import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  clearedSessionCookie,
  createLoginLimiter,
  createSessions,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  verifyPassword,
  type LoginLimiter,
  type PasswordHash,
  type Sessions
} from './auth.js';
import { isAllowedOrigin } from './origin.js';

export interface AuthOptions {
  /** Unset: read-only, every write answers 403. */
  passwordHash?: PasswordHash;
  /** Require a session for every /api read and the WebSocket too. */
  protectReads?: boolean;
  sessions?: Sessions;
  limiter?: LoginLimiter;
  /** How long a failed sign-in waits before answering (default 1 s). */
  failureDelayMs?: number;
}

/** Reads anyone may make even with read protection on. */
const PUBLIC_READS = new Set(['/api/session']);

const loginSchema = {
  type: 'object',
  required: ['password'],
  properties: { password: { type: 'string', maxLength: 1024 } },
  additionalProperties: false
} as const;

/**
 * The one place that decides who may do what. Routes never check auth
 * themselves: this hook runs first for every request.
 */
export function registerAuth(
  app: FastifyInstance,
  options: AuthOptions & { allowedOrigins: string[] }
): { signedIn(request: FastifyRequest): boolean; protectReads: boolean } {
  const sessions = options.sessions ?? createSessions();
  const limiter = options.limiter ?? createLoginLimiter();
  const failureDelayMs = options.failureDelayMs ?? 1000;
  const protectReads = options.protectReads ?? false;
  const passwordHash = options.passwordHash;
  const sessionId = (request: FastifyRequest) => readCookie(request.headers.cookie, SESSION_COOKIE);
  const signedIn = (request: FastifyRequest) => sessions.valid(sessionId(request));
  const secure = (request: FastifyRequest) => request.protocol === 'https';

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0]!;
    if (!path.startsWith('/api/')) return;
    if (request.method === 'GET' || request.method === 'HEAD') {
      // The WebSocket handler closes an unauthorised socket with 4401 itself.
      if (!protectReads || PUBLIC_READS.has(path) || path === '/api/live') return;
      if (!signedIn(request)) return reply.status(401).send({ error: 'sign in required' });
      return;
    }
    if (!isAllowedOrigin(request.headers.origin, request.headers.host, options.allowedOrigins)) {
      return reply.status(403).send({ error: 'origin not allowed' });
    }
    if (!passwordHash) {
      return reply.status(403).send({ error: 'editing is disabled: no admin password configured' });
    }
    if (path === '/api/login' || path === '/api/logout') return;
    if (!signedIn(request)) return reply.status(401).send({ error: 'sign in required' });
  });

  app.get('/api/session', async (request) => ({
    editable: passwordHash !== undefined,
    signedIn: signedIn(request),
    protectReads
  }));

  app.post<{ Body: { password: string } }>(
    '/api/login',
    { schema: { body: loginSchema } },
    async (request, reply) => {
      if (limiter.blocked(request.ip)) {
        return reply
          .status(429)
          .send({ error: 'too many sign-in attempts; try again in 15 minutes' });
      }
      // The hook has already answered 403 when there is no password.
      if (!(await verifyPassword(request.body.password, passwordHash!))) {
        limiter.fail(request.ip);
        await delay(failureDelayMs);
        return reply.status(401).send({ error: 'sign-in failed' });
      }
      limiter.succeed(request.ip);
      reply.header('set-cookie', sessionCookie(sessions.create(), secure(request)));
      return { signedIn: true };
    }
  );

  app.post('/api/logout', async (request, reply) => {
    sessions.end(sessionId(request));
    reply.header('set-cookie', clearedSessionCookie(secure(request)));
    return { signedIn: false };
  });

  return { signedIn, protectReads };
}
