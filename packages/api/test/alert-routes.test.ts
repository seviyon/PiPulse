import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { clearAlert, createRuleSource, raiseAlert, type RuleSource } from '@pipulse/alerts';
import { hashPassword, parsePasswordHash, type PasswordHash } from '../src/auth.js';
import { buildServer, createLiveFeed } from '../src/index.js';

const DAY = 86_400_000;
const metrics = [
  'cpu_load',
  'load_1',
  'cpu_temperature',
  'throttled',
  'swap_used',
  'swap_io',
  'disk_used',
  'boot_used'
].map((id) => ({ id, intervalMs: 10_000 }));
const busy = { metric: 'cpu_load', atLeast: 50, for: '1min', severity: 'warning', message: 'Busy' };

let passwordHash: PasswordHash;
beforeAll(async () => {
  passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
});

let db: PiPulseDb;
let source: RuleSource;
let recheck: ReturnType<typeof vi.fn>;
let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  db = openDb(':memory:');
  source = createRuleSource(db, {
    cores: 4,
    metrics,
    rawRetention: () => ({ ms: 2 * DAY, text: '2d' })
  });
  recheck = vi.fn();
  app = buildServer(db, {
    live: createLiveFeed(),
    auth: { passwordHash, failureDelayMs: 0 },
    alertRules: { source, recheck }
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'secret' }
  });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  db.close();
});

const put = (id: string, payload: object, headers: Record<string, string> = { cookie }) =>
  app.inject({ method: 'PUT', url: `/api/alerts/rules/${id}`, headers, payload });
const del = (id: string) =>
  app.inject({ method: 'DELETE', url: `/api/alerts/rules/${id}`, headers: { cookie } });
const configRules = async () =>
  ((await app.inject({ method: 'GET', url: '/api/config' })).json().rules as { id: string }[]).map(
    (r) => r.id
  );

describe('rule routes', () => {
  it('lists every rule for the editor', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/alerts/rules' });
    expect(res.statusCode).toBe(200);
    expect(res.json().rules.find((e: { id: string }) => e.id === 'cpu_busy')).toMatchObject({
      kind: 'built-in',
      saved: false
    });
  });

  it('adds a rule, puts it in force at once, and rechecks', async () => {
    const res = await put('test_busy', busy);
    expect(res.statusCode).toBe(200);
    expect(res.json().rules.find((e: { id: string }) => e.id === 'test_busy')).toMatchObject({
      kind: 'added'
    });
    expect(await configRules()).toContain('test_busy');
    expect(recheck).toHaveBeenCalledOnce();
  });

  it('answers per-field errors, including unknown fields and a too-long look-back', async () => {
    expect((await put('x', { ...busy, severity: 'loud' })).json()).toEqual({
      errors: { severity: 'severity must be warning or critical' }
    });
    const unknown = await put('x', { ...busy, bogus: 1 });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ errors: { bogus: 'unknown field "bogus"' } });
    expect((await put('x', { ...busy, for: '3d' })).json().errors.for).toMatch(
      /raw retention \(2d\)/
    );
    expect((await put('x', { ...busy, id: 'y' })).json().errors.id).toBeDefined();
    expect((await put('Bad', busy)).statusCode).toBe(400);
    expect(recheck).not.toHaveBeenCalled();
  });

  it('refuses a body over 4 KB', async () => {
    const res = await put('x', { ...busy, message: 'a'.repeat(5000) });
    expect(res.statusCode).toBe(413);
  });

  it('disables a built-in and reverts it', async () => {
    expect((await put('cpu_busy', { disabled: true })).statusCode).toBe(200);
    expect(await configRules()).not.toContain('cpu_busy');
    expect((await del('cpu_busy')).statusCode).toBe(200);
    expect(await configRules()).toContain('cpu_busy');
    expect((await del('cpu_busy')).statusCode).toBe(404);
  });

  it('needs a session, and a password to be configured', async () => {
    expect((await put('test_busy', busy, {})).statusCode).toBe(401);
    const readOnly = buildServer(db, { alertRules: { source } });
    const res = await readOnly.inject({
      method: 'PUT',
      url: '/api/alerts/rules/test_busy',
      payload: busy
    });
    expect(res.statusCode).toBe(403);
    await readOnly.close();
  });
});

describe('POST /api/alerts/:id/acknowledge', () => {
  const raise = () =>
    raiseAlert(db, {
      ruleId: 'cpu_hot',
      metric: 'cpu_temperature',
      severity: 'critical',
      message: 'Hot',
      value: 85,
      raisedAt: 1000
    });
  const ack = (id: number | string, headers: Record<string, string> = { cookie }) =>
    app.inject({ method: 'POST', url: `/api/alerts/${id}/acknowledge`, headers });

  it('acknowledges an open alert once', async () => {
    const alert = raise();
    const first = await ack(alert.id);
    expect(first.statusCode).toBe(200);
    const at = first.json().acknowledgedAt;
    expect(at).toEqual(expect.any(Number));
    expect((await ack(alert.id)).json().acknowledgedAt).toBe(at);
  });

  it('answers 409 for a cleared alert, 404 for an unknown one, 401 without a session', async () => {
    const alert = raise();
    expect((await ack(alert.id, {})).statusCode).toBe(401);
    clearAlert(db, alert.id, 2000, 'condition');
    expect((await ack(alert.id)).statusCode).toBe(409);
    expect((await ack(999)).statusCode).toBe(404);
    expect((await ack('abc')).statusCode).toBe(400);
  });
});

describe('/api/live notices', () => {
  it('pushes the rules in force after a change and an acknowledgement', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
    const messages: { type: string; event?: string; rules?: { id: string }[] }[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await once(socket, 'open');

    await put('test_busy', busy);
    const alert = raiseAlert(db, {
      ruleId: 'cpu_hot',
      metric: 'cpu_temperature',
      severity: 'critical',
      message: 'Hot',
      value: 85,
      raisedAt: 1000
    });
    await app.inject({
      method: 'POST',
      url: `/api/alerts/${alert.id}/acknowledge`,
      headers: { cookie }
    });

    await vi.waitFor(() =>
      expect(messages.map((m) => m.type)).toEqual(['snapshot', 'rules', 'alert'])
    );
    expect(messages[1]!.rules!.map((r) => r.id)).toContain('test_busy');
    expect(messages[2]!.event).toBe('acknowledged');
    socket.close();
  });
});
