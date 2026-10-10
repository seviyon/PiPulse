# Exit criterion: Playwright end-to-end suite (manual)

Run by a person. Nothing here touches `Io`. All paths are absolute.

1. **CI.** On the PR that adds this file, the five existing checks and the single `e2e` check are green. Open one `e2e` job and note its step count, and that the browser cache hit on the second run.
2. **Mac, clean clone.**
   ```
   cd /Users/seviyon/Repositories/PiPulse
   npm ci
   npm ci --prefix /Users/seviyon/Repositories/PiPulse/e2e
   npx --prefix /Users/seviyon/Repositories/PiPulse/e2e playwright install chromium
   npm run test:e2e
   ```
   Everything passes in Chromium.
3. **Break one thing at a time** on a scratch branch, watch the right test fail with a useful trace, then revert:
   - `packages/web/src/live.ts`: set `FIRST_RETRY_MS` to `60000` → only `reconnect.e2e.ts` fails.
   - `packages/api/src/index.ts`: change the `4401` close code to `1000` → the read-protection test in `auth.e2e.ts` fails (and the `packages/api` unit tests).
   - `packages/web/src/settings-page.tsx`: drop `disabled={deletes && !confirmed}` from Save → `settings.e2e.ts` fails.
   - `e2e/src/harness/hook.ts`: in `resolve`, return `nextResolve(specifier, context)` unconditionally (drop the fake branch) → every test fails with "fake collector not loaded".
4. **Repeat.** `cd /Users/seviyon/Repositories/PiPulse/e2e && npx playwright test --repeat-each=5` → no failure.
5. **Greps and packaging.**
   - `grep -rn "waitForTimeout" /Users/seviyon/Repositories/PiPulse/e2e/specs` is empty, and `setTimeout` appears only as the 10 s rejection guard inside the page in `auth.e2e.ts` (not a sleep).
   - `grep -rn "PIPULSE_E2E" /Users/seviyon/Repositories/PiPulse/packages` is empty.
   - `sh /Users/seviyon/Repositories/PiPulse/packaging/build-tarball.sh 0.0.0-e2e /Users/seviyon/Repositories/tarballs/PiPulse/e2e-check` produces a tarball with no `e2e` folder.
6. **Confirm `Io` was not touched.**

Record the result in `CLAUDE.md` (one paragraph, like the phases'), then merge.
