# `packages/tls` folders — Implementation Plan

> **For agentic workers:** this is a move-only plan. Use superpowers:executing-plans (inline) or subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `packages/tls/src` is 30 files in one folder (7,100 lines) and `test/` is 50 files beside them. Group them by what they are for, so a reader can find the CA code, the certificate-reading code and the CLI without reading 30 names, and so the direction of dependencies is written down and tested. **No behaviour change, no renamed exports, no edited logic.**

**Why last:** it is the package with the most security-critical code (journal, lock, issuance, constraints) and the most places outside the package that name its files. The web and collector moves (#140, #138) showed the method; this applies it with a stricter check.

**Tech stack:** TypeScript (ESM, NodeNext), Vitest 5, a Python move script (as in #140), StrykerJS via `npm run mutate` (one sanity run only, see Task 5).

## Global Constraints

- **Entry files stay at the top of `src/`.** `rootDir` is `src`, so `dist` mirrors it, and these paths are named outside the package and must not move: `dist/index.js` (the package `main`, and `packaging/test/compose.sh`), `dist/cli.js` (`packaging/setup.sh`, `packaging/pipulse`, `packaging/test/migrate-tls.test.sh`) and `dist/health-check.js` (`Dockerfile`, `packaging/install.sh`, `packaging/lib.sh`, `compose.sh`, `compose-operator.sh`). Both `cli.ts` and `health-check.ts` also test `import.meta.url === pathToFileURL(process.argv[1]).href`, which is unaffected by a move.
- **`test/helpers.ts`, `test/openssl.ts` and `test/fixtures/` stay where they are.** `packages/api/test/*` import `../../tls/test/helpers.js` (six files), `e2e/src/harness/paths.ts` points at `test/fixtures`, `.coderabbit.yaml` excludes `packages/tls/test/fixtures/**`, and `make-fixtures.sh` writes there.
- Exported names of `@pipulse/tls` (`src/index.ts`) do not change. The package keeps no `@pipulse/*` dependency.
- No file is edited except for import paths (and the test files named in Task 4). `git diff -M` must show renames, and every changed line must be an import/mock specifier or a path in a comment or doc.
- One PR. A release label is not needed: nothing a user can see changes.

## Target layout

Dependencies point down this list only: `common` ← `settings` ← `inspect` ← `ca` ← `health-check.ts` ← `cli` ← `cli.ts` and `index.ts`. (`health-check.ts` sits between `ca` and `cli` because it reads the layout and the runtime status, and `cli/cli-common.ts` and `cli/cmd-mode.ts` call it. This was checked against the imports of the base commit: it is the only ordering with no upward import.)

```text
packages/tls/src/
  index.ts            stays: the barrel (re-export paths updated)
  cli.ts              stays: dist/cli.js is the `pipulse tls` command
  health-check.ts     stays: dist/health-check.js is the installer's and Docker's check
  common/             what every other part uses
    files.ts  proc.ts  hostname.ts  envfile.ts  pem.ts
  settings/           the settings and the clock they depend on
    config.ts  clock.ts
  inspect/            reading and judging a certificate that already exists
    x509-constraints.ts  inspect.ts  reload.ts  replacement.ts
  ca/                 making and keeping the generated CA, leaf and their state
    issue.ts  constraints.ts  layout.ts  material.ts  journal.ts  lock.ts
    clock-anchor.ts  runtime-status.ts
  cli/                the `pipulse tls` commands and the Docker sidecar
    cli-common.ts  clock-gate.ts  cmd-ca.ts  cmd-export.ts  cmd-init.ts
    cmd-mode.ts  cmd-renew.ts  cmd-status.ts  sidecar.ts
packages/tls/test/
  helpers.ts  openssl.ts  fixtures/        stay
  browser-kit.ts  cli-context.ts           stay (shared by tests in several folders)
  common/ settings/ inspect/ ca/ cli/      tests, in the folder of the module they test
  module-graph.test.ts  lock-stress.*      stay at the top (see Task 4)
```

Assignments that need a reason, checked against the import graph of the base commit:

- `runtime-status.ts` is in `ca/` (not `inspect/`) because it imports `FINGERPRINT` from `layout.ts`; otherwise `inspect` would depend on `ca`.
- `layout.ts` is in `ca/` although `health-check.ts` (top level) uses it: `health-check.ts` ranks above `ca`.
- `clock-gate.ts` is in `cli/` (it imports `cli-common`); `clock.ts` is in `settings/` (it imports only `files`).
- `pem.ts`, `hostname.ts` and `envfile.ts` import nothing from the package, so they are `common/`.
- Test-to-folder rule: a test goes where the module it names is (`lock.test.ts`, `lock.mutation.test.ts`, `lock-race.test.ts`, `lock-stress.test.ts` → `ca/` except the stress test, which stays at the top because `lock-stress.mjs` starts real processes from `../dist/lock.js`). `cli-*.test.ts` → `cli/`. Tests that cover several modules (`fixtures.test.ts`, `module-graph.test.ts`, `dbpath.test.ts`) stay at the top.

## Review Focus

1. **Nothing outside the package breaks.** `npm run build` then `packaging/test/run.sh service install tarball migrate-tls tls`, `compose.sh` and `compose-operator.sh` (Colima), `npm run test:e2e`, and `npx vitest run packages/api` (it imports the fixtures helper).
2. **The layering holds.** A new test fails if a lower folder imports a higher one (Task 2). It is written before the move, against the base layout, and is expected to fail until the files are in place only for the file-to-folder map, never for an import it should allow.
3. **Tests that read the layout.** `module-graph.test.ts` reads `src/` by path (`sidecar.ts`, `cli.ts` entries), `cli-process.test.ts`/`health-check-edges.test.ts`/`lock-stress.*` read `dist/<file>.js`. Each must follow the file it names, and each is checked to still be able to fail (Task 4).
4. **Docs and comments that name a path** (`CLAUDE.md`, `docs/development.md`, `docs/architecture.md`, source comments such as "see `src/x.ts`").

## File structure

- Create: `scripts/move-tls.py` is **not** committed; the script lives in the scratchpad and its mapping table is pasted into the PR description.
- Create: `packages/tls/test/module-layering.test.ts` (Task 2).
- Create: `packages/tls/test/index-surface.test.ts` (Task 1).
- Move: the 30 source files and the tests listed above.
- Modify: import paths only, `docs/architecture.md` and `CLAUDE.md` (layout line), `docs/development.md` (paths in the mutation example), the test files named in Task 4.

---

### Task 1: Pin the package's surface before anything moves

**Files:** Create `packages/tls/test/index-surface.test.ts`.

- [ ] **Step 1:** Print the exports of the built package at the base commit: `npm run build --workspace=@pipulse/tls && node -e "import('./packages/tls/dist/index.js').then(m=>console.log(JSON.stringify(Object.keys(m).sort(),null,2)))"`.
- [ ] **Step 2:** Write the test: `import * as tls from '../src/index.js'; expect(Object.keys(tls).sort()).toEqual(EXPORTS)` with that list pasted in, like `packages/collector/test/index-surface.test.ts`. Also assert that `dist/cli.js` and `dist/health-check.js` exist after a build (`existsSync`, skipped when `dist` is absent, as `health-check-edges.test.ts` does), because the packaging scripts name them.
- [ ] **Step 3:** `npx vitest run packages/tls/test/index-surface.test.ts` → passes on the base layout. Commit (`tls: pin the package's exports before the move`).

### Task 2: The layering test (written first, with the map)

**Files:** Create `packages/tls/test/module-layering.test.ts`.

- [ ] **Step 1:** The test reads every `.ts` file under `src/` (recursively), takes its static `from './…'`/`from '../…'` specifiers (type-only imports included: a type dependency is still a dependency) and checks each against the rank of its folder: `common` 0, `settings` 1, `inspect` 2, `ca` 3, `health-check.ts` 4, `cli` 5, `cli.ts` and `index.ts` 6. A file may import files of the same or a lower rank, never a higher one. It also asserts that every `.ts` file under `src/` is in the target layout's table (so a new file must be placed on purpose), and that the top level holds exactly `index.ts`, `cli.ts` and `health-check.ts`.
- [ ] **Step 2:** Run it on the base layout: it must fail with "unknown folder" for every file at the top (proof it can fail). Do not commit a red test: keep it uncommitted until Task 3 makes it pass, then commit it with the move.

### Task 3: Move the source

**Files:** the 27 source files that leave the top level; every file's import specifiers.

- [ ] **Step 1:** Write the move script (scratchpad), based on the one that did #140: a table `file → folder`; parse every static `from '…'`, `import('…')` and `vi.mock('…')` specifier in `src/` and `test/`; resolve it against the file's old location; map the target to its new location; write the new relative specifier with the `.js` extension; `git mv` first, then rewrite. A specifier it cannot resolve is an error, not a skip.
- [ ] **Step 2:** `index.ts`'s re-exports follow (`./config.js` → `./settings/config.js`, and so on). Keep the order of its lines.
- [ ] **Step 3:** `npm run build --workspace=@pipulse/tls` (tsc). Expected: no errors; `dist/` now has the folders and still has `dist/cli.js`, `dist/health-check.js`, `dist/index.js`.
- [ ] **Step 4:** Run `npx vitest run packages/tls/test/module-layering.test.ts` → passes. If a lower file imports a higher one, **stop and rule on the smallest fix that is still a move** (for example, a file into a lower folder). Do not edit code to make the direction fit; record the ruling in the ledger and in the PR.
- [ ] **Step 5:** Commit the move with the layering test (`tls: common, settings, inspect, ca and cli folders; the layering is a test`).

### Task 4: Move the tests and fix the ones that read the layout

**Files:** the tests listed in "Target layout"; `test/module-graph.test.ts`, `test/cli-process.test.ts`, `test/health-check-edges.test.ts`, `test/lock-stress.test.ts`, `test/lock-stress.mjs`, `test/browser-kit.ts`.

- [ ] **Step 1:** Run the same script over `test/`: each test moves to `test/<folder>/` and its specifiers (`../src/x.js`, `./helpers.js`, `./openssl.js`, `./cli-context.js`, `./browser-kit.js`, `./fixtures/…`) are rewritten. `helpers.ts`'s own `new URL('./fixtures/', import.meta.url)` is untouched because it does not move.
- [ ] **Step 2:** The five tests that name a path through `new URL(..., import.meta.url)` (not an import specifier, so the script does not see them) are fixed by hand, and each edit is one path: `module-graph.test.ts` (`../src/` stays, the entries become `sidecar.ts` → `cli/sidecar.ts`, `cli.ts` unchanged), `cli-process.test.ts` and `health-check-edges.test.ts` (`../dist/cli.js` and `../dist/health-check.js` do not move; only the extra `../` if the test moved into a folder), `lock-stress.test.ts` / `lock-stress.mjs` (`../dist/lock.js` → `../dist/ca/lock.js`; both stay at the top of `test/`), `browser-kit.ts` (reads `port + '.pem'` next to itself; it stays).
- [ ] **Step 3:** Prove each of those can still fail: temporarily break the path in the test (a wrong folder name) and see it fail, not skip, then restore it. `health-check-edges.test.ts` and `lock-stress.test.ts` **skip** when `dist` is missing, so run them after `npm run build`, with `PIPULSE_LOCK_STRESS=1 npx --prefix packages/tls vitest run --root packages/tls test/lock-stress.test.ts` for the stress test.
- [ ] **Step 4:** `npx vitest run packages/tls` and `npx vitest run packages/api` (the api tests import `../../tls/test/helpers.js`). Expected: the same number of tests as on the base commit (record it in Task 1's commit message and compare).
- [ ] **Step 5:** Commit (`tls: tests beside the modules they cover`).

### Task 5: Docs, tooling and gates

- [ ] **Step 1:** `docs/development.md`: the mutation example `tls src/runtime-status.ts:100-126 test/runtime-status.test.ts` → `src/ca/runtime-status.ts:100-126 test/ca/runtime-status.test.ts`, and the `lock.test.ts` / `src/lock.ts` naming example. `docs/architecture.md`: one line for the tls layout (as #140 did for web). `CLAUDE.md`: the paths it names (`packages/tls/src/clock-anchor.ts` → `ca/`, `packages/tls/src/config.ts` → `settings/`) and one working-convention line: where a new file goes, and "a folder imports only from folders above it in the list; `module-layering.test.ts` enforces it".
- [ ] **Step 2:** `grep -rn "src/[a-z-]*\.ts" packages/tls docs CLAUDE.md` for comments and docs that name a moved file; fix each, nothing else.
- [ ] **Step 3: Mutation sanity run.** A move does not change a mutant, so the 94–100 % scores recorded in `CLAUDE.md` stand. One run proves `scripts/mutate.mjs` works at the new paths: `npm run mutate -- tls src/ca/lock.ts test/ca/lock.test.ts --bail=1` on a copy of the repo (`cp -cR`), expected to finish with the same survivors as before the move (record the count from the base commit first). Tests that import `../../tls/test/...` need their path made absolute in the clone only.
- [ ] **Step 4:** Gates: `npm test`, `npm run lint`, `npm run format`; `npm run test:e2e`; the packaging suites `service install tarball migrate-tls tls` in the `node:22-bookworm-slim` container; `packaging/test/compose.sh` and `compose-operator.sh` on Colima; `npx vitest run packages/tls` once as root in the packaging container (ownership tests skip elsewhere, as CI does).
- [ ] **Step 5: The move check.**

```bash
git diff -M --numstat origin/main | awk '$1!=$2' | head        # edited lines that are not 1-for-1: expect only the files named in Task 4 and docs
git diff -M -U0 origin/main -- packages/tls/src | grep -E '^[-+][^-+]' | grep -vE "from '|import\(|import '|vi\.mock" | head   # expect nothing
```

- [ ] **Step 6:** Push, open the PR with the mapping table, the test counts before and after, the move-check output and the gate table. No release label. Ask the person to run `sudo pipulse tls status` on `Io` after the next release (the installed `dist` layout changes, `dist/cli.js` does not).

---

## Self-review

- Spec coverage: grouping (Target layout), fixed external paths (Global Constraints), layering test (Task 2), tests that read paths (Task 4), docs (Task 5), gates for a package the installer and Docker run (Task 5, Review Focus 1).
- Risks not covered by a test: a path in a shell script or unit that names a `dist/` file other than the three kept ones. The base commit has none (`grep -rn "tls/dist" packaging Dockerfile compose.yaml` lists only `cli.js`, `health-check.js` and `index.js`); Task 5 Step 4's packaging and compose runs are the check.
- Open decisions for the person (the plan stands if they say nothing): the five folder names; `runtime-status.ts` in `ca/`; `sidecar.ts` in `cli/` rather than at the top (it is a subcommand of `pipulse tls`, so its public path is the command, not the file).
