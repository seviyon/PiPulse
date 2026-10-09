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

// The status file is untrusted JSON; tests edit it loosely.
type Doc = { certificate: { reload: Record<string, unknown> } & Record<string, unknown> } & Record<
  string,
  unknown
>;
const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(':');
const status: RuntimeStatus = {
  version: 1,
  transport: 'https',
  certificate: {
    source: 'generated',
    fingerprint: FP,
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
  it('refuses a file far larger than a status file instead of reading it whole', () => {
    writeRuntimeStatus(dir, status);
    writeFileSync(join(dir, 'tls-status.json'), ' '.repeat(64 * 1024));
    expect(readRuntimeStatus(dir, running)).toMatchObject({
      state: 'status-file-corrupt',
      problem: expect.stringContaining('too large')
    });
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
  describe('a status file written by the service is not trusted', () => {
    const read = (mutate: (copy: Doc) => void) => {
      const copy = JSON.parse(JSON.stringify(status));
      mutate(copy);
      writeFileSync(join(dir, 'tls-status.json'), JSON.stringify(copy), { mode: 0o640 });
      return readRuntimeStatus(dir, running);
    };
    it.each([
      [
        'a fingerprint with an escape sequence',
        (c: Doc) => (c.certificate.fingerprint = `${FP}\u001b[2J`)
      ],
      ['a fingerprint that is not 32 hex pairs', (c: Doc) => (c.certificate.fingerprint = 'AB')],
      ['an unknown class', (c: Doc) => (c.certificate.class = 'fine')],
      ['an unknown reload state', (c: Doc) => (c.certificate.reload.state = 'great')],
      ['a non-string lastError', (c: Doc) => (c.certificate.reload.lastError = { a: 1 })],
      ['a non-numeric lastAttempt', (c: Doc) => (c.certificate.reload.lastAttempt = 'x')],
      ['a bootId with a newline', (c: Doc) => (c.bootId = 'a\nb')]
    ])('rejects %s', (_name, mutate) => {
      expect(read(mutate)).toMatchObject({ state: 'status-file-corrupt' });
    });
    it('strips control characters from lastError and drops unknown fields', () => {
      const view = read((c) => {
        c.certificate.reload = {
          state: 'failing',
          lastAttempt: 1,
          lastError: 'bad\u001b[2K\rline\nnext',
          extra: 'x'
        };
        c.extra = 'y';
      });
      expect(view.state).toBe('running');
      if (view.state !== 'running') return;
      const reload = view.status.certificate!.reload;
      // eslint-disable-next-line no-control-regex
      expect(reload.lastError).not.toMatch(/[\u0000-\u001f]/);
      expect(reload.lastError).toBe('bad?[2K?line?next');
      expect(reload).not.toHaveProperty('extra');
      expect(view.status).not.toHaveProperty('extra');
    });
  });
  it('writes atomically: no temp file is left and the mode is 0640', () => {
    writeRuntimeStatus(dir, status);
    expect(readdirSync(dir)).toEqual(['tls-status.json']);
  });
});
