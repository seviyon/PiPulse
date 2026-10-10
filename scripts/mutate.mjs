#!/usr/bin/env node
// Mutation testing for part of one package (StrykerJS; see docs/development.md).
//
//   node scripts/mutate.mjs <package> <src-file[:from-to]> <test-file>...
//   node scripts/mutate.mjs tls src/runtime-status.ts:100-126 test/runtime-status.test.ts
//
// Stryker's Vitest runner does not work with Vitest 5 yet (mutants never switch on), so this
// uses its command runner: every mutant runs `vitest run <test-files>` in a copy of the package.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [pkg, target, ...tests] = process.argv.slice(2);
if (!pkg || !target || tests.length === 0) {
  console.error('usage: node scripts/mutate.mjs <package> <src-file[:from-to]> <test-file>...');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');
const config = JSON.parse(readFileSync(join(root, 'stryker.config.json'), 'utf8'));
config.$schema = undefined;
config.mutate = [target];
config.commandRunner = { command: `npx vitest run ${tests.join(' ')}` };
const file = join(mkdtempSync(join(tmpdir(), 'stryker-')), 'stryker.config.json');
writeFileSync(file, JSON.stringify(config));
const run = spawnSync('npx', ['stryker', 'run', file], {
  cwd: join(root, 'packages', pkg),
  stdio: 'inherit'
});
process.exit(run.status ?? 1);
