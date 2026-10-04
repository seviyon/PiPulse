import { chmodSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  processIdentity,
  readRuntimeStatus,
  writeRuntimeStatus,
  type RuntimeStatus
} from '../src/runtime-status.js';
import { tempDir } from './helpers.js';

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const status: RuntimeStatus = {
  version: 1,
  transport: 'https',
  certificate: {
    source: 'generated',
    fingerprint: 'AB',
    class: 'valid',
    notAfter: 5,
    reload: { state: 'ok', lastAttempt: null, lastError: null }
  },
  pid: 4242,
  startTime: '123456',
  bootId: 'boot-a',
  writtenAt: 1
};
const running = {
  identity: () => ({ startTime: '123456', bootId: 'boot-a' }),
  bootId: () => 'boot-a'
};

describe('processIdentity', () => {
  it('reads field 22 even when the command name has spaces and parentheses', () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3)); // fields 3..52
    const stat = `4242 (node (worker) x) ${fields.join(' ')}`;
    const read = (path: string) => (path.endsWith('boot_id') ? 'boot-a\n' : stat);
    expect(processIdentity(4242, read)).toEqual({ startTime: '22', bootId: 'boot-a' });
  });
  it('is undefined for a pid that is gone', () => {
    const read = () => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    };
    expect(processIdentity(4242, read)).toBeUndefined();
  });
});

describe('readRuntimeStatus', () => {
  it('reports a running server', () => {
    writeRuntimeStatus(dir, status);
    expect(readRuntimeStatus(dir, running)).toEqual({ state: 'running', status });
  });
  it('is missing when the server is stopped (systemd removes the folder)', () => {
    expect(readRuntimeStatus(dir, running)).toEqual({ state: 'not-running', reason: 'missing' });
  });
  it('is stale after a reboot, when the pid is gone, and when the pid was reused', () => {
    writeRuntimeStatus(dir, status);
    expect(readRuntimeStatus(dir, { ...running, bootId: () => 'boot-b' })).toEqual({
      state: 'not-running',
      reason: 'stale-boot'
    });
    expect(readRuntimeStatus(dir, { ...running, identity: () => undefined })).toEqual({
      state: 'not-running',
      reason: 'stale-pid'
    });
    expect(
      readRuntimeStatus(dir, {
        ...running,
        identity: () => ({ startTime: '999', bootId: 'boot-a' })
      })
    ).toEqual({
      state: 'not-running',
      reason: 'pid-reused'
    });
  });
  it('never returns partial data from a corrupt, foreign or world-writable file', () => {
    writeFileSync(join(dir, 'tls-status.json'), '{"version":1,"transport":"ht');
    expect(readRuntimeStatus(dir, running).state).toBe('status-file-corrupt');
    writeRuntimeStatus(dir, status);
    chmodSync(join(dir, 'tls-status.json'), 0o646);
    expect(readRuntimeStatus(dir, running)).toMatchObject({
      state: 'status-file-corrupt',
      problem: expect.stringContaining('writable')
    });
    chmodSync(join(dir, 'tls-status.json'), 0o640);
    expect(readRuntimeStatus(dir, { ...running, expectUid: process.getuid!() + 1 })).toMatchObject({
      state: 'status-file-corrupt'
    });
  });
  it('writes atomically: no temp file is left and the mode is 0640', () => {
    writeRuntimeStatus(dir, status);
    expect(readdirSync(dir)).toEqual(['tls-status.json']);
  });
});
