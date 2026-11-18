# CA purpose limits (TLS review PR 3) — verification gate

Gate for PR 3 of the 2026-11-16 TLS review. PR 3 is not merged until **Part A (automated, in the PR) is green and Part B (manual, browsers) is recorded**. Part A proves the new limits reject what they should; Part B only proves that ordinary HTTPS names still load in real browsers. Neither replaces the other.

## What PR 3 changes in a generated CA

Today's CA certificate has `basicConstraints = critical, CA:TRUE, pathlen:0` and a critical `nameConstraints` with permitted/excluded DNS and IP subtrees. PR 3 adds, to the CA only (never the leaf):

1. `extendedKeyUsage = serverAuth`. Intended effect: a store that honours a CA's EKU (Windows and Debian-style stores are the ones that matter, since macOS trust is already limited with `-p ssl`) should trust the CA for web servers only, not for the purposes Part A tests (client authentication, S/MIME signing, code signing). **This is the intent; it is not verified on those stores** (see "Not covered").
2. `permitted;email:.invalid` in `nameConstraints`: confines the email names the CA may vouch for to the reserved `.invalid` namespace (RFC 2606), which no public mailbox uses. It is a namespace restriction, not proof that no such mailbox exists: a private system could still use that namespace.
3. `permitted;URI:.invalid`: the same confinement for URI names.

Risk to find: an unfamiliar extension on a trust anchor is where verifiers differ. A client that refuses the CA, or stops loading names it loaded before, makes PR 3 unshippable or needs a line dropped. Watch most for constraint types a client does not know being treated as "refuse everything".

---

## Part A — automated tests PR 3 must contain (blocking)

All use the real `issueCa` path and real OpenSSL (`packages/tls/test/openssl.ts`), in `packages/tls` itself, and are mutation-tested like other `ca/` code (`npm run mutate`, survivors killed or argued equivalent in the PR).

