import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../src/index.js';

// The server and the standalone collector can open one file at the same moment (a fresh install,
// an upgrade that adds a migration). Separate processes are the point: node:sqlite is synchronous,
// so two connections in one process never overlap.
const built = fileURLToPath(new URL('../dist/index.js', import.meta.url));
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = (path: string) =>
  spawn(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '-e',
      `import(${JSON.stringify(built)}).then(({ openDb }) => { openDb(process.argv[1]).close(); }).catch((e) => { console.error(e.message); process.exit(1); })`,
      path
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

describe.skipIf(!existsSync(built))('opening the database from several processes at once', () => {
  it(
    'migrates it once, and every opener gets a usable database',
    { timeout: 120_000 },
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'pipulse-race-'));
      for (let round = 0; round < 8; round++) {
        const path = join(dir, `db-${round}.sqlite`);
        const children = Array.from({ length: 6 }, () => {
          const child = open(path);
          let stderr = '';
          child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
          return { child, stderr: () => stderr };
        });
        const codes = await Promise.all(
          children.map(async ({ child }) => (await once(child, 'exit'))[0])
        );
        expect(children.map((c) => c.stderr()).join('')).toBe('');
        expect(codes).toEqual(Array(6).fill(0));
        const db = new DatabaseSync(path);
        expect(
          (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
        ).toBe(SCHEMA_VERSION);
        db.close();
      }
    }
  );
});
