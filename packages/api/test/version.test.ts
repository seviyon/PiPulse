import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '@pipulse/storage';
import { buildServer } from '../src/index.js';
import { nodeSupport, readVersion } from '../src/version.js';

describe('readVersion', () => {
  it('reads version.json, or reports dev without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-version-'));
    expect(readVersion(dir)).toBe('dev');
    writeFileSync(join(dir, 'version.json'), '{"version":"0.6.0"}');
    expect(readVersion(dir)).toBe('0.6.0');
    writeFileSync(join(dir, 'version.json'), 'not json');
    expect(readVersion(dir)).toBe('dev');
  });
});

describe('nodeSupport', () => {
  it('knows each line and whether its support ended', () => {
    expect(nodeSupport('v22.23.3', new Date('2027-04-30T12:00:00'))).toEqual({
      version: '22.23.3',
      line: 22,
      supportEnds: '2027-04-30',
      ended: false
    });
    expect(nodeSupport('v22.23.3', new Date('2027-05-01T00:00:01')).ended).toBe(true);
    expect(nodeSupport('v24.21.0', new Date('2026-09-28')).supportEnds).toBe('2028-04-30');
  });

  it('never guesses for an unknown line', () => {
    expect(nodeSupport('v99.0.0', new Date('2030-01-01'))).toEqual({
      version: '99.0.0',
      line: 99,
      supportEnds: null,
      ended: false
    });
  });
});

describe('/api/config', () => {
  it('serves the version and Node support', async () => {
    const db = openDb(':memory:');
    const node = nodeSupport('v22.23.3', new Date('2026-09-28'));
    const app = buildServer(db, { version: '0.6.0', node });
    const body = (await app.inject('/api/config')).json();
    expect(body.version).toBe('0.6.0');
    expect(body.node).toEqual(node);
    await app.close();
    db.close();
  });
});
