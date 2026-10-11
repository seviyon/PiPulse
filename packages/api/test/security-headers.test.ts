import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { hashPassword, parsePasswordHash } from '../src/auth.js';
import { buildServer } from '../src/index.js';

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

let db: PiPulseDb;
let webRoot: string;
beforeEach(() => {
  db = openDb(':memory:');
  webRoot = mkdtempSync(join(tmpdir(), 'pipulse-web-'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>PiPulse</title>');
  mkdirSync(join(webRoot, 'assets'));
  writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log(1)');
});
afterEach(() => {
  db.close();
  rmSync(webRoot, { recursive: true, force: true });
});

const get = (url: string, options: Parameters<typeof buildServer>[1] = {}) =>
  buildServer(db, { webRoot, ...options }).inject({ method: 'GET', url });

describe('browser defenses on every response', () => {
  it.each([
    '/',
    '/assets/app.js',
    '/api/config',
    '/api/health',
    '/health',
    '/no/such/page',
    '/api/nothing'
  ])('%s: a strict CSP that also forbids framing, no sniffing, no referrer', async (url) => {
    const res = await get(url);
    expect(res.headers['content-security-policy']).toBe(CSP);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('also on the answers the auth hook and the host check give before a route runs', async () => {
    const passwordHash = parsePasswordHash(await hashPassword('x', { N: 1024, r: 8, p: 1 }));
    const unauthorised = await get('/api/config', { auth: { passwordHash, protectReads: true } });
    expect(unauthorised.statusCode).toBe(401);
    expect(unauthorised.headers['content-security-policy']).toBe(CSP);
    expect(unauthorised.headers['x-frame-options']).toBe('DENY');
    expect(unauthorised.headers['cache-control']).toBe('no-store');
    const wrongHost = await buildServer(db, { webRoot, allowedHosts: ['pi.example'] }).inject({
      url: '/',
      headers: { host: 'evil.example' }
    });
    expect(wrongHost.statusCode).toBe(421);
    expect(wrongHost.headers['content-security-policy']).toBe(CSP);
    expect(wrongHost.headers['x-frame-options']).toBe('DENY');
  });

  it('forbids framing even for a POST that is refused', async () => {
    const res = await buildServer(db, { webRoot }).inject({
      method: 'POST',
      url: '/api/login',
      payload: {}
    });
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});

describe('caching of the API', () => {
  it.each(['/api/config', '/api/metrics/latest', '/api/health', '/api/nothing'])(
    '%s is never stored (signed-in JSON must not sit in a shared cache)',
    async (url) => {
      expect((await get(url)).headers['cache-control']).toBe('no-store');
    }
  );

  it('also when the path is written so that it only matches the route once decoded', async () => {
    const res = await get('/%61pi/config');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('leaves the dashboard files with the static handler’s own cache header', async () => {
    const res = await get('/assets/app.js');
    expect(res.headers['cache-control']).not.toBe('no-store');
    expect(res.headers['cache-control']).toBeDefined();
  });
});
