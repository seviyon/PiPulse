import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, getLatest } from '@pipulse/storage';

// Runs the built daemon (root `pretest` builds it) as a real process.
const mainPath = fileURLToPath(new URL('../dist/main.js', import.meta.url));

let dir: string;

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('collector daemon', () => {
  it('writes samples to PIPULSE_DB_PATH and exits cleanly on SIGTERM', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pipulse-'));
    const dbPath = join(dir, 'pipulse.sqlite');

    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', mainPath], {
      env: { ...process.env, PIPULSE_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

    // The daemon logs once the scheduler is running; give the first poll time to land.
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(([code]) => {
        throw new Error(`daemon exited early with code ${String(code)}: ${stderr}`);
      })
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    child.kill('SIGTERM');
    const [exitCode] = await once(child, 'exit');

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);

    const db = openDb(dbPath);
    const metrics = getLatest(db).map((sample) => sample.metric);
    db.close();
    expect(metrics).toContain('cpu_load');
    expect(metrics).toContain('memory_used');
  }, 15000);
});
