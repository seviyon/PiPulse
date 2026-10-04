import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupName,
  groupId,
  layoutFrom,
  listBackups,
  parseMeta,
  parseRenewStatus,
  readState,
  writeRenewStatus,
  writeState,
  type Layout
} from '../src/layout.js';
import { tempDir } from './helpers.js';

let dir: string;
let layout: Layout;
beforeEach(() => {
  dir = tempDir();
  layout = {
    tlsDir: dir,
    caRoot: dir,
    uid: process.getuid!(),
    gid: process.getgid!(),
    privateGid: process.getgid!()
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FP = Array.from({ length: 32 }, () => 'AB').join(':');

describe('layoutFrom', () => {
  it('uses PIPULSE_TLS_DIR, and PIPULSE_TLS_CA_DIR for the CA (Docker) or the same folder', () => {
    const group = () => 'root:x:0:\npipulse:x:998:\n';
    expect(layoutFrom({}, { readGroup: group })).toEqual({
      tlsDir: '/etc/pipulse/tls',
      caRoot: '/etc/pipulse/tls',
      uid: 0,
      gid: 998,
      privateGid: 0
    });
    expect(
      layoutFrom({ PIPULSE_TLS_DIR: '/tls', PIPULSE_TLS_CA_DIR: '/tls-ca' }, { readGroup: group })
        .caRoot
    ).toBe('/tls-ca');
  });
  it('explains a missing pipulse group', () => {
    expect(() => groupId('pipulse', () => 'root:x:0:\n')).toThrow(/install PiPulse first/);
  });
});

describe('state.json', () => {
  it('is absent, then written 0640 and read back', () => {
    expect(readState(layout)).toBeUndefined();
    writeState(layout, 'legacy-http');
    expect(readState(layout)).toBe('legacy-http');
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o640);
  });
  it('refuses a corrupt file rather than guessing', () => {
    writeFileSync(join(dir, 'state.json'), '{"version":1,"mode":"https","x":1}');
    expect(() => readState(layout)).toThrow(/unknown key/);
  });
});

describe('ca-meta.json', () => {
  const meta = {
    version: 1,
    fingerprint: FP,
    subject: 'PiPulse CA io 0a1b2c',
    createdAt: 1,
    notAfter: 2,
    constraints: {
      dns: ['io', 'io.local', 'localhost'],
      excludedDns: ['.io', '.localhost'],
      subnets: []
    },
    backups: [{ name: 'ca.old-20261001T101500Z', fingerprint: FP, createdAt: 0 }]
  };
  it('round-trips', () => {
    expect(parseMeta(JSON.stringify(meta))).toEqual(meta);
  });
  it.each([
    [{ ...meta, version: 2 }],
    [{ ...meta, extra: true }],
    [{ ...meta, fingerprint: 'nope' }],
    [{ ...meta, backups: [{ name: '../etc', fingerprint: FP, createdAt: 0 }] }],
    [{ ...meta, constraints: { ...meta.constraints, subnets: ['0.0.0.0/0'] } }]
  ])('refuses %j', (bad) => {
    expect(() => parseMeta(JSON.stringify(bad))).toThrow();
  });
});

describe('backups', () => {
  it('are named by UTC time and listed oldest first; other folders are ignored', () => {
    expect(backupName(Date.UTC(2026, 9, 1, 10, 15, 0))).toBe('ca.old-20261001T101500Z');
    for (const name of [
      'ca.old-20261002T000000Z',
      'ca.old-20261001T000000Z',
      'ca.next-ab12',
      'ca'
    ]) {
      mkdirSync(join(dir, name));
    }
    expect(listBackups(layout).map((b) => b.name)).toEqual([
      'ca.old-20261001T000000Z',
      'ca.old-20261002T000000Z'
    ]);
    expect(listBackups(layout)[0]!.fingerprint).toBe('unreadable');
  });
});

describe('renew-status.json', () => {
  it('round-trips and is world-readable (no secrets)', () => {
    writeRenewStatus(layout, {
      version: 1,
      lastAttempt: 5,
      result: 'waiting-clock',
      reason: 'clock unsynced'
    });
    expect(statSync(join(dir, 'renew-status.json')).mode & 0o777).toBe(0o644);
    expect(() =>
      parseRenewStatus('{"version":1,"lastAttempt":5,"result":"maybe","reason":""}')
    ).toThrow();
  });
});
