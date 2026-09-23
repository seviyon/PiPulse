import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSettings, openDb, saveSettings, SCHEMA_VERSION, type PiPulseDb } from '../src/index.js';

let db: PiPulseDb | undefined;
afterEach(() => db?.close());

describe('settings', () => {
  it('is at the current schema version with an empty settings table', () => {
    db = openDb(':memory:');
    expect(SCHEMA_VERSION).toBe(6);
    expect(getSettings(db)).toEqual({});
  });

  it('saves, replaces and deletes values, surviving a reopen', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pipulse-')), 'db.sqlite');
    db = openDb(path);
    saveSettings(db, { 'retention.raw': '30d', 'retention.1m': '60d' }, 1000);
    saveSettings(db, { 'retention.raw': '7d', 'retention.1m': undefined }, 2000);
    db.close();
    db = openDb(path);
    expect(getSettings(db)).toEqual({ 'retention.raw': '7d' });
    const row = db
      .prepare('SELECT updated_at FROM settings WHERE key = ?')
      .get('retention.raw') as {
      updated_at: number;
    };
    expect(row.updated_at).toBe(2000);
  });

  it('reads a corrupt row as unset instead of throwing', () => {
    db = openDb(':memory:');
    db.prepare("INSERT INTO settings VALUES ('retention.raw', '{not json', 1)").run();
    expect(getSettings(db)).toEqual({});
  });

  it('writes nothing when one value fails', () => {
    db = openDb(':memory:');
    expect(() => saveSettings(db!, { a: 1, b: 10n })).toThrow();
    expect(getSettings(db)).toEqual({});
  });
});
