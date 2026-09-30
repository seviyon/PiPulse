import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { format } from 'prettier';
import { parsers } from 'prettier/plugins/yaml';
import { beforeAll, describe, expect, it } from 'vitest';

// Repository configuration lives here so the existing workspace test command
// discovers it. Reuse Prettier's YAML parser without adding a test dependency.
interface YamlNode {
  type: string;
  value?: string;
  children?: YamlNode[];
}

let root: YamlNode;
beforeAll(async () => {
  const source = readFileSync(new URL('../../../.coderabbit.yaml', import.meta.url), 'utf8');
  await format(source, {
    parser: 'config-yaml',
    plugins: [
      {
        parsers: {
          'config-yaml': {
            ...parsers.yaml,
            async parse(text, options) {
              const ast: YamlNode = await parsers.yaml.parse(text, options);
              expect(ast.children).toHaveLength(1);
              const body = ast.children?.[0]?.children?.find(
                (node) => node.type === 'documentBody'
              );
              if (!body?.children?.[0]) throw new Error('Expected a YAML document body');
              root = body.children[0];
              return ast;
            }
          }
        }
      }
    ]
  });
});

// Read parsed nodes, retaining scalar types (e.g. false versus 'false').
function field(...path: (string | number)[]): YamlNode {
  let node = root;
  for (const key of path) {
    const child =
      typeof key === 'number'
        ? node.children?.[key]?.children?.[0]
        : node.children?.find((item) => item.children?.[0]?.children?.[0]?.value === key)
            ?.children?.[1]?.children?.[0];
    if (!child) throw new Error(`Missing configuration field: ${path.join('.')}`);
    node = child;
  }
  return node;
}

function scalar(...path: (string | number)[]): string {
  const node = field(...path);
  if (typeof node.value !== 'string') throw new Error(`Expected scalar: ${path.join('.')}`);
  return node.value;
}

function strings(...path: (string | number)[]): string[] {
  const node = field(...path);
  expect(['sequence', 'flowSequence']).toContain(node.type);
  if (!node.children) throw new Error(`Expected sequence: ${path.join('.')}`);
  return node.children.map((_, index) => scalar(...path, index));
}

function excluded(path: string): boolean {
  return strings('reviews', 'path_filters').some((filter) => matchesGlob(path, filter.slice(1)));
}

function instructionsFor(path: string): string[] {
  const entries = field('reviews', 'path_instructions').children;
  if (!entries) throw new Error('Expected path instructions');
  return entries.flatMap((_, index) => {
    const pattern = scalar('reviews', 'path_instructions', index, 'path');
    return matchesGlob(path, pattern) ? [pattern] : [];
  });
}

describe('CodeRabbit review policy', () => {
  it('enables automatic reviews while excluding drafts and Renovate', () => {
    expect(field('reviews', 'auto_review', 'enabled')).toMatchObject({
      type: 'plain',
      value: 'true'
    });
    expect(field('reviews', 'auto_review', 'drafts')).toMatchObject({
      type: 'plain',
      value: 'false'
    });
    expect(strings('reviews', 'auto_review', 'ignore_usernames')).toEqual(['renovate[bot]']);
  });

  it('provides concise summaries and leaves the merge gate to CI', () => {
    expect(scalar('reviews', 'profile')).toBe('chill');
    for (const [key, value] of [
      ['high_level_summary', 'true'],
      ['poem', 'false'],
      ['request_changes_workflow', 'false']
    ] as const) {
      expect(field('reviews', key)).toMatchObject({ type: 'plain', value });
    }
    expect(scalar('reviews', 'pre_merge_checks', 'docstrings', 'mode')).toBe('off');
  });

  it.each(['eslint', 'shellcheck', 'hadolint', 'actionlint', 'gitleaks'])(
    'enables the %s check',
    (tool) => {
      expect(field('reviews', 'tools', tool, 'enabled')).toMatchObject({
        type: 'plain',
        value: 'true'
      });
    }
  );

  it('disables Biome to avoid conflicting with ESLint and Prettier', () => {
    expect(field('reviews', 'tools', 'biome', 'enabled')).toMatchObject({
      type: 'plain',
      value: 'false'
    });
  });

  it('loads the maintained project guidelines', () => {
    expect(field('knowledge_base', 'code_guidelines', 'enabled')).toMatchObject({
      type: 'plain',
      value: 'true'
    });
    expect(strings('knowledge_base', 'code_guidelines', 'filePatterns')).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
      'docs/PLAN.md'
    ]);
  });
});

