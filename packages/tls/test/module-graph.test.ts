import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** The static (non-type) imports reachable from `entry`. Dynamic import() is left out on purpose. */
function graph(entry: string) {
  const seen = new Set<string>();
  const builtins = new Map<string, string[]>();
  const queue = [join(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^(import|export)\s(?!type\s)[^;]*?from\s+'([^']+)'/gms)) {
      const spec = match[2]!;
      if (spec.startsWith('node:')) builtins.set(spec, [...(builtins.get(spec) ?? []), match[0]]);
      else if (spec.startsWith('.'))
        queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
    }
  }
  return { files: [...seen], builtins };
}

describe('the sidecar opens no sockets', () => {
  it.each(['sidecar.ts', 'cli.ts'])(
    '%s has no network client in its static module graph',
    (entry) => {
      const { files, builtins } = graph(entry);
      for (const forbidden of ['node:http', 'node:https', 'node:http2', 'node:dgram']) {
        expect(builtins.has(forbidden), `${entry} reaches ${forbidden}`).toBe(false);
      }
      for (const statement of builtins.get('node:net') ?? [])
        expect(statement).toMatch(/^import \{ isIP \} from 'node:net'/);
      for (const file of files)
        expect(readFileSync(file, 'utf8')).not.toMatch(/\bfetch\(|new WebSocket\b/);
    }
  );
});
