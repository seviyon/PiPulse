# CI speed-up: sharded packaging tests

## Intent

A pull request is done when its slowest job is. Shorten that wait without
running fewer tests. Measured on `main` (2026-11-24): `packaging` 859 s,
`packaging-verify` 507 s, every other job 161 s or less. Target: about 9 minutes
instead of about 14.

## Goals, non-goals, anti-goals

- Goals: split `packaging` into two shards; cancel superseded pull request runs.
- Non-goals: skipping jobs on docs-only changes; splitting `packaging-verify`;
  sharing builds between jobs.
- Anti-goals: a test that silently stops running; a pull request that can merge
  with a failed shard; a change to `main`'s required checks.

## Approaches

- **A (picked):** two shards and cancel-in-progress. Small change, about 14 → 9
  minutes.
- **B:** A plus a docs-only skip. Docs pull requests drop to about 3 minutes, but
  wrong change detection skips tests, and `build-and-test` must still run because
  `packages/api/test/coderabbit-config.test.ts` reads repository documents.
- **C:** A plus a split `packaging-verify` and a third shard. About 6 minutes, but
  rewrites the release verifier's test, which guards signing.

A was picked for the largest gain at the least risk. B can follow later.

## Design

- `packaging-shard`: a two-leg matrix with today's `packaging` container, tools,
  `npm ci` and build.
  - Shard 1: `fetch-node`, `tarball`, `setup`, `service`, `install`, `release`,
    `migrate-tls` and `rollback`, then the TLS unit tests as root.
  - Shard 2: `tls`, `deb`, `next-version`, `pr-bump`, `apt`, `migrate` and `run`
    (the test of `run.sh` itself, added with this change).
  - `fail-fast: false`, so one failure does not hide the other shard's result.
- `packaging`: keeps its name (it is a required check). It needs
  `packaging-shard`, runs with `if: always()`, and succeeds only when the shards'
  result is `success` (failed, cancelled and skipped all fail it).
- `packaging/test/run.sh` owns the declared test list and the shard lists
  (`--shard 1|2`). Before running any shard it checks, and fails on a mismatch:
  - the `*.test.sh` files on disk and the declared list name the same tests (a
    new file left out of the list fails, and so does a listed test with no file,
    which today only prints "skipped");
  - every declared test is in exactly one place: shard 1, shard 2 or
    `verify-release`'s own job.
- `concurrency`: the group is the workflow plus the pull request number for pull
  request runs, or the commit SHA for push runs; `cancel-in-progress` is true only
  for pull requests. A new push to a pull request cancels its older run. Runs on
  `main` must not share `github.ref` as a group: GitHub replaces an older pending
  run in a group even when `cancel-in-progress` is false.

## Proof

- Each shard passes in a clean Debian container (the new order is not yet proven:
  tests appear to reset their own state).
- `run.sh` fails when a test file is missing from the declared list, when a listed
  test has no file, and when a test is left out of both shards or put in both.
- CI is green on the pull request, and the job durations are recorded in it.

No release label. The user merges.

## Left to the builder

Step names, how the coverage guard is tested, comment wording.
