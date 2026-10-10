# Releasing PiPulse

How versions get made, what a release publishes, and the one-time GitHub setup it needs. The design is in `docs/superpowers/specs/2026-09-28-packaging-design.md`.

## How releases happen

- **A release is a merged PR with a label.** Merging a PR into `main` with `release:patch`, `release:minor` or `release:major` makes the next version from the newest `v*` tag (the first release is `v0.6.0`). A PR without one of those labels releases nothing. Phase 6b ships as four PRs: 6b-1 (TLS core, own certificate) merges with `release:patch` (→ v0.6.3); 6b-2a (generated CA, opt-in) with `release:patch` (→ v0.6.4); 6b-2b (status, expiry alerts, Settings) with `release:patch` (→ v0.6.5); and 6b-2c (HTTPS by default) with `release:minor` (→ v0.7.0).
- **Release-note hint for v0.6.3:** `/api/health` now reports `"status":"degraded"` (still HTTP 200) on an install that has a sign-in password but serves plain HTTP. Uptime monitors that match `"status":"ok"` should match `"monitoring":"ok"` instead.
- **Renovate releases only what ships.** Its PRs for runtime `dependencies`, the bundled Node (`packaging/node-versions.json`), the Docker base image, and every security alert carry `release:patch`, so they reach the Pis in a release of their own. Development tools, test libraries and action pins still update, but release nothing: they ride along with the next release. Patch and minor updates merge themselves once CI passes; majors wait for review.
- **Or by hand:** Actions → _Release_ → _Run workflow_, with a version (e.g. to redo a release whose run failed; the version must not be tagged yet).
- **Only plain `X.Y.Z` versions** are released: a pre-release like `0.7.0-rc.1` would sort above `0.7.0` in apt and strand the Pis that installed it.
- **The signing key never meets npm.** The release's `build` job (npm and project code) runs with no secrets and a read-only token; only the `publish` job has `APT_SIGNING_KEY`, and it runs no npm or project code. The jobs that only pull base images (`image`, `verify`, the dry run and CI's `docker` and `packaging`) log in to Docker Hub with a read-only, public-repositories token, because anonymous pulls from the shared runners often hit Docker's rate limit. The Dockerfile installs with `--ignore-scripts`, and BuildKit's build steps run in their own container that cannot read the runner's login.
- **Versions exist only in releases.** The `package.json` files stay at `0.0.0`; the release build writes `version.json` into what it ships, and nothing commits to `main`.

`.github/workflows/release.yml` then, in one run:

1. tests and builds once, and assembles `pipulse-<version>.tar.gz`;
2. builds `pipulse_<version>_{armhf,arm64,amd64}.deb`, each with its Node (downloaded and GPG-verified), and runs `lintian` on them;
3. pushes `ghcr.io/seviyon/pipulse:<version>` and `:latest` (`linux/arm64`, `linux/amd64`);
4. adds the `.deb`s to the apt repository on the `gh-pages` branch (keeping the newest 3 per CPU), signs its indexes, and force-pushes the branch as a single fresh commit, so old packages don't pile up in its history;
5. writes and signs `SHA256SUMS`, tags `v<version>`, and publishes the GitHub Release with the tarball, `.deb`s, `install.sh`, `compose.yaml` and the checksums (the shipped `compose.yaml` is rewritten to this release's image tag; the copy in the repository follows `:latest`, so until a release finishes its image can be older than the file, and a Renovate digest PR opened in that window would pin the old one: close it or let the next release's PR replace it);
6. installs the new version from the apt repository in a clean Debian container, exactly as the README tells users to.

A PR that changes `packaging/`, the Dockerfile, `compose.yaml` or a workflow also runs _Release dry run_, which builds all of the above without signing or publishing.

## One-time setup

Do these once, before merging the Phase 6 PR.

1. **Renovate.** Install the app at <https://github.com/apps/renovate> → _Configure_ → _Only select repositories_ → `PiPulse`. It opens an onboarding PR; merge it (it only confirms `renovate.json`).
2. **Protect `main`.** Settings → Branches → add a rule for `main`: require a pull request, require status checks `build-and-test (22.x)`, `build-and-test (24.x)`, `shellcheck`, `packaging` and `docker`. Settings → General → _Allow auto-merge_ (Renovate merges through it, so only green PRs merge).
3. **Labels.**

   ```bash
   gh label create release:patch --color 0e8a16 --description 'Merging releases a patch version'
   gh label create release:minor --color 1d76db --description 'Merging releases a minor version'
   gh label create release:major --color d93f0b --description 'Merging releases a major version'
   ```

4. **The apt signing key.** Make it on a trusted machine, store it as two repository secrets, and keep an offline copy:

   ```bash
   gpg --quick-gen-key 'PiPulse apt repository <seviyon@users.noreply.github.com>' rsa4096 sign 3y
   gpg --armor --export-secret-keys 'PiPulse apt repository' | gh secret set APT_SIGNING_KEY
   gh secret set APT_SIGNING_PASSPHRASE          # paste the passphrase you chose
   gpg --armor --export-secret-keys 'PiPulse apt repository' > pipulse-apt-key.asc   # move it offline, then delete it here
   ```

5. **GitHub Pages.** The first release creates the `gh-pages` branch. Straight after it, Settings → Pages → _Deploy from a branch_ → `gh-pages` / `/ (root)`. The first release's last step waits up to 10 minutes for Pages to serve the repository; if it times out because Pages wasn't on yet, turn it on and re-run that job.

6. **Docker Hub login (CI only, read-only).** Create an access token at Docker Hub → Account settings → Personal access tokens with permission _Repo Public Read-only_ (nothing is ever pushed to Docker Hub: release images go to GHCR), then store it:

   ```bash
   gh secret set DOCKERHUB_USERNAME              # your Docker Hub username
   gh secret set DOCKERHUB_TOKEN                 # paste the token
   ```

   Without these, the jobs above fail at their login step. If the token has an expiry, replace the secret before it passes.

## Rotating the apt key

Before it expires (3 years) or if it may have leaked:

1. Make a new key as in step 4 and replace both secrets.
2. Release (a `release:patch` PR, or _Run workflow_). The repository and `pipulse.gpg` are re-signed with the new key.
3. Pis that added the old key must fetch the new one once:

   ```bash
   curl -fsSL https://seviyon.github.io/PiPulse/apt/pipulse.gpg | sudo tee /usr/share/keyrings/pipulse.gpg >/dev/null
   ```

   A leaked key means someone else could sign packages Pis would install: rotate at once and say so in the release notes.

## A new Node major

Renovate proposes it as a major update (it waits for review). Before merging:

- add the line's end of security support to `NODE_SUPPORT_ENDS` in `packages/api/src/version.ts` (from <https://github.com/nodejs/Release>), so the About section and the startup log know it;
- check `allowedVersions` in `renovate.json` still covers it;
- for `armhf`, there is nothing after Node 22 (no 32-bit ARM builds), which is why Renovate keeps it below 23.

If a Node download fails verification with an unknown key, Node has added a releaser: refresh `packaging/node-keys/pubring.kbx` (see its README).
