# Development

Building, testing and running PiPulse from a checkout. Requirements and variables are in [Configuration](configuration.md).

Requires **Node.js >=22.13.0** (for built-in `node:sqlite` support with no experimental flag).

```bash
git clone https://github.com/<your-username>/PiPulse.git
cd PiPulse
npm install
npm run build     # storage -> collector -> alerts -> api -> web, in dependency order
npm test          # builds, then runs the Vitest suites across all packages
npm run test:coverage   # the same with coverage; writes coverage/lcov.info (CI sends it to Codecov)
npm run dev       # runs the server (collector + API) in watch mode
```

The end-to-end tests (Playwright, Chromium only) live in the standalone `e2e/` folder and drive the real built server with fake plugins. Install their dependencies and the browser once, then run them (this builds first):

```bash
npm ci --prefix e2e
npx --prefix e2e playwright install chromium   # add --with-deps on Linux
npm run test:e2e
```

To run the server (collector + dashboard + REST API + WebSocket feed) from a build, then open `http://<host>:8889/` (an installed PiPulse reads the same variables from `/etc/pipulse/pipulse.env`):

```bash
PIPULSE_DB_PATH=~/pipulse-data/pipulse.sqlite PIPULSE_PORT=8889 \
  node --disable-warning=ExperimentalWarning packages/api/dist/server.js
```

To run only the collector daemon, without the API (writes to `PIPULSE_DB_PATH`, default `./pipulse.sqlite`; stop with Ctrl-C):

```bash
PIPULSE_DB_PATH=~/pipulse-data/pipulse.sqlite npm run start --workspace=packages/collector
```

> For dashboard development, run the server (`npm run dev`) and, in a second terminal, `npm run dev --workspace=packages/web`. Vite serves the dashboard on port 5173 and proxies `/api` and the WebSocket to the server (`PIPULSE_API`, default `http://localhost:8889`).

## Mutation testing

Coverage says which lines the tests ran; mutation testing says whether they would notice a change. [StrykerJS](https://stryker-mutator.io/) makes small edits to a source file (a `<` turned into `<=`, a condition forced to `true`, a string emptied), runs the tests for each edit, and reports the ones no test failed on ("survived").

```bash
# npm run mutate -- <package> <src-file[:from-to]> <test-file>...
npm run mutate -- tls src/runtime-status.ts:100-126 test/runtime-status.test.ts
```

Give it one file (or a line range) and the tests that cover it: every mutant runs those tests once, so a whole package takes a long time. The report prints in the terminal and as HTML in `packages/<package>/reports/mutation/index.html`. Neither `reports/` nor `.stryker-tmp/` is committed. The terminal prints nothing until the end, so a long run looks stuck: add `--bail=1` after the test files (`npm run mutate -- tls src/journal.ts test/journal.test.ts --bail=1`) so a mutant that is caught stops at its first failing test. The 236 mutants of `journal.ts` still took about 74 minutes; avoid running other test suites meanwhile, because a slowed mutant that hits the 60 s timeout counts as caught.

A surviving mutant is either a missing test or an _equivalent_ mutant that cannot change behaviour (the text of an error message a caller never reads, a type check that the next check makes redundant). Only the first kind is worth a test.

Stryker's own Vitest runner does not work with Vitest 5 yet (mutants never switch on and everything "survives"), so `scripts/mutate.mjs` uses its command runner, which runs `vitest run <test-files>` for each mutant. It is not part of CI.
