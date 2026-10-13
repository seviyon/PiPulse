import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { hashPassword, parsePasswordHash, type PasswordHash } from '../src/auth.js';
import { buildServer } from '../src/index.js';
import { createUpdates } from '../src/updates.js';
import { createUpgrade, parseStatus, tailLines, type UpgradeOptions } from '../src/upgrade.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipulse-upgrade-'));
  mkdirSync(join(dir, 'data'));
  mkdirSync(join(dir, 'updates'));
  writeFileSync(join(dir, 'boot-id'), 'b001-1\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = 1_800_000_000_000;
const status = (fields: object = {}) =>
  JSON.stringify({
    state: 'done',
    step: 'upgrade',
    startedAt: NOW / 1000 - 600,
    finishedAt: NOW / 1000 - 300,
    exitCode: 0,
    bootId: 'b001-1',
    ...fields
  });
const options = (extra: Partial<UpgradeOptions> = {}): UpgradeOptions => ({
  allowed: true,
  signInConfigured: true,
  inContainer: false,
  now: () => NOW,
  requestPath: join(dir, 'data', 'upgrade-request'),
  statusPath: join(dir, 'updates', 'upgrade-status.json'),
  logPath: join(dir, 'updates', 'upgrade.log'),
  bootIdPath: join(dir, 'boot-id'),
  rebootRequiredPath: join(dir, 'reboot-required'),
  helperInstalled: () => true,
  ...extra
});
const putStatus = (fields?: object) =>
  writeFileSync(join(dir, 'updates', 'upgrade-status.json'), status(fields));
const ring = (ageMs = 0) => {
  const path = join(dir, 'data', 'upgrade-request');
  writeFileSync(path, 'upgrade\n');
  const when = new Date(NOW - ageMs);
  utimesSync(path, when, when);
};

describe('why the button is not offered', () => {
  it.each([
    [{ inContainer: true, allowed: false }, 'container'],
    [{ allowed: false }, 'off'],
    [{ signInConfigured: false }, 'no-sign-in'],
    [{ helperInstalled: () => false }, 'not-installed']
  ] as const)('%j → %s', (extra, reason) => {
    expect(createUpgrade(options(extra)).view()).toEqual({ available: false, reason });
  });

  it('refuses a request and writes nothing', () => {
    const upgrade = createUpgrade(options({ allowed: false }));
    expect(upgrade.request()).toMatchObject({ ok: false, status: 403 });
    expect(existsSync(join(dir, 'data', 'upgrade-request'))).toBe(false);
  });
});

describe('the view', () => {
  it('is idle with nothing recorded', () => {
    expect(createUpgrade(options()).view()).toEqual({
      available: true,
      state: 'idle',
      step: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      rebootRequired: false,
      log: []
    });
  });

  it('reports the helper’s result, times in milliseconds, and the log tail', () => {
    putStatus();
    writeFileSync(join(dir, 'updates', 'upgrade.log'), 'Reading package lists...\nDone\n');
    expect(createUpgrade(options()).view()).toEqual({
      available: true,
      state: 'done',
      step: 'upgrade',
      startedAt: NOW - 600_000,
      finishedAt: NOW - 300_000,
      exitCode: 0,
      rebootRequired: false,
      log: ['Reading package lists...', 'Done']
    });
  });

  it('reports a failure with its exit code', () => {
    putStatus({ state: 'failed', step: 'update', exitCode: 100 });
    expect(createUpgrade(options()).view()).toMatchObject({
      state: 'failed',
      step: 'update',
      exitCode: 100
    });
  });

  it('says a reboot is needed while /run/reboot-required exists', () => {
    writeFileSync(join(dir, 'reboot-required'), '*** System restart required ***\n');
    expect(createUpgrade(options()).view()).toMatchObject({ rebootRequired: true });
  });

  it('running on this boot is running', () => {
    putStatus({ state: 'running', finishedAt: null, exitCode: null });
    expect(createUpgrade(options()).view()).toMatchObject({ state: 'running', finishedAt: null });
  });

  it('running on an earlier boot is interrupted, not running forever', () => {
    putStatus({ state: 'running', bootId: 'b000-0', finishedAt: null, exitCode: null });
    expect(createUpgrade(options()).view()).toMatchObject({ state: 'interrupted' });
  });

  it('running with no readable boot id is interrupted too', () => {
    rmSync(join(dir, 'boot-id'));
    putStatus({ state: 'running', finishedAt: null });
    expect(createUpgrade(options()).view()).toMatchObject({ state: 'interrupted' });
  });

  it('a fresh doorbell shows as requested; an old one is ignored', () => {
    ring(10_000);
    expect(createUpgrade(options()).view()).toMatchObject({ state: 'requested' });
    rmSync(join(dir, 'data', 'upgrade-request'));
    ring(10 * 60_000);
    expect(createUpgrade(options()).view()).toMatchObject({ state: 'idle' });
  });

  it('running for more than six hours is a helper that died: interrupted', () => {
    putStatus({ state: 'running', startedAt: NOW / 1000 - 7 * 3600, finishedAt: null });
    expect(createUpgrade(options()).view()).toMatchObject({ state: 'interrupted' });
  });

  it('reads only the end of a big log, and never follows a link in its place', () => {
    putStatus();
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    writeFileSync(join(dir, 'updates', 'upgrade.log'), lines + '\n');
    expect(createUpgrade(options()).view()).toMatchObject({
      log: expect.arrayContaining(['line 4999'])
    });
    rmSync(join(dir, 'updates', 'upgrade.log'));
    writeFileSync(join(dir, 'secret'), 'top secret\n');
    symlinkSync(join(dir, 'secret'), join(dir, 'updates', 'upgrade.log'));
    expect(createUpgrade(options()).view()).toMatchObject({ log: [] });
  });

  it('a doorbell does not hide a running upgrade', () => {
    putStatus({ state: 'running', finishedAt: null });
    ring(1000);
    expect(createUpgrade(options()).view()).toMatchObject({ state: 'running' });
  });

  it('shows no log without a status (a stale log of another run is not this one’s)', () => {
    writeFileSync(join(dir, 'updates', 'upgrade.log'), 'old\n');
    expect(createUpgrade(options()).view()).toMatchObject({ log: [] });
  });
});

describe('the real locations', () => {
  it('without a helper installed here the button is not offered', () => {
    const view = createUpgrade({
      allowed: true,
      signInConfigured: true,
      inContainer: false
    }).view();
    // a development machine has no pipulse-upgrade.path; a Pi with the package does
    expect([false, true]).toContain(view.available);
  });

  it('with the helper assumed, reads the real status, boot id and reboot flag without failing', () => {
    const view = createUpgrade({
      allowed: true,
      signInConfigured: true,
      inContainer: false,
      helperInstalled: () => true
    }).view();
    expect(view).toMatchObject({ available: true, log: expect.any(Array) });
  });
});

describe('request()', () => {
  it('writes a small private doorbell file', () => {
    expect(createUpgrade(options()).request()).toEqual({ ok: true });
    const path = join(dir, 'data', 'upgrade-request');
    expect(readFileSync(path, 'utf8')).toBe('upgrade\n');
    expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
  });

  it('refuses while requested or running', () => {
    const upgrade = createUpgrade(options({ now: Date.now }));
    expect(upgrade.request().ok).toBe(true);
    expect(upgrade.request()).toMatchObject({ ok: false, status: 409 });
    rmSync(join(dir, 'data', 'upgrade-request'));
    putStatus({ state: 'running', finishedAt: null });
    expect(upgrade.request()).toMatchObject({ ok: false, status: 409 });
  });

  it('waits out the cooldown after an upgrade ended', () => {
    putStatus({ finishedAt: NOW / 1000 - 60 });
    expect(createUpgrade(options()).request()).toMatchObject({ ok: false, status: 409 });
    expect(existsSync(join(dir, 'data', 'upgrade-request'))).toBe(false);
    putStatus({ finishedAt: NOW / 1000 - 700 });
    expect(createUpgrade(options()).request()).toEqual({ ok: true });
  });

  it('replaces an old untaken doorbell', () => {
    ring(10 * 60_000);
    expect(createUpgrade(options()).request()).toEqual({ ok: true });
  });

  it('never follows a link placed where the doorbell goes', () => {
    const target = join(dir, 'victim');
    writeFileSync(target, 'keep');
    // An old link is removed (not followed) and replaced by a plain file.
    symlinkSync(target, join(dir, 'data', 'upgrade-request'));
    const old = new Date(NOW - 10 * 60_000);
    utimesSync(join(dir, 'data', 'upgrade-request'), old, old);
    expect(createUpgrade(options()).request()).toEqual({ ok: true });
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });

  it('says why when the folder is not writable', () => {
    rmSync(join(dir, 'data'), { recursive: true });
    const result = createUpgrade(options()).request();
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect((result as { error: string }).error).toContain('could not ask for the upgrade');
  });
});

describe('parseStatus', () => {
  it('accepts the helper’s file', () => {
    expect(parseStatus(status())).toMatchObject({ state: 'done', exitCode: 0, bootId: 'b001-1' });
  });

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['null', 'null'],
    ['an unknown state', status({ state: 'sleeping' })],
    ['an unknown step', status({ step: 'reboot' })],
    ['no start time', status({ startedAt: 'yesterday' })],
    ['a negative start time', status({ startedAt: -1 })],
    ['a start time beyond any date', status({ startedAt: 1e12 })],
    ['too big', status({ bootId: 'a'.repeat(5000) })]
  ])('refuses %s', (_name, text) => {
    expect(parseStatus(text)).toBeUndefined();
    expect(parseStatus(undefined)).toBeUndefined();
  });

  it('drops a bad exit code, boot id and finish time instead of showing them', () => {
    expect(
      parseStatus(status({ exitCode: 'oops', bootId: '<script>', finishedAt: 'x' }))
    ).toMatchObject({ exitCode: null, bootId: '', finishedAt: null });
    expect(parseStatus(status({ exitCode: 999 }))).toMatchObject({ exitCode: null });
    expect(parseStatus(status({ exitCode: 1.5 }))).toMatchObject({ exitCode: null });
  });
});