describe('CodeRabbit review file selection', () => {
  it('uses only explicit exclusion patterns', () => {
    const filters = strings('reviews', 'path_filters');
    expect(filters.length).toBeGreaterThan(0);
    expect(new Set(filters).size).toBe(filters.length);
    for (const filter of filters) expect(filter).toMatch(/^![^!].+/);
  });

  it.each([
    'package-lock.json',
    'packages/tls/test/fixtures/server.crt',
    'packages/tls/test/fixtures/server.key',
    'packages/tls/test/fixtures/nested/server.crt',
    'packages/tls/test/fixtures/nested/server.key',
    'packaging/node-keys/release.asc',
    'packaging/node-keys/nested/release.asc',
    'dist/index.js',
    'packages/api/dist/index.js',
    'packages/web/dist/assets/app.js'
  ])('excludes generated or vendored file %s', (path) => {
    expect(excluded(path)).toBe(true);
  });

  it.each([
    '.coderabbit.yaml',
    '.github/workflows/ci.yml',
    'package.json',
    'packages/api/package.json',
    'packages/api/src/index.ts',
    'packages/web/src/app.tsx',
    'packages/tls/test/pem.test.ts',
    'packages/tls/test/fixtures/make-fixtures.sh',
    'packages/tls/test/fixtures/README.md',
    'packages/tls/src/server.key',
    'packages/tls/test/other/server.crt',
    'packaging/fetch-node.sh',
    'packaging/node-keys-backup/release.asc',
    'packages/api/src/distinct/index.ts',
    'packages/api/src/dist.ts',
    'docs/PLAN.md'
  ])('keeps source and exclusion boundary %s reviewable', (path) => {
    expect(excluded(path)).toBe(false);
  });
});

describe('CodeRabbit path guidance', () => {
  it('has unique paths and nonempty parsed instructions', () => {
    const entries = field('reviews', 'path_instructions').children;
    expect(entries?.length).toBeGreaterThan(0);
    if (!entries) throw new Error('Expected path instructions');
    const patterns = entries.map((_, index) => {
      expect(
        scalar('reviews', 'path_instructions', index, 'instructions').trim().length
      ).toBeGreaterThan(0);
      return scalar('reviews', 'path_instructions', index, 'path');
    });
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it.each([
    ['packages/collector/src/plugins/cpu.ts', ['packages/*/src/**/*.ts']],
    ['packages/api/src/auth-routes.ts', ['packages/*/src/**/*.ts', 'packages/api/src/**']],
    [
      'packages/storage/src/migrations.ts',
      ['packages/*/src/**/*.ts', 'packages/storage/src/migrations.ts', 'packages/storage/src/**']
    ],
    ['packages/storage/src/settings.ts', ['packages/*/src/**/*.ts', 'packages/storage/src/**']],
    ['packages/alerts/src/rules.ts', ['packages/*/src/**/*.ts', 'packages/alerts/src/**']],
    ['packages/notify/src/sender.ts', ['packages/*/src/**/*.ts', 'packages/notify/src/**']],
    ['packages/tls/src/pem.ts', ['packages/*/src/**/*.ts', 'packages/tls/src/**']],
    ['packages/web/src/api.ts', ['packages/*/src/**/*.ts', 'packages/web/src/**/*.{ts,tsx}']],
    ['packages/web/src/components/tile.tsx', ['packages/web/src/**/*.{ts,tsx}']],
    ['packages/web/test/tile.test.tsx', ['packages/*/test/**']],
    ['packages/api/test/nested/auth.test.ts', ['packages/*/test/**']],
    ['packaging/install.sh', ['packaging/**']],
    ['packaging/deb/postinst', ['packaging/**']],
    ['package.json', ['**/package.json']],
    ['packages/api/package.json', ['**/package.json']],
    ['.github/workflows/ci.yml', ['.github/workflows/**']],
    ['docs/superpowers/plans/new-phase.md', ['docs/superpowers/**']],
    [
      'packages/storage/src/nested/migrations.ts',
      ['packages/*/src/**/*.ts', 'packages/storage/src/**']
    ],
    ['packages/web/src/styles.css', []],
    ['packages/api/README.md', []],
    ['docs/PLAN.md', []]
  ])('applies the appropriate guidance to %s', (path, patterns) => {
    expect(instructionsFor(path).sort()).toEqual([...patterns].sort());
  });
});
