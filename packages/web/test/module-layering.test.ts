// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const AREAS = ['now', 'history', 'alerts', 'settings', 'updates'];
const FOLDERS = ['core', ...AREAS];
/** The shell's two roots: nothing below them may import them (that would be a cycle). */
const SHELL_ROOTS = ['app.tsx', 'main.tsx'];

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : /\.(ts|tsx)$/.test(entry.name)
        ? [join(dir, entry.name)]
        : []
  );
}

/** `core/api.ts` → `core`; `app.tsx` (the shell, at the top) → `shell`. */
const areaOf = (file: string) => {
  const rel = relative(SRC, file);
  return rel.includes('/') ? rel.split('/')[0]! : 'shell';
};

describe('the layout of src/', () => {
  it('has only the shell at the top and the known folders below it', () => {
    const unknown = sourceFiles()
      .map(areaOf)
      .filter((area) => area !== 'shell' && !FOLDERS.includes(area));
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('keeps the shell to the entry, the app, the router, sign-in and the build stamp', () => {
    const shell = sourceFiles()
      .filter((file) => areaOf(file) === 'shell')
      .map((file) => relative(SRC, file));
    expect(shell.sort()).toEqual(['app.tsx', 'build.ts', 'main.tsx', 'router.ts', 'sign-in.tsx']);
  });
});

describe('the direction of imports', () => {
  /** Every relative import of a file with the area it points into (type-only imports count). */
  const imports = (file: string) =>
    [
      ...readFileSync(file, 'utf8').matchAll(
        /\bfrom\s+'(\.{1,2}\/[^']+)'|\bimport\s+'(\.{1,2}\/[^']+)'/g
      )
    ].map((match) => {
      const spec = (match[1] ?? match[2])!;
      const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
      return { spec, area: areaOf(target) };
    });

  it('core imports only core', () => {
    const bad = sourceFiles()
      .filter((file) => areaOf(file) === 'core')
      .flatMap((file) =>
        imports(file)
          .filter((i) => i.area !== 'core')
          .map((i) => `${relative(SRC, file)} -> ${i.spec}`)
      );
    expect(bad).toEqual([]);
  });

  it.each(AREAS)("%s imports only itself, core and the shell's small modules", (area) => {
    const bad = sourceFiles()
      .filter((file) => areaOf(file) === area)
      .flatMap((file) =>
        imports(file)
          .filter(
            (i) =>
              (i.area !== area && i.area !== 'core' && i.area !== 'shell') ||
              SHELL_ROOTS.some((root) => i.spec.endsWith(`/${root.replace(/\.tsx?$/, '.js')}`))
          )
          .map((i) => `${relative(SRC, file)} -> ${i.spec}`)
      );
    expect(bad).toEqual([]);
  });
});
