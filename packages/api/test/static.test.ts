import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { buildServer } from '../src/index.js';

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

describe('dashboard static files', () => {
  it('serves index.html at /', async () => {
    const app = buildServer(db, { webRoot });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<title>PiPulse</title>');
  });

  it('serves built assets', async () => {
    const app = buildServer(db, { webRoot });
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1)');
  });

  it('leaves API routes untouched', async () => {
    const app = buildServer(db, { webRoot });
    const res = await app.inject({ method: 'GET', url: '/api/metrics/latest' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('refuses to serve files outside the web root', async () => {
    const app = buildServer(db, { webRoot });
    const res = await app.inject({ method: 'GET', url: '/../package.json' });
    expect(res.statusCode).toBe(404);
  });

  it('serves no dashboard when no web root is given', async () => {
    const app = buildServer(db);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
  });
});
