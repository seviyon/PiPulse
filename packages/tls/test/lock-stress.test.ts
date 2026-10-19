import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Opt-in: PIPULSE_LOCK_STRESS=1 npx vitest run test/lock-stress.test.ts (needs the build).
// Several processes queue on the lock while a stale one is being broken under them; no two may
// ever be inside at once. Separate processes are the point: breaking a stale lock is a run of
// synchronous syscalls, so a race in it cannot show inside one.
const script = fileURLToPath(new URL('./lock-stress.mjs', import.meta.url));
const built = existsSync(fileURLToPath(new URL('../dist/ca/lock.js', import.meta.url)));

const run = (workers: number, seconds: number, stale: boolean, leftovers = false) => {
  const result = spawnSync(process.execPath, [script, String(workers), String(seconds)], {
    encoding: 'utf8',
    env: { ...process.env, STALE: stale ? '1' : '0', LEFTOVERS: leftovers ? '1' : '0' }
  });
  const match = /sections=(\d+) overlaps=(\d+) lost=(\d+)/.exec(result.stdout);
  if (!match) throw new Error(`no result: ${result.stdout}${result.stderr}`);
  return { sections: Number(match[1]), overlaps: Number(match[2]), lost: Number(match[3]) };
};

describe.skipIf(!process.env['PIPULSE_LOCK_STRESS'] || !built)('the lock under contention', () => {
  it('control: many workers and no stale lock never overlap', { timeout: 60_000 }, () => {
    const { sections, overlaps } = run(6, 10, false);
    expect(sections).toBeGreaterThan(100);
    expect(overlaps).toBe(0);
  });

  it(
    'breaking a stale lock while three or more others queue never lets two in at once',
    {
      timeout: 120_000
    },
    () => {
      const { sections, overlaps, lost } = run(6, 20, true);
      expect(sections).toBeGreaterThan(100);
      expect(overlaps).toBe(0);
      expect(lost).toBe(0); // no holder found its lock gone at release
    }
  );

  it(
    '...and never when breakers keep dying and leaving their turn behind',
    {
      timeout: 120_000
    },
    () => {
      const { sections, overlaps, lost } = run(6, 20, true, true);
      expect(sections).toBeGreaterThan(100);
      expect(overlaps).toBe(0);
      expect(lost).toBe(0);
    }
  );
});
