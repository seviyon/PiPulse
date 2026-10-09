import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, SERVER_JS, TLS_FIXTURES, WEB_DIST } from '../src/harness/paths.js';

describe('paths', () => {
  it('finds the repository root', () => {
    expect(existsSync(join(REPO_ROOT, 'CLAUDE.md'))).toBe(true);
  });

  it('points at the built server as a real path', () => {
    expect(SERVER_JS.endsWith(join('packages', 'api', 'dist', 'server.js'))).toBe(true);
    expect(realpathSync(SERVER_JS)).toBe(SERVER_JS);
  });

  it('points at the built dashboard', () => {
    expect(WEB_DIST.endsWith(join('packages', 'web', 'dist'))).toBe(true);
    expect(existsSync(join(WEB_DIST, 'index.html'))).toBe(true);
  });

  it('points at the committed test certificates', () => {
    for (const name of ['leaf.crt', 'leaf.key', 'intermediate.crt', 'root-ca.crt']) {
      expect(existsSync(join(TLS_FIXTURES, name)), name).toBe(true);
    }
  });
});