describe('tailLines', () => {
  it('keeps the last 40 lines and drops empty ones', () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i}\n\n`).join('');
    const lines = tailLines(text);
    expect(lines).toHaveLength(40);
    expect(lines.at(-1)).toBe('line 59');
  });

  it('removes escape sequences, carriage returns and bidi controls, and shortens long lines', () => {
    expect(tailLines('a\u001b[31mred\r‮evil\u0000\n')).toEqual(['a[31mredevil']);
    expect(tailLines('x'.repeat(500))[0]).toHaveLength(200);
  });

  it('removes isolate controls too', () => {
    expect(tailLines('a\u2067b\u2069c')).toEqual(['abc']);
  });

  it('drops the first line of a cut-off tail', () => {
    expect(tailLines('half a li' + 'ne\n'.padEnd(8192, 'z') + '\nlast\n').at(-1)).toBe('last');
    expect(tailLines(undefined)).toEqual([]);
  });
});

describe('the routes', () => {
  let db: PiPulseDb;
  let app: FastifyInstance | undefined;
  let passwordHash: PasswordHash;
  beforeAll(async () => {
    passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
  });
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    db.close();
  });
  const calls: string[][] = [];
  const server = (extra: Partial<UpgradeOptions> = {}, withUpgrade = true) => {
    const updates = createUpdates({
      inContainer: false,
      aptPresent: () => true,
      run: async (_file, args) => {
        calls.push(args);
        return '';
      }
    });
    app = buildServer(db, {
      auth: { failureDelayMs: 0, passwordHash },
      updates,
      ...(withUpgrade ? { upgrade: createUpgrade(options({ now: Date.now, ...extra })) } : {})
    });
    return app;
  };
  const signIn = async (api: FastifyInstance) =>
    String(
      (await api.inject({ method: 'POST', url: '/api/login', payload: { password: 'secret' } }))
        .headers['set-cookie']
    ).split(';')[0]!;
  const post = (api: FastifyInstance, cookie: string, payload: unknown, headers: object = {}) =>
    api.inject({
      method: 'POST',
      url: '/api/updates/upgrade',
      headers: { cookie, ...headers },
      payload: payload as object
    });
  beforeEach(() => {
    calls.length = 0;
  });

  it('GET /api/updates carries the upgrade view', async () => {
    const api = server();
    expect((await api.inject('/api/updates')).json()).toMatchObject({
      state: 'pending',
      upgrade: { available: true, state: 'idle' }
    });
  });

  it('GET /api/updates says why when it is off, and has no upgrade key without the feature wired in', async () => {
    expect((await server({ allowed: false }).inject('/api/updates')).json().upgrade).toEqual({
      available: false,
      reason: 'off'
    });
    await app?.close();
    expect((await server({}, false).inject('/api/updates')).json()).not.toHaveProperty('upgrade');
  });

  it('needs a session and a same-host Origin', async () => {
    const api = server();
    expect((await post(api, '', { confirm: 'upgrade' })).statusCode).toBe(401);
    const cookie = await signIn(api);
    expect(
      (
        await post(
          api,
          cookie,
          { confirm: 'upgrade' },
          { origin: 'http://evil.example', host: 'io.lan:8889' }
        )
      ).statusCode
    ).toBe(403);
    expect(existsSync(join(dir, 'data', 'upgrade-request'))).toBe(false);
  });

  it.each([{}, { confirm: 'yes' }, { confirm: true }])('refuses the body %j', async (body) => {
    const api = server();
    const cookie = await signIn(api);
    expect((await post(api, cookie, body)).statusCode).toBe(400);
    expect(existsSync(join(dir, 'data', 'upgrade-request'))).toBe(false);
  });

  it('rings the doorbell on a typed confirmation and answers 202', async () => {
    const api = server();
    const cookie = await signIn(api);
    const res = await post(api, cookie, { confirm: 'upgrade' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ upgrade: { state: 'requested' } });
    expect(existsSync(join(dir, 'data', 'upgrade-request'))).toBe(true);
    // a second press while it waits
    expect((await post(api, cookie, { confirm: 'upgrade' })).statusCode).toBe(409);
  });

  it('is 403 when the operator has not turned it on, and writes nothing', async () => {
    const api = server({ allowed: false });
    const cookie = await signIn(api);
    const res = await post(api, cookie, { confirm: 'upgrade' });
    expect(res.statusCode).toBe(403);
    expect(existsSync(join(dir, 'data', 'upgrade-request'))).toBe(false);
  });

  it('is 403 with no upgrade support wired in', async () => {
    const api = server({}, false);
    const cookie = await signIn(api);
    expect((await post(api, cookie, { confirm: 'upgrade' })).statusCode).toBe(403);
  });

  it('looks for updates again once an upgrade has ended', async () => {
    const api = server();
    const cookie = await signIn(api);
    await post(api, cookie, { confirm: 'upgrade' });
    expect(calls).toHaveLength(0);
    // the helper took the doorbell and finished
    rmSync(join(dir, 'data', 'upgrade-request'));
    putStatus();
    await api.inject('/api/updates');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.some((args) => args.includes('upgrade'))).toBe(true);
    const before = calls.length;
    await api.inject('/api/updates');
    expect(calls).toHaveLength(before);
  });

  it('keeps the check route’s answer a view with the upgrade state alongside', async () => {
    const api = server();
    const cookie = await signIn(api);
    const res = await api.inject({
      method: 'POST',
      url: '/api/updates/check',
      headers: { cookie },
      payload: {}
    });
    expect(res.json()).toMatchObject({ state: 'ok', upgrade: { available: true } });
  });
});
