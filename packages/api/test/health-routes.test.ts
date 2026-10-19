import { uptime } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { hostName } from '@pipulse/tls';
import { buildServer } from '../src/index.js';
import type { TlsView } from '../src/index.js';
import { createHealth } from '../src/health.js';
import { nodeSupport } from '../src/version.js';

let db: PiPulseDb;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.close());

const get = (url: string, options: Parameters<typeof buildServer>[1] = {}) =>
  buildServer(db, options).inject({ method: 'GET', url });

interface Config {
  version: string;
  node: unknown;
  device: Record<string, unknown>;
  plugins: unknown[];
  serverTime: number;
  uptimeMs: number;
  rules: unknown[];
  tls: unknown;
}

describe('GET /health', () => {
  it('is the bare liveness answer', async () => {
    const res = await get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/config', () => {
  it('describes a bare server: a dev build of this machine, no plugins or rules, plain HTTP', async () => {
    const before = Date.now();
    const uptimeBefore = uptime() * 1000;
    const body = (await get('/api/config')).json() as Config;
    const uptimeAfter = uptime() * 1000;
    expect(body.version).toBe('dev');
    expect(body.node).toEqual(nodeSupport());
    expect(body.device).toEqual({
      hostname: hostName(),
      platform: process.platform,
      arch: process.arch
    });
    expect(body.plugins).toEqual([]);
    expect(body.rules).toEqual([]);
    expect(body.tls).toEqual({ mode: 'http', reason: 'default', inContainer: false });
    // The Pi's clock and time since boot are read on every request, never cached.
    expect(body.serverTime).toBeGreaterThanOrEqual(before);
    expect(body.serverTime).toBeLessThanOrEqual(Date.now());
    expect(body.uptimeMs).toBeGreaterThanOrEqual(uptimeBefore);
    expect(body.uptimeMs).toBeLessThanOrEqual(uptimeAfter);
  });

  it('serves what it is given', async () => {
    const tls: TlsView = { mode: 'http', reason: 'env', inContainer: true };
    const node = { version: '22.0.0', line: 22, supportEnds: '2027-04-30', ended: false };
    const body = (
      await get('/api/config', {
        version: '1.2.3',
        node: node as never,
        device: { hostname: 'io', platform: 'linux', arch: 'arm', cpus: 4 },
        plugins: [{ id: 'cpu_load', label: 'CPU load', unit: '%', intervalMs: 5000 }],
        rules: [{ id: 'from_options' } as never],
        uptimeMs: () => 42_000,
        tls: () => tls
      })
    ).json() as Config;
    expect(body.version).toBe('1.2.3');
    expect(body.node).toEqual(node);
    expect(body.device).toEqual({ hostname: 'io', platform: 'linux', arch: 'arm', cpus: 4 });
    expect(body.plugins).toEqual([
      { id: 'cpu_load', label: 'CPU load', unit: '%', intervalMs: 5000 }
    ]);
    expect(body.rules).toEqual([{ id: 'from_options' }]);
    expect(body.uptimeMs).toBe(42_000);
    expect(body.tls).toEqual(tls);
  });

  it('serves the rules in force from the rule source, in preference to a fixed list', async () => {
    const source = { read: () => ({ rules: [{ id: 'in_force' }] }) };
    const body = (
      await get('/api/config', {
        rules: [{ id: 'from_options' } as never],
        alertRules: { source: source as never }
      })
    ).json() as Config;
    expect(body.rules).toEqual([{ id: 'in_force' }]);
  });
});

describe('GET /api/health', () => {
  it('answers 200 with the monitoring state of a live database', async () => {
    const res = await get('/api/health');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; monitoring: string; transport: string };
    expect(body.monitoring).toBe('ok');
    expect(body.transport).toBe('http');
  });

  it('answers 503 when monitoring has failed (no readings have ever arrived)', async () => {
    const health = createHealth(db, { trackReadings: true });
    const res = await get('/api/health', { health });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { status: string }).status).toBe('failing');
  });
});
