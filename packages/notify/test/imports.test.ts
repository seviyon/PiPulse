import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// notify-test loads this package on its own; @pipulse/storage's main entry opens
// node:sqlite, which prints an ExperimentalWarning on Node 22. So at runtime the
// package may only use the storage subpaths that don't touch SQLite.
const src = new URL('../src/', import.meta.url);

describe('runtime imports', () => {
  it("never loads @pipulse/storage's main entry (node:sqlite)", () => {
    const offenders = readdirSync(src)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) =>
        readFileSync(new URL(name, src), 'utf8')
          .split(/;\s*\n/)
          .filter((statement) =>
            /^\s*import\s+(?!type\b)[^]*from '@pipulse\/storage'/.test(statement)
          )
          .map(() => name)
      );
    expect(offenders).toEqual([]);
  });
});
