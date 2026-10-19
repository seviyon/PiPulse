import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * Where each source file lives, and its rank: a file may import files of its own rank or a lower
 * one, never a higher one. health-check.ts ranks above `ca` (it reads the layout and the runtime
 * status) and below `cli` (cli-common and cmd-mode call it).
 */
const RANKS: Record<string, number> = {
  common: 0,
  settings: 1,
  inspect: 2,
  ca: 3,
  'health-check.ts': 4,
  cli: 5,
  'cli.ts': 6,
  'index.ts': 6
};
const FILES: Record<string, string[]> = {
  common: ['envfile', 'files', 'hostname', 'pem', 'proc'],
  settings: ['clock', 'config'],
  inspect: ['inspect', 'reload', 'replacement', 'x509-constraints'],
  ca: [
    'clock-anchor',
    'constraints',
    'issue',
    'journal',
    'layout',
    'lock',
    'material',
    'runtime-status'
  ],
  cli: [
    'cli-common',
    'clock-gate',
    'cmd-ca',
    'cmd-export',
    'cmd-init',
    'cmd-mode',
    'cmd-renew',
    'cmd-status',
    'sidecar'
  ]
};

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : []
  );
}

/** `common/files.ts` → `common`; `cli.ts` → `cli.ts`. */
const areaOf = (file: string) => {
  const rel = relative(SRC, file);
  return rel.includes('/') ? rel.split('/')[0]! : rel;
};

describe('the layout of src/', () => {
  const files = sourceFiles();

  it('holds exactly the files of the table, each in its folder', () => {
    const expected = [
      'index.ts',
      'cli.ts',
      'health-check.ts',
      ...Object.entries(FILES).flatMap(([folder, names]) => names.map((n) => `${folder}/${n}.ts`))
    ].sort();
    expect(files.map((f) => relative(SRC, f)).sort()).toEqual(expected);
  });

  it('keeps the files that the installer and Docker run by path at the top', () => {
    const top = files.filter((f) => !relative(SRC, f).includes('/')).map((f) => relative(SRC, f));
    expect(top.sort()).toEqual(['cli.ts', 'health-check.ts', 'index.ts']);
  });
});

describe('the direction of imports', () => {
  it('never goes from a lower folder to a higher one', () => {
    const upward: string[] = [];
    for (const file of sourceFiles()) {
      const from = areaOf(file);
      expect(RANKS[from], `${relative(SRC, file)} is in no known folder`).toBeDefined();
      const text = readFileSync(file, 'utf8');
      // Type-only imports count too: a type dependency is still a dependency.
      for (const match of text.matchAll(/\bfrom\s+'(\.{1,2}\/[^']+)'/g)) {
        const target = resolve(dirname(file), match[1]!.replace(/\.js$/, '.ts'));
        const to = areaOf(target);
        expect(
          RANKS[to],
          `${relative(SRC, file)} imports ${match[1]}, in no known folder`
        ).toBeDefined();
        if (RANKS[to]! > RANKS[from]!)
          upward.push(`${relative(SRC, file)} -> ${relative(SRC, target)}`);
      }
    }
    expect(upward).toEqual([]);
  });
});