1. **Extensions present.** A CA from `issueCa` has EKU exactly `serverAuth` and `nameConstraints` containing `email:.invalid` and `URI:.invalid`, alongside today's DNS/IP subtrees. The leaf has no new CA-only extension.
2. **The CA's EKU is enforced, not just the leaf's.** Use a leaf whose own EKU is permissive (no EKU extension, or `serverAuth, clientAuth, codeSigning, emailProtection`), so the only thing that can block a purpose is the CA. Verify against the CA with `openssl verify -purpose sslserver` (passes) and then `-purpose sslclient` and `-purpose smimesign` (each must fail, and the error must be the CA's purpose restriction, i.e. "unsuitable certificate purpose" at the CA's depth, not "unable to get issuer"). Also verify a leaf whose own EKU is `clientAuth` only fails `-purpose sslserver`, as a separate case. `openssl verify` has no code-signing purpose, so code signing is not tested here: the PR text and release note claim only client authentication and S/MIME signing as tested, and say code signing is intended but untested. If a purpose cannot be tested on the OpenSSL versions in use (1.1.1 on `Io`, 3.x on the Mac), narrow the claim the same way. Today's DNS/IP-only `issueLeaf` cannot do this: add a focused helper or fixture, not a change to the production leaf.
3. **Email and URI limits are enforced, each on its own.** With a helper that can issue a leaf carrying `email:` or `URI:` SANs, test the two types in separate leaves, so a broken limit on one cannot hide behind or cause a failure of the other: an email-only leaf (plus the permitted DNS name) and a URI-only leaf. Each type has a permitted case (`email:x@host.invalid`; `URI:https://host.invalid/`: verifies), a prohibited case (`email:x@example.com`; `URI:https://example.com/`: fails with a permitted-subtree violation) and a control: the same prohibited leaf verifies against a CA made with no purpose limits, which shows the CA's limit is what rejects it. Also show the two are independent: a CA with only the email line rejects the email case and not the URI one, and the reverse.
4. **Existing behaviour unchanged.** The current DNS/IP permitted and excluded cases still pass and fail as before.
5. **The kit refuses to run silently on the old CA.** `browser-kit.ts` takes a **required, validated** fourth argument: `base` (today's CA), `pr3` (all three lines), `pr3=eku`, `pr3=email`, `pr3=uri`. Any other value, or none, exits non-zero with a usage message. Today it reads only two arguments and would quietly generate the old CA, so a browser run could never have tested PR 3.
6. **Each kit mode changes exactly what it names.** Test the kit's CA builder (not the browsers): `base` has none of the three lines; `pr3` has all three; `pr3=eku` is `base` plus EKU only; `pr3=email` is `base` plus the email subtree only; `pr3=uri` is `base` plus the URI subtree only. "Isolated" means baseline plus that one line, never "all but that one".

Run: `cd /Users/seviyon/Repositories/PiPulse && npm test` and `npm run lint`.

---

## Part B — browser and client compatibility (manual, Mac only)

Run only after Part A is green. Nothing here touches `Io`.

**Sequencing.** The `-p ssl` trust command ships with PR #212 (PR 2). Until #212 is merged, run this gate on a PR 3 branch built on top of the #212 branch; after it merges, build PR 3 on `main`. Do not treat `main` as the source of that command before then. Today `browser-kit.ts` accepts only two arguments, so this checklist is runnable only once PR 3 has added the fourth.

**Ground rules**

- Kit output goes to a fresh folder outside any repo: `/Users/seviyon/Repositories/tarballs/PiPulse/browser-kit-pr3/`. Never trust the 2026-10-04 kit's CA at the same time.
- Note the macOS version, each browser's version, and the output of `curl -V` and `/usr/bin/curl -V` at the top of the record.
- Browsers: Safari and Firefox (Firefox needs `security.enterprise_roots.enabled` = `true` in `about:config`).
- **Trust command.** Use exactly what `pipulse tls export-ca` prints on the PR 2 build that will ship (PR #212, which adds `-p ssl`). Before step 5, open `packages/tls/src/cli/cmd-export.ts` on the branch under test and confirm its macOS line; if it differs from step 5 below, the file wins and this checklist is corrected first. (`main` did not have `-p ssl` until #212 merged.)

**Steps**

1. Build the kit: `cd /Users/seviyon/Repositories/PiPulse && npx tsx packages/tls/test/browser-kit.ts /Users/seviyon/Repositories/tarballs/PiPulse/browser-kit-pr3 "$(ipconfig getifaddr en0)" pr3`. It must succeed; running it without the fourth argument must fail with usage (try that once and record it).
2. Show the CA's extensions and paste them into the record: `/opt/homebrew/opt/openssl@3/bin/openssl x509 -in /Users/seviyon/Repositories/tarballs/PiPulse/browser-kit-pr3/ca.crt -noout -text`. Expect `X509v3 Extended Key Usage: TLS Web Server Authentication`; under `X509v3 Name Constraints` (critical) `Permitted:` with the DNS, IP, `email:.invalid`, `URI:.invalid` entries and the same `Excluded:` lines as before.
3. `sudo sh -c 'printf "127.0.0.1 pipulse-check pipulse-check.local other-check.lan x.pipulse-check io x.io # browser-kit-pr3\n" >> /etc/hosts'`
4. `node /Users/seviyon/Repositories/tarballs/PiPulse/browser-kit-pr3/serve.mjs` (leave it running; it must print `serving 8441-8447`).
5. Control, before trusting anything: with `-k`, every port must answer `port N ok`: `curl -k --resolve pipulse-check:8441:127.0.0.1 https://pipulse-check:8441/` and the same for each port and host in the matrix below. A port that does not answer here makes every "refused" result below worthless: fix the server first.
6. Curl matrix, one run per port and per client, **without** `-k`, using `--cacert /Users/seviyon/Repositories/tarballs/PiPulse/browser-kit-pr3/ca.crt` and `--resolve <host>:<port>:<ip>` as in step 5. Run both `curl` (Homebrew, OpenSSL) and `/usr/bin/curl` (the system one: an independent client with a different TLS library; do not assume it is stricter, record its `-V`).

   | Port | Host            | Expected               | Counts as a pass                                                              |
   | ---- | --------------- | ---------------------- | ----------------------------------------------------------------------------- |
   | 8441 | pipulse-check   | `port 8441 ok`, exit 0 | body and exit 0                                                               |
   | 8442 | 127.0.0.1       | `port 8442 ok`, exit 0 | body and exit 0                                                               |
   | 8443 | other-check.lan | refused                | exit 60 and a certificate message naming a subtree violation or name mismatch |
   | 8444 | Mac LAN IP      | refused                | exit 60 and a certificate message (outside the CA's IP ranges)                |
   | 8445 | x.pipulse-check | refused                | exit 60 and an excluded-subtree message                                       |
   | 8446 | io              | `port 8446 ok`, exit 0 | body and exit 0                                                               |
   | 8447 | x.io            | refused                | exit 60 and an excluded-subtree message                                       |

   A refused row passes **only** with a certificate-policy error. Exit 7 or 28, "connection refused", a timeout or an empty reply is a failed run, not a rejection. Record each client's exact message; wording differs between libraries, so "a certificate problem about the name/constraint" is the test, not one literal string.

7. Trust the CA with the command from the ground rules (expected on the shipping PR 2 build): `sudo security add-trusted-cert -d -r trustRoot -p ssl -k /Library/Keychains/System.keychain /Users/seviyon/Repositories/tarballs/PiPulse/browser-kit-pr3/ca.crt`
8. Fully quit and reopen each browser, then open the seven URLs and write **loads** or the exact error. Expected rows are the same as the curl table. Rejected rows must show a **certificate warning or error page** (a name or constraint problem), not a connection failure; if the page is a connection error, go back to step 5.
   Pass rule: identical to the 2026-10-04 run (the same three rows load, the other four are refused for certificate reasons). A row that changed either way is a failure.
9. If any browser or client fails, rebuild the kit as `pr3=eku`, `pr3=email` and `pr3=uri` (each is baseline plus that one line) and repeat steps 6 and 8 for the failing client to find the line it dislikes. **One CA at a time, each in its own folder** (`/Users/seviyon/Repositories/tarballs/PiPulse/browser-kit-pr3-eku`, `-email`, `-uri`; add the combination modes if the one-line variants all pass but full `pr3` fails: `eku`+`email`, `eku`+`uri`, `email`+`uri`). For each variant, in this order:
   1. Before trusting it, remove the previous CA from the Mac (step 10's trust, keychain and fingerprint items for that folder), so exactly one PiPulse browser check CA is ever trusted.
   2. Build the variant with step 1's command (its own folder, the variant as the fourth argument), then start `serve.mjs` from that folder (step 4); check with `-k` again (step 5).
   3. Run its fingerprint and write it in the record: `/opt/homebrew/opt/openssl@3/bin/openssl x509 -in <folder>/ca.crt -noout -fingerprint -sha1`.
   4. **Trust that variant** with step 7's command, using that folder's `ca.crt`. A browser run without this step tests nothing: every row would fail on trust, not on the limit under test.
   5. Fully quit and reopen the browser, repeat steps 6 and 8 for the failing client, then untrust and delete this variant (step 10's trust and keychain items) before the next one.
      Then decide: drop the line, or keep it for the stores that honour it.
10. Cleanup, then **verify** each item and record the result. Do it for the `pr3` CA and for every variant built in step 9, using the fingerprints recorded in the record below (so none is left behind, even one built and abandoned):
    - Stop `serve.mjs`; `pgrep -f browser-kit-pr3` prints nothing.
    - For each folder (`browser-kit-pr3`, `-eku`, `-email`, `-uri`, any combination): `sudo security remove-trusted-cert -d <folder>/ca.crt` (it prints an error for a folder whose CA was never trusted or already removed: note it, it is fine).
    - Delete the `# browser-kit-pr3` line(s) from `/etc/hosts`; `grep browser-kit /etc/hosts` prints nothing.
    - `remove-trusted-cert` removes only the trust settings, not the keychain item. Delete each item by its fingerprint: `FP=$(/opt/homebrew/opt/openssl@3/bin/openssl x509 -in <folder>/ca.crt -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)`, then `sudo security delete-certificate -Z "$FP" /Library/Keychains/System.keychain`.
    - Then verify: `security find-certificate -a -Z -c "PiPulse browser check CA" /Library/Keychains/System.keychain` finds nothing (every variant has that same name, so any hit is a leftover; compare against the recorded fingerprints), and `security dump-trust-settings -d` lists no PiPulse browser check CA.

---

## Record

Run 2026-11-17, kit built from `e6dcc0f` with mode `pr3` (CA SHA-256 `2F:6C:4E:F8:22:97:CA:D5:EF:6E:D0:9E:AA:90:1A:5C:16:0F:42:DD:4F:F9:F8:91:4D:CB:CF:4A:A8:D8:ED:56`). Step 2 showed `Extended Key Usage: TLS Web Server Authentication` and a critical `Name Constraints` with Permitted `DNS:pipulse-check`, `DNS:pipulse-check.local`, `DNS:localhost`, `DNS:io`, `IP:127.0.0.1/32`, `IP:::1/128`, `IP:10.99.0.0/24`, `email:.invalid`, `URI:.invalid` and Excluded `DNS:.pipulse-check`, `DNS:.localhost`, `DNS:.io`.

Versions: macOS 27.2.1 (26B131) · Safari 27.2 (22625.2.8.11.9) · Firefox 160.0 (aarch64) · `curl -V` curl 8.7.1 (x86_64-apple-darwin26.0) libcurl/8.7.1 (SecureTransport) LibreSSL/3.3.6 · `/usr/bin/curl -V` the same binary (`which -a curl` finds only `/usr/bin/curl`; no Homebrew curl was installed)

Loads = `port N ok`. Refused = a certificate error. The `-k` control (step 5) answered on all seven ports first.

| Client                | 8441                                              | 8442  | 8443                       | 8444                       | 8445                      | 8446  | 8447                      | Matches 2026-10-04 run? | Rejections were certificate errors?  |
| --------------------- | ------------------------------------------------- | ----- | -------------------------- | -------------------------- | ------------------------- | ----- | ------------------------- | ----------------------- | ------------------------------------ |
| curl (macOS, above)   | loads                                             | loads | exit 60, permitted subtree | exit 60, permitted subtree | exit 60, excluded subtree | loads | exit 60, excluded subtree | yes                     | yes                                  |
| /usr/bin/curl (macOS) | same binary as the row above: one client, not two |       |                            |                            |                           |       |                           | n/a                     | n/a                                  |
| Safari                | loads                                             | loads | refused                    | refused                    | refused                   | loads | refused                   | yes                     | yes (operator report; text not kept) |
| Firefox               | loads                                             | loads | refused                    | refused                    | refused                   | loads | refused                   | yes                     | yes (operator report; text not kept) |

Gaps: The curl matrix is one client (SecureTransport with LibreSSL 3.3.6), not two; an OpenSSL-backed curl was not available. OpenSSL 3.x and 1.1.1w are covered by Part A, not here.

Variant fingerprints built (SHA-1 each; `pr3` and any step 9 variants): `pr3` `C44161FCB939DA4847544262BB1FACDFE0823F1F`; no step 9 variants (nothing failed) · Part A green on commit: `e6dcc0f` · Cleanup verified for every fingerprint (all items in step 10): ☑ (server stopped and `pgrep` empty, hosts line gone, no `PiPulse browser check CA` in the System keychain, no entry in `dump-trust-settings -d`)

Decision: ☑ ship all three lines ☐ ship without: ______ ☐ do not ship PR 3

## Not covered

Windows and Debian trust stores (no machine to run them on). The EKU line is there for them: until it is tried there, the PR and the release note say "intended to limit the CA to web servers on stores that honour EKU", never that it does.
