# CA purpose limits (TLS review PR 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (No such skill in your tool? The steps stand alone.)

**Goal:** Every CA that PiPulse generates from now on carries three more limits: `extendedKeyUsage = serverAuth`, `permitted;email:.invalid` and `permitted;URI:.invalid`. The leaf does not change. `browser-kit.ts` can build the old CA, the new one, or the old one plus exactly one of the three lines, so the manual browser check can test them.

**Architecture:** One pure switch, `PurposeLimits`, is added to `caExtensions()` in `packages/tls/src/ca/issue.ts`. `issueCa()` passes it through and defaults to all three limits on. Production callers (`stageNewCa`, and through it `init`, `new-ca` and the sidecar) never pass it. The browser kit passes it to build `base` (all off, which is byte for byte today's extension list) and the isolated modes. Enforcement is proven by running real `openssl verify` against leaves made by a test-only helper. Nothing reads the new extensions back. CAs that already exist are not reissued, and nothing about them changes.

**Tech Stack:** TypeScript, Node ≥ 22.13, Vitest, OpenSSL 3.x (Mac, CI) and 1.1.1w (a `node:22-bullseye` container; `Io` runs the same 1.1.1w but is not part of this plan's checks), StrykerJS via `npm run mutate`.

**Spec:** `/Users/seviyon/Repositories/PiPulse-checklist/docs/superpowers/checklists/2026-11-16-ca-purpose-limits-browser-check.md` (the verification gate). Part A items 1–6 are the blocking tests and map to Tasks 1–4. Part B is manual, and Task 8 hands it to the operator.

## Global Constraints

- CA only, never the leaf: `leafExtensions()` output and the "writes the leaf extensions exactly" test stay byte for byte as they are.
- The exact lines: `extendedKeyUsage = serverAuth` (not critical, following CA/Browser Forum practice for a CA's EKU, so a client that doesn't know the extension can ignore it) and `permitted;email:.invalid` and `permitted;URI:.invalid` inside the existing critical `nameConstraints`. They go after the IP permits and before the exclusions.
- `base` must equal today's CA: `caExtensions(scope, keyIds, NO_PURPOSE_LIMITS)` returns exactly the list the "writes the CA extensions exactly" test pins today.
- Issuance stays `/usr/bin/openssl` through `execFile` with a fixed argv. No new openssl subcommand or argv in `src/`. Test helpers may run `TEST_OPENSSL` directly, as `chain-constraints.test.ts` does.
- Tests live in `packages/tls` (coverage is per package) and use real OpenSSL through `packages/tls/test/openssl.ts`. Never use a hand-made DER for the enforcement cases.
- No new export from `packages/tls/src/index.ts`, so `index-surface.test.ts` stays unchanged. The kit imports `../src/ca/issue.js` directly.
- Claims, word for word in spirit: EKU is "intended to limit the CA to web servers on stores that honour a CA's extended key usage". Only **client authentication and S/MIME signing** are claimed as tested. **Code signing is intended but untested.** The Windows and Debian stores are untested. Never write "does" or "prevents".
- No migration and no `CaMeta`/`constraints.json` field. Existing CAs (10-year lifetime) keep working unchanged.
- Release label `release:patch`. Merge only after the gate's Part B is recorded.
- Work only in `/Users/seviyon/Repositories/PiPulse-pr3`. It has no `node_modules` yet, so run `npm ci` there once before Task 1. The machine has `ignore-scripts=true`, and that is expected.

## Decisions (settled here, with reasons)

**D1. How the kit shares code with `issueCa` without changing `base`.** Add a third parameter: `caExtensions(scope, keyIds = true, limits: PurposeLimits = PURPOSE_LIMITS)`. Add `issueCa({ …, limits?: PurposeLimits })`, documented "tests and the browser kit only", like `keyIds` already is (`issue.ts:317`). The kit calls the real `issueCa` with `kitLimits(mode)`, so the kit's CA goes through the production code path, and `base` comes from the same function with every limit off. I rejected two alternatives. Deleting lines from a production list with string edits in the kit is fragile, and it couldn't prove that `base` equals today's CA. A separate kit-only builder would drift from production. Two guards keep production on the new CA. A test pins that `stageNewCa`'s CA carries all three limits. Another test (Task 1) fails if any file under `src/` other than `issue.ts` mentions `PurposeLimits`, `NO_PURPOSE_LIMITS` or a `limits:` option.

**D2. Existing CAs.** Nothing reads a CA's EKU or its email/URI subtrees back, and nothing compares the CA certificate with an expected extension list. `checkCa()` (`material.ts:112`) checks that the certificate is a CA, that the key matches, and that `constraints.json`'s fingerprint is right. `checkLeaf()` (`material.ts:180`) runs `inspectMaterial` with the CA as the anchor. So an old CA is still `ok`, its fingerprint doesn't change (it isn't reissued), `renew` keeps signing leaves from it, and `restore-ca` of an old backup still works. The trust that devices already gave it is untouched. Only `init` (first CA), `new-ca` and the Docker sidecar's first start (all through `stageNewCa`, `material.ts:314`) make a CA with the limits, and `new-ca` already means trusting the CA again. `pipulse tls status`, `/api/health`, `/api/config` and Settings show nothing new. Showing whether a CA has the limits would need new DER reading in `src/` for display only, and that is new parsing in the riskiest package with no safety gain. The docs say instead how to get the limits (`new-ca`). Task 3 pins this with an old-style CA (`NO_PURPOSE_LIMITS`).

**D3. The inspect path.** `nameConstraints()` in `packages/tls/src/inspect/x509-constraints.ts:117-157` reads only tags `0x82` (DNS) and `0x87` (IP) and skips every other base ("Other name types (email, URI, directory name) are not checked, by design", line 153). An email (`0x81`) or URI (`0x86`) subtree therefore neither makes the result `'unreadable'` nor lands in `permitted`. `violatesNameConstraints()` counts only DNS and IP subtrees, also on the unreadable-SAN branch. The only reader that sees a generated CA is `checkLeaf` (`material.ts:194`, anchors = the CA) and `loadMaterial`'s generated branch (`inspect.ts:390`). The purpose check (`inspect.ts:310`) looks at the leaf's EKU only, never the anchor's. So no source change is expected there. Today that behaviour is covered only by hand-made DER (`chain-constraints.test.ts:425`). Task 3 adds a real-certificate test: an `issueCa` CA with the limits, plus a leaf from `issueLeaf`, gives `class: 'valid'` with no reasons. `nameConstraints()` on it returns the DNS and IP lists exactly and no `'unreadable'`.

**D4. OpenSSL 1.1.1 vs 3.x.** In both versions `v2i_GENERAL_NAME` parses `email:` as an rfc822Name and `URI:` as a uniformResourceIdentifier. `nc_email` and `nc_uri` treat a base that starts with a dot as a right-hand-side match on the mail domain or the URI's host. A violation is error 47, `permitted subtree violation`. A CA's EKU is enforced at the CA's depth through `check_chain_extensions` → `check_purpose` → `X509_check_purpose(x, purpose, 1)`, and `xku_reject` rejects a CA whose EKU lacks the purpose with error 26, `unsuitable certificate purpose`. This happens for the trust anchor too, because a plain PEM `-CAfile` carries no auxiliary trust that overrides it. 3.x adds SmtpUTF8Mailbox otherName matching, which no PiPulse certificate carries. `-purpose sslclient` and `-purpose smimesign` exist in both versions, and neither has a purpose 1.1.1 lacks for the cases we claim. Some 3.x builds may list a code-signing purpose, but it is deliberately not tested, because 1.1.1 has none and the gate's claim stays "untested". That is what the code says. Task 5 proves it by running the Task 2 suite on 1.1.1w. If a case cannot pass there, stop, record it in the PR, and narrow the claim as the gate says. Don't weaken the test. Pitfall to avoid in the test leaves: when a leaf has no DNS SAN, OpenSSL may check a hostname-like CN against the DNS constraints. Every test leaf therefore carries the permitted `DNS:pipulse-check` and a CN with a space (`purpose test`), so the result depends only on the SAN or EKU under test.

**D5. The leaf does not change.** `leafExtensions()` and `issueLeaf()` are untouched, and Task 1 keeps both exact-list tests. The permissive leaves the gate wants (no EKU, the four-purpose EKU, `clientAuth` only, email and URI SANs) come from a test-only helper (`test/ca/purpose-leaf.ts`) that signs with the CA's key through `TEST_OPENSSL x509 -req -extfile`, never through `issueLeaf`.

**D6. `consequenceText` keeps its shape and line count, and its second line gets a conditional wording (Task 7); `status` is unchanged.** `consequenceText(constraints)` (`constraints.ts:570`) knows only the DNS/IP constraints, and it is shown for old and new CAs alike (`status`, `init`, `new-ca`, `restore-ca`). Its second line ("These name limits cover web names and addresses only. A device that trusts this CA for every purpose would also accept what its key signs for other identities, such as email addresses …") is exact for an old CA but too absolute for a new one, whose email limit and EKU a verifier that enforces them applies. Task 7 makes it conditional on verifiers that ignore a CA's own limits, the same text for old and new CAs (no metadata, same line count). For a new CA the claim stays conservative: the email limit holds only on verifiers that enforce rfc822Name constraints, the EKU only on stores that honour a CA's EKU (untested on Windows and Debian), and other identity types (otherName/UPN, directory names) and code signing remain open. A wording that said the limits hold would overclaim. The line count stays the same, because `cmd-status.ts:306` (`slice(1)`) and `cmd-ca.ts:201` (`slice(2, 4)`) index into it. `cmd-export.ts:27` ("Windows and Debian/Ubuntu trust a CA for every purpose") stays too: it is about the store, and it is still the right advice.

**D7. Kit modes are exactly the gate's five.** They are `base`, `pr3`, `pr3=eku`, `pr3=email` and `pr3=uri`. Combinations (gate Part B step 9) are added only if a browser run needs them, in a follow-up that extends `KIT_MODES` and its tests. "Isolated" means `base` plus one line.

## Review Focus

1. **A production path that builds a `base` CA.** If `limits` leaks into `stageNewCa` or a CLI flag, every new install silently gets the old CA. Pinned by the `stageNewCa` test and the source-scan test (Task 1).
2. **An upgraded install whose CA predates this PR.** It must still be `ok` in `checkCa`, its leaf `ok` in `checkLeaf`, `renew` must sign from it, and `restore-ca` to it must work with no warning or prompt. Pinned in Task 3.
3. **The inspect reader meeting email/URI subtrees on a real certificate.** A wrong tag walk would read the chain as `degraded-untrusted` (`name-constraint`) and make `checkLeaf` refuse every new leaf, which would stop renewal. Pinned in Task 3 against a real `issueCa` CA.
4. **OpenSSL 1.1.1 (what `Io` runs) answering differently from 3.x on the Mac.** It could fail to parse `email:` or `URI:` in the config, or not enforce the CA's EKU. Pinned by running Tasks 1–4's tests on bullseye's 1.1.1w in a container (Task 5). That container is the intended check: no run on `Io` is planned, and the PR must say 1.1.1w was tested in a container, never on the Pi.
5. **A kit run that silently tests the old CA.** A typo such as `pr-3` or `PR3`, or a missing argument, must exit non-zero, print usage, and create no output folder. Pinned in Task 4.

---

### Task 1: Purpose limits in the CA's extensions

**Files:**

- Modify: `packages/tls/src/ca/issue.ts` (`caExtensions` lines 115–134, `issueCa` lines 311–331; new exports beside `IssueScope`)
- Test: `packages/tls/test/ca/issue.test.ts`, `packages/tls/test/ca/issue.mutation.test.ts`, `packages/tls/test/ca/material.test.ts`

**Interfaces:**

- Produces (all from `src/ca/issue.ts`):
  - `export interface PurposeLimits { eku: boolean; email: boolean; uri: boolean }`
  - `export const PURPOSE_LIMITS: Readonly<PurposeLimits>` (all `true`, `Object.freeze`d)
  - `export const NO_PURPOSE_LIMITS: Readonly<PurposeLimits>` (all `false`, frozen)
  - `caExtensions(scope: IssueScope, keyIds = true, limits: PurposeLimits = PURPOSE_LIMITS): string[]`
  - `issueCa(options: { …existing…; limits?: PurposeLimits })`, where the default is `PURPOSE_LIMITS`

- [ ] **Step 1: Write the failing tests.** In `issue.mutation.test.ts` → `describe('extension lists')`:
  - Rename the existing exact-list test to `'writes the base CA extensions exactly (today's CA)'`, and make it call `caExtensions(SCOPE, true, NO_PURPOSE_LIMITS)` with **the existing expected array unchanged**. Keep `toHaveLength(3)` for `caExtensions(SCOPE, false, NO_PURPOSE_LIMITS)`.
  - Add `'writes the CA extensions with purpose limits exactly'`. `caExtensions(SCOPE, true)` must equal `['basicConstraints = critical, CA:TRUE, pathlen:0', 'keyUsage = critical, keyCertSign, cRLSign', 'extendedKeyUsage = serverAuth', 'subjectKeyIdentifier = hash', 'nameConstraints = critical, permitted;DNS:pipulse-check, permitted;DNS:pipulse-check.local, permitted;DNS:localhost, permitted;IP:127.0.0.1/255.255.255.255, permitted;IP:::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff, permitted;IP:192.168.77.0/255.255.255.0, permitted;email:.invalid, permitted;URI:.invalid, excluded;DNS:.pipulse-check, excluded;DNS:.localhost']`, and `caExtensions(SCOPE)` must equal `caExtensions(SCOPE, true, PURPOSE_LIMITS)`.
  - Add `'adds exactly the limit it is given'`. For each of `{eku}`, `{email}` and `{uri}` alone, compare the output with base. The `eku` case is base with `'extendedKeyUsage = serverAuth'` inserted at index 2. The `email` and `uri` cases are base with only the `nameConstraints` line changed, by `, permitted;email:.invalid` (or `, permitted;URI:.invalid`) inserted before `, excluded;`.
  - Add `'the limit constants are frozen and complete'`. `PURPOSE_LIMITS` must deep-equal `{eku:true,email:true,uri:true}`, `NO_PURPOSE_LIMITS` must be all `false`, and both must be `Object.isFrozen`.
  - Add `'only issue.ts can turn the limits off'`. Read every `.ts` under `packages/tls/src` except `ca/issue.ts`, and expect none to match `/PurposeLimits|NO_PURPOSE_LIMITS|\blimits\s*:/`.

  In `issue.test.ts` → `describe('issueCa')`, add `'gives a CA serverAuth only and confines email and URI names to .invalid'`. Run `text(ca.certPem)` (the file's existing `openssl x509 -text` helper) and expect it to match `/X509v3 Extended Key Usage:\s*\n\s*TLS Web Server Authentication\s*\n/` (not critical, nothing else on the line), `/Permitted:[\s\S]*email:\.invalid[\s\S]*URI:\.invalid[\s\S]*Excluded:/`, and to still hold the DNS, IP and `Excluded:` lines. `new X509Certificate(ca.certPem).keyUsage` must equal `['1.3.6.1.5.5.7.3.1']`. Add `'leaves the CA as it was with NO_PURPOSE_LIMITS'`: a CA issued with `limits: NO_PURPOSE_LIMITS` has no `Extended Key Usage`, no `email:` and no `URI:` in its text, and `keyUsage` is `undefined`. Add `'gives the leaf nothing new'`: a leaf from the limited CA has no `Name Constraints`, and its `keyUsage` equals `['1.3.6.1.5.5.7.3.1']`.

  In `material.test.ts` → `describe('stageNewCa')`, add `'makes the CA with all three purpose limits'`. The staged `ca.crt` text has the EKU line and both `.invalid` subtrees.

- [ ] **Step 2: Run them and see them fail.** Run `cd /Users/seviyon/Repositories/PiPulse-pr3 && npx vitest run --root packages/tls test/ca/issue.test.ts test/ca/issue.mutation.test.ts test/ca/material.test.ts`. Expected: failures on the missing exports and the extension text. The base exact-list test should fail only on the import.

- [ ] **Step 3: Implement.** In `caExtensions`, add the two permits after the IP permits when `limits.email` / `limits.uri` is set, and the EKU line after `keyUsage` when `limits.eku` is set. Leave the existing checks and the order of the other lines exactly as they are. `issueCa` passes `options.limits ?? PURPOSE_LIMITS`. Update the doc comment on `IssueScope`/`caExtensions` to name the two `.invalid` permits and to say that the EKU is "intended to limit the CA to web servers where a store honours a CA's EKU".

- [ ] **Step 4: Run them again and see them pass,** then the whole package: `npm run build && npx vitest run --root packages/tls`. Expected: all pass. CAs from `issueCa` now carry the limits everywhere, including the `health-check*.test.ts` TLS handshakes (Node's client verifies with the `sslserver` purpose).

- [ ] **Step 5: Commit** `feat(tls): limit generated CAs to serverAuth and .invalid email/URI names`.

### Task 2: Prove enforcement with real OpenSSL (gate items 2–4)

**Files:**

- Create: `packages/tls/test/ca/purpose-leaf.ts` (helper; not a test file)
- Create: `packages/tls/test/ca/purpose-limits.test.ts`

**Interfaces:**

- Consumes: `issueCa`, `PURPOSE_LIMITS`, `NO_PURPOSE_LIMITS` (Task 1), `TEST_OPENSSL`, `tempDir`.
- Produces (in `purpose-leaf.ts`):
  - `signTestLeaf(o: { dir: string; ca: { keyPath: string; certPath: string }; name: string; san: string; eku?: string }): string`. It writes `<dir>/<name>.key` (P-256), the CSR and `<name>.ext` (`basicConstraints = critical, CA:FALSE`, `keyUsage = critical, digitalSignature`, `subjectAltName = <san>`, and `extendedKeyUsage = <eku>` only when it is given), signs with `TEST_OPENSSL x509 -req -CA -CAkey -CAcreateserial -days 30 -extfile`, and returns the leaf's path. The subject is `/CN=purpose test` (a space, so it never reads as a host name, D4).
  - `verifyAgainst(caPath: string, leafPath: string, purpose?: 'sslserver' | 'sslclient' | 'smimesign'): { ok: boolean; output: string }`. It runs `TEST_OPENSSL verify -CAfile <ca> [-purpose p] <leaf>` with `spawnSync` and returns `ok` when the exit status is 0 and `output` = stdout + stderr.

- [ ] **Step 1: Write the tests.** In `beforeAll`, make two CAs with the same `SCOPE` as `issue.test.ts`: `limited` (default limits) and `base` (`NO_PURPOSE_LIMITS`), each written as `ca.key`/`ca.crt` in its own temp folder. Let `PURPOSE = /error 26 at 1 depth lookup:\s*unsuitable certificate purpose/`, `LEAF_PURPOSE = /error 26 at 0 depth lookup:\s*unsuitable certificate purpose/` and `PERMITTED = /error 47 at 0 depth lookup:\s*permitted subtree violation/`.
  - `describe('the CA's EKU is enforced, not just the leaf's')`, with `it.each` over the leaf EKU `undefined` (no extension) and `'serverAuth, clientAuth, codeSigning, emailProtection'`, SAN `DNS:pipulse-check`:
    - `'passes sslserver'`: `verifyAgainst(limited, leaf, 'sslserver').ok` is `true`.
    - `'fails sslclient at the CA'` and `'fails smimesign at the CA'`: `ok` is `false`, `output` matches `PURPOSE`, and doesn't match `/unable to get (local )?issuer/`.
    - `'base CA passes all three (control)'`: against `base`, `sslserver`, `sslclient` and `smimesign` are all `ok`. This proves that the CA's EKU is what blocks.
  - `it('a clientAuth-only leaf fails sslserver at the leaf')`: leaf EKU `clientAuth`, against `limited` with `sslserver` → `ok` false and `output` matches `LEAF_PURPOSE`.
  - `describe('email names are confined to .invalid')`: leaves carry **only** `DNS:pipulse-check` plus an email SAN, never a URI, so a broken URI limit cannot hide behind or cause an email result:
    - permitted: `email:x@host.invalid` → `ok` against `limited`.
    - prohibited: `email:x@example.com` → not ok against `limited`, matching `PERMITTED`.
    - `NO_PURPOSE_LIMITS` control: the same prohibited leaf is `ok` against `base`.
  - `describe('URI names are confined to .invalid')`: the same three cases with **only** `DNS:pipulse-check` plus a URI SAN: `URI:https://host.invalid/` → ok; `URI:https://example.com/` → `PERMITTED`; the prohibited leaf is `ok` against `base`.
  - `describe('the email and URI limits are independent')`: two more CAs made with `issueCa({ …, limits })`, each base plus exactly one line (the same shapes as the kit's `pr3=email` and `pr3=uri`):
    - `emailOnly` = `{ eku: false, email: true, uri: false }`. The prohibited email leaf (`email:x@example.com`) **fails** with `PERMITTED`; the out-of-scope URI leaf (`URI:https://example.com/`) **verifies**; the permitted `host.invalid` email and URI leaves verify.
    - `uriOnly` = `{ eku: false, email: false, uri: true }`. The reverse: the out-of-scope URI leaf **fails** with `PERMITTED`; the out-of-scope email leaf **verifies**; the permitted ones verify.
    - Neither of these CAs has an EKU, so `sslclient` and `smimesign` verification of a plain leaf against them passes (the EKU limit is not leaking in).
  - `describe('DNS and IP limits are unchanged')`, against both `limited` and `base` (`it.each`), checking the same results on both:
    - `DNS:pipulse-check.local` and `IP:192.168.77.5` → ok.
    - `DNS:other-check.lan` and `IP:10.0.0.1` → `PERMITTED`.
    - `DNS:x.pipulse-check` → `/error 48 at 0 depth lookup:\s*excluded subtree violation/`.

- [ ] **Step 2: Prove that the tests can fail.** Temporarily change the `limited` CA in `beforeAll` to `limits: NO_PURPOSE_LIMITS`, run `npx vitest run --root packages/tls test/ca/purpose-limits.test.ts`, and expect exactly the sslclient, smimesign, email `example.com` and URI `example.com` cases to fail. Then revert. Paste the failing names into the PR description.

- [ ] **Step 3: Run it with the real CA.** Run the same command. Expected: all pass on OpenSSL 3.x.

- [ ] **Step 4: Commit** `test(tls): enforce the CA's EKU and .invalid email/URI limits with openssl verify`.

### Task 3: Existing CAs and the inspect reader

**Files:**

- Test: `packages/tls/test/ca/material.test.ts`, `packages/tls/test/inspect/chain-constraints.test.ts`
- Modify (only if a test fails): `packages/tls/src/inspect/x509-constraints.ts`. D3 expects no change. If one is needed, it needs its own fresh review (CLAUDE.md, the `packages/tls` rules).

**Interfaces:**

- Consumes: `issueCa(…, limits)`, `NO_PURPOSE_LIMITS`, `checkCa`, `checkLeaf`, `makeLeaf`, `stageCopiedCa`, `inspectMaterial`, `nameConstraints`.

- [ ] **Step 1: Write the tests.**
  - `material.test.ts`, new `describe('a CA made before purpose limits')`, using the file's existing layout and context helpers to write an old-style CA (`issueCa({ …, limits: NO_PURPOSE_LIMITS })`) with its `constraints.json`:
    - `'is still ok in checkCa with the same fingerprint'`: `checkCa(dir).kind` is `'ok'`, and `ca.fingerprint` equals the issued fingerprint.
    - `'signs a leaf that checkLeaf accepts'`: `makeLeaf` + `writeLeaf` → `checkLeaf(…).kind` is `'ok'`.
    - `'restores from a backup and stays without limits'`: `stageCopiedCa` from it → `validateStage` succeeds, and the copied `ca.crt` is byte-identical (no reissue).
  - `chain-constraints.test.ts`, new `describe('a generated CA with purpose limits')`:
    - `'reads only its DNS and IP subtrees'`: `nameConstraints(new X509Certificate(limited.certPem))` deep-equals the DNS permits, the IP permits (as bytes) and the excluded DNS of `SCOPE`, and is not `'unreadable'`.
    - `'its leaf inspects as valid with no reasons'`: `inspectMaterial({ source: 'generated', keyPem, certPems: [leaf.certPem], trust: { anchors: [limited.certPem], system: false }, names: [] })` has `class: 'valid'` and empty `reasons`.

- [ ] **Step 2: Run them.** Run `npx vitest run --root packages/tls test/ca/material.test.ts test/inspect/chain-constraints.test.ts`. Expected: pass with no source change, which confirms D2/D3. To see the inspect test can fail, temporarily make `nameConstraints` return `'unreadable'` for any base tag other than `0x82` and `0x87`, and check that both new tests fail. Then revert it, and don't commit it.

- [ ] **Step 3: Commit** `test(tls): old CAs and the inspect reader are unaffected by purpose limits`.

### Task 4: Browser kit modes (gate items 5–6)

**Files:**

- Create: `packages/tls/test/browser-kit-lib.ts`
- Modify: `packages/tls/test/browser-kit.ts` (it becomes the thin entry)
- Create: `packages/tls/test/browser-kit.test.ts`

**Interfaces:**

- Consumes: `issueCa`, `issueLeaf`, `PurposeLimits`, `PURPOSE_LIMITS`, `NO_PURPOSE_LIMITS`, `TEST_OPENSSL`.
- Produces (`browser-kit-lib.ts`):
  - `export type KitMode = 'base' | 'pr3' | 'pr3=eku' | 'pr3=email' | 'pr3=uri'`
  - `export const KIT_MODES: readonly KitMode[]`
  - `export const KIT_USAGE = 'usage: browser-kit.ts <outDir> <this Mac LAN IP> <base|pr3|pr3=eku|pr3=email|pr3=uri>'`
  - `export class KitUsageError extends Error`
  - `export function parseKitArgs(argv: string[]): { out: string; lanIp: string; mode: KitMode }`. It throws `KitUsageError` for fewer or more than three arguments, an empty one, or a mode not in `KIT_MODES` (exact, case-sensitive).
  - `export function kitLimits(mode: KitMode): PurposeLimits`. `base` gives `NO_PURPOSE_LIMITS`, `pr3` gives `PURPOSE_LIMITS`, and each `pr3=x` gives `{ ...NO_PURPOSE_LIMITS, x: true }`.
  - `export const KIT_SCOPE: IssueScope` (today's kit scope, moved unchanged)
  - `export function buildKitCa(o: { workDir: string; mode: KitMode; now: number; openssl?: string }): Promise<Issued>`. This is `issueCa` with subject `'PiPulse browser check CA'`, `KIT_SCOPE` and `kitLimits(o.mode)`.
  - `export async function runKit(argv: string[], io: { out(line: string): void; err(line: string): void }): Promise<number>`. On a usage error it prints `KIT_USAGE` to `err`, returns `2`, and creates nothing. Otherwise it makes the folder, writes `ca.key`/`ca.crt`, the seven leaves and `serve.mjs` exactly as today, prints `mode <mode>`, `CA SHA-256 …` and `wrote <out>`, and returns `0`.
  - `browser-kit.ts` keeps its header comment (naming the gate checklist) and becomes `process.exitCode = await runKit(process.argv.slice(2), { out: console.log, err: console.error })`.

- [ ] **Step 1: Write the failing tests** in `browser-kit.test.ts`:
  - `'refuses to run without a mode'`, `'refuses an unknown mode'` (`it.each` over `'pr-3'`, `'PR3'`, `'pr3=all'`, `'pr3=eku,email'`, `''`) and `'refuses extra arguments'`. `runKit([tmpOut, '10.0.0.5', …])` resolves to `2`, `err` received exactly `KIT_USAGE`, and `existsSync(tmpOut)` is `false`.
  - `'accepts exactly the five modes'`: `parseKitArgs` returns the mode for each of `KIT_MODES`, and `KIT_MODES` deep-equals the five literals in order.
  - `it.each(KIT_MODES)('%s changes exactly what it names')`: `buildKitCa({ workDir, mode, now })`, then `openssl x509 -text`. Assert that it has the EKU line iff the mode is `pr3` or `pr3=eku`, `email:.invalid` iff `pr3` or `pr3=email`, and `URI:.invalid` iff `pr3` or `pr3=uri`. Every mode keeps `KIT_SCOPE`'s DNS and IP permits and the `Excluded: DNS:.pipulse-check DNS:.localhost DNS:.io` line.
  - `'base is today's CA'`: `caExtensions(KIT_SCOPE, true, kitLimits('base'))` equals `caExtensions(KIT_SCOPE, true, NO_PURPOSE_LIMITS)`, and has neither `extendedKeyUsage` nor `.invalid`.
  - `'a full run writes the kit'` (mode `pr3`): it returns `0`, writes `ca.crt`, `ca.key` (mode `0600`), `8441.pem`…`8447.pem` and `serve.mjs`, and `out` starts with `mode pr3`.

- [ ] **Step 2: Run and see them fail** (`npx vitest run --root packages/tls test/browser-kit.test.ts`): module not found.
- [ ] **Step 3: Implement** `browser-kit-lib.ts` and the thin `browser-kit.ts`. Parse the arguments before any `mkdirSync`.
- [ ] **Step 4: Run and see them pass,** then `npm run lint`. The kit lives under `test/`, so the layering table in `module-layering.test.ts` (which is about `src/`) doesn't change. Check with `npx vitest run --root packages/tls test/module-layering.test.ts`.
- [ ] **Step 5: Smoke test.** `npx tsx packages/tls/test/browser-kit.ts /Users/seviyon/Repositories/tarballs/PiPulse/kit-smoke 10.0.0.5` prints the usage and `echo $?` gives `2`. Add `pr3` and it prints `mode pr3`. Delete `/Users/seviyon/Repositories/tarballs/PiPulse/kit-smoke` afterwards.
- [ ] **Step 6: Commit** `test(tls): browser kit takes a required, validated CA mode`.

### Task 5: The same tests on OpenSSL 1.1.1w

**Files:** none (run only; record the result in the PR).

- [ ] **Step 1: Run Tasks 1–4's tests on bullseye's OpenSSL.** Use the Colima pattern from CLAUDE.md: copy the repo in, don't bind-mount it read-write.

```bash
docker run --rm -v /Users/seviyon/Repositories/PiPulse-pr3:/src:ro node:22-bullseye sh -c '
  apt-get -qq update >/dev/null && apt-get -qq install -y rsync >/dev/null &&
  rsync -a --exclude node_modules /src/ /w/ && cd /w && npm ci --ignore-scripts >/dev/null &&
  /usr/bin/openssl version && npm run build >/dev/null &&
  PIPULSE_TEST_OPENSSL=/usr/bin/openssl npx vitest run --root packages/tls \
    test/ca/issue.test.ts test/ca/issue.mutation.test.ts test/ca/purpose-limits.test.ts \
    test/ca/material.test.ts test/inspect/chain-constraints.test.ts test/browser-kit.test.ts'
```

Expected: `OpenSSL 1.1.1w …` and everything passing. If a Task 2 case fails only here, don't change the assertion. Record the exact `openssl verify` output in the PR and narrow the claim in Task 7 for that purpose or name type (gate Part A item 2). If `x509 -text` wording differs (for example `URI:` spacing), loosen that regex only, and note the difference in the commit message.

- [ ] **Step 2: Add the line `OpenSSL 1.1.1w (node:22-bullseye container, not Io): <n> passed` to the PR description draft.**

### Task 6: Mutation run on the changed lines

**Files:** test files only, if a survivor needs a kill.

- [ ] **Step 1: Run on a copy** (CLAUDE.md: never in the working tree):

```bash
cp -cR /Users/seviyon/Repositories/PiPulse-pr3 /Users/seviyon/Repositories/PiPulse-pr3-mutate
cd /Users/seviyon/Repositories/PiPulse-pr3-mutate && npm run build
npm run mutate -- tls src/ca/issue.ts:<first>-<last line of PURPOSE_LIMITS..issueCa changes> \
  test/ca/issue.test.ts test/ca/issue.mutation.test.ts test/ca/purpose-limits.test.ts test/ca/material.test.ts --bail=1
npm run mutate -- tls test/browser-kit-lib.ts test/browser-kit.test.ts --bail=1
```

Take the exact line ranges from `git diff -U0 origin/main -- packages/tls/src/ca/issue.ts`. If `mutate.mjs` refuses a file outside `src/` for the kit, record that, and argue the kit's coverage from Task 4's per-mode tests instead.

- [ ] **Step 2: Kill or argue every survivor.** Expected kills come from the exact-list, per-limit and frozen-constants tests. Write any equivalent mutant up in the PR (file:line, mutant, why it can't change behaviour). Commit the new tests as `test(tls): kill purpose-limit mutants`. Delete `/Users/seviyon/Repositories/PiPulse-pr3-mutate` afterwards.

### Task 7: Docs, status note and PR text

- [ ] **Step 0: Reword the second line of `consequenceText`** (`packages/tls/src/ca/constraints.ts:574`) to: `These name limits cover web names and addresses only. A device or program that ignores a CA's own purpose and name limits, as some trust stores do, would also accept what its key signs for other identities, such as email addresses: trust it for TLS (web) use only where the system lets you choose.` Same single line, same output shape. Update the expected line in `packages/tls/test/ca/constraints.mutation.test.ts:334` (and any other exact-text expectation `grep` finds), run `npx vitest run --root packages/tls test/ca test/cli`, and commit `docs(tls): the CA scope warning says "ignores", not "every purpose"`.

**Files:**

- Modify: `docs/https.md` (the paragraph at line 51 about trusting the CA, and the CA description wherever it lists the CA's extensions)
- Modify: `CLAUDE.md` (one status paragraph after "Renovate per-package PRs and release signing")

- [ ] **Step 1: `docs/https.md`.** Keep the existing sentence about name limits, and add after it: "A CA made by PiPulse 0.8.<next> or later also carries `extendedKeyUsage = serverAuth`, which is intended to limit it to web servers on systems that honour a CA's extended key usage, and name constraints that confine any email address or URI it could vouch for to the reserved `.invalid` namespace. With OpenSSL, client authentication and S/MIME signing are refused under it. Code signing is intended to be refused but is untested, and so are the Windows and Debian trust stores, so the advice above stands: trust it for web use only where the system lets you choose, and only on devices you control. A CA made earlier keeps working unchanged. To get the limits, make a new one with `sudo pipulse tls new-ca` and trust it again on each device." Run `npm run format`.
- [ ] **Step 2: Add the `CLAUDE.md` paragraph.** It says what changed (CA-only, three lines, leaf unchanged), the `limits` switch (tests and the kit only, guarded by the source-scan test), that old CAs are untouched, the kit's required mode, and the 1.1.1w result from Task 5. Write it in the style of the surrounding paragraphs.
- [ ] **Step 3: Draft the PR description,** release label `release:patch`. The release note line: "New generated CAs carry `extendedKeyUsage = serverAuth` and `.invalid`-only email and URI name constraints, intended to limit the CA to web servers on stores that honour them. Client authentication and S/MIME signing are tested as refused with OpenSSL. Code signing and the Windows and Debian stores are untested. Existing CAs are unchanged. `sudo pipulse tls new-ca` makes one with the limits." Include Task 2 Step 2's failing names, Task 5's result and Task 6's survivors. Also state that merge waits for the gate's Part B record.
- [ ] **Step 4: Run** `npm test`, `npm run lint` and `npm run format` (all green), then `npm run test:e2e` (the `chromium-https` project issues a CA through the real path). Commit `docs(tls): CA purpose limits`.

### Task 8: Fresh-context review, then hand off Part B

- [ ] **Step 1: Get a review from a fresh context that didn't write the change,** on the strongest model (CLAUDE.md: `packages/tls` and issuance). Give it this plan, the gate, and `git diff origin/main`. Ask it specifically about Review Focus 1–5, D3's tag walk, and whether any wording claims more than the gate allows. Fix the findings and re-run `npm test`.
- [ ] **Step 2: Stop, and hand Part B to the operator.** Give them the gate's Part B steps as corrected in PR #218 (Part A item 3 split into separate email and URI cases; step 9 now trusts each diagnostic variant before browser testing and removes each variant's trust and keychain item by recorded fingerprint). Merge #218 first so the gate on `main` is that corrected one. Step 1 there is `npx tsx packages/tls/test/browser-kit.ts /Users/seviyon/Repositories/tarballs/PiPulse/browser-kit-pr3 "$(ipconfig getifaddr en0)" pr3`. `-p ssl` is on `main` since #212, so build on `main`, and confirm that `packages/tls/src/cli/cmd-export.ts`'s macOS line matches the gate's step 7. An agent doesn't run browsers or touch `Io`. The PR merges only once the record and its Decision box are filled in. If a line is dropped, return to Task 1 with that limit turned off in `PURPOSE_LIMITS`, and update Tasks 2, 4 and 7 to match.
