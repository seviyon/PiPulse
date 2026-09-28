# Phase 6 — Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PiPulse installable, upgradable and removable as a service — apt one-liner, release tarball, 64-bit Docker image — released automatically and kept current by Renovate.

**Architecture:** A few small app changes (`/api/health`, version and Node support, container/host-root awareness, prompt notification shutdown) land first, test-driven in Vitest. Packaging lives in `packaging/` as POSIX shell scripts sharing one `setup.sh`, tested by shell test scripts run in Debian containers in CI. One `release.yml` builds everything from a labelled PR merge and publishes GitHub Release assets, a GHCR image and a signed apt repository on `gh-pages`.

**Tech Stack:** Node 22/24, TypeScript, Fastify, Preact, Vitest (app); POSIX `sh`, `gpgv`, `dpkg-deb`, `lintian`, `apt-ftparchive`, `shellcheck` (packaging); Docker Buildx, GitHub Actions, Renovate.

**Spec:** `docs/superpowers/specs/2026-09-28-packaging-design.md`

## Global Constraints

- App requires Node `>=22.13.0`; bundled Node: `armhf` → 22 LTS (Renovate holds it `<23`), `arm64`/`amd64` → 24 LTS.
- Node end of support: 22 → `2027-04-30`, 24 → `2028-04-30`, 26 → `2029-04-30`; unknown line → `null`.
- Version stamped only into artifacts (`version.json` at the app root, `{"version":"X.Y.Z"}`); `package.json` files stay `0.0.0`; first release `v0.6.0`; no workflow commits to `main`.
- Paths: app `/opt/pipulse/app`, Node `/opt/pipulse/node`, command `/usr/bin/pipulse`, settings `/etc/pipulse/pipulse.env` (`root:pipulse 640`), folder `/etc/pipulse` (`root:pipulse 750`), data `/var/lib/pipulse` (`pipulse 700`), database `/var/lib/pipulse/pipulse.sqlite`.
- System user `pipulse`: no login shell, home `/var/lib/pipulse`, in `video` when that group exists.
- Default port stays `8888`; `setup.sh` only warns (ufw rule missing, port taken), never changes the firewall.
- Every Node download is verified: `SHASUMS256.txt.sig` checked by `gpgv` against `packaging/node-keys/pubring.kbx`, then the archive against `SHASUMS256.txt`.
- CPU comes from `dpkg --print-architecture` (fallback `uname -m` only where dpkg is missing); `armv6` refused.
- Docker: `linux/arm64` + `linux/amd64` only, base `node:24-bookworm-slim` pinned by digest, non-root, `PIPULSE_HOST_ROOT=/host`, `PIPULSE_IN_CONTAINER=true`, `HEALTHCHECK` on `/api/health`.
- `/api/health` is public even with `PIPULSE_PROTECT_READS=true`; `200 {"status":"ok"}` or `503 {"status":"unhealthy","problems":[...]}` with fixed strings `database unavailable`, `no readings for 5 min`.
- Release labels: `release:patch`, `release:minor`, `release:major`. Renovate labels its PRs `release:patch`; patch/minor automerge; majors wait.
- Shell scripts: POSIX `sh`, `set -eu`, pass `shellcheck`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Durations stay on the shared parser; don't reintroduce `pre*`/`post*` npm hooks (`ignore-scripts=true`).

## Review Focus

1. **Upgrade over a running install whose new version starts but can't collect or reach its DB** — `install.sh` must roll back (health `503`, not just "port answers"). Test in Task 8 (`rollback.test.sh` with a build whose `/api/health` answers `503`).
2. **`/etc/pipulse/pipulse.env` edited by the operator, then an upgrade** — never overwritten by `setup.sh` (tarball) and kept as a conffile (`.deb`). Tests in Task 7 (`setup.test.sh` "keeps an existing env") and Task 9 (`deb.test.sh` upgrade with an edited env).
3. **Pi 4 on 32-bit Pi OS (64-bit kernel, `armhf` userland)** — must get 32-bit Node. Test in Task 6 (`fetch-node.test.sh`: `PIPULSE_ARCH` from a faked `dpkg` printing `armhf` while `uname -m` says `aarch64`).
4. **A wall-clock jump (NTP after boot) while healthy** — `/api/health` must stay `200`. Test in Task 1 (monotonic clock, wall clock ignored).
5. **`PIPULSE_PROTECT_READS=true` behind Dockhand** — `/api/health` stays reachable while `/api/config` answers `401`. Test in Task 1.

---

## File Structure

| File                                                                                                  | Responsibility                                                                   |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/api/src/health.ts`                                                                          | Health state: `createHealth()`, `markReading()`, `check()`                       |
| `packages/api/src/version.ts`                                                                         | `readVersion()`, `NODE_SUPPORT_ENDS`, `nodeSupport()`                            |
| `packages/api/src/index.ts`                                                                           | `/api/health` route, `version`/`node` in `/api/config`, `PluginInfo.unavailable` |
| `packages/api/src/auth-routes.ts`                                                                     | `/api/health` in `PUBLIC_READS`                                                  |
| `packages/api/src/server.ts`                                                                          | Wire health, version, container plugins, startup log lines                       |
| `packages/collector/src/index.ts`                                                                     | `readDeviceInfo({ hostRoot })`                                                   |
| `packages/notify/src/sender.ts`                                                                       | Prompt `stop()`                                                                  |
| `packages/web/src/types.ts`, `tile.tsx`, `history.ts`, `about.tsx`, `settings-page.tsx`               | Unavailable tiles, About section                                                 |
| `packaging/node-versions.json`, `packaging/node-keys/pubring.kbx`                                     | Node pins and release keys                                                       |
| `packaging/lib.sh`                                                                                    | Shared shell helpers (`log`, `die`, `pipulse_arch`, `node_line`)                 |
| `packaging/fetch-node.sh`                                                                             | Download + verify Node for a CPU                                                 |
| `packaging/build-tarball.sh`                                                                          | Assemble `pipulse-<version>.tar.gz`                                              |
| `packaging/setup.sh`                                                                                  | User, folders, env, unit, warnings                                               |
| `packaging/pipulse.service`, `packaging/pipulse.env`, `packaging/pipulse`                             | Unit, env template, command                                                      |
| `packaging/install.sh`                                                                                | One-liner / tarball installer, rollback, uninstall                               |
| `packaging/deb/` (`control.in`, `postinst`, `prerm`, `postrm`, `conffiles`), `packaging/build-deb.sh` | `.deb`                                                                           |
| `packaging/apt-publish.sh`                                                                            | Update the signed apt repo tree                                                  |
| `packaging/test/*.test.sh`, `packaging/test/run.sh`                                                   | Shell tests (run in Debian containers)                                           |
| `Dockerfile`, `.dockerignore`, `compose.yaml`                                                         | Docker image and setup                                                           |
| `.github/workflows/ci.yml`, `.github/workflows/release.yml`                                           | CI and release                                                                   |
| `renovate.json`                                                                                       | Renovate                                                                         |
| `docs/RELEASING.md`                                                                                   | One-time GitHub setup, key rotation, how releases happen                         |

---

### Task 1: `/api/health`

**Files:**

- Create: `packages/api/src/health.ts`, `packages/api/test/health.test.ts`
- Modify: `packages/api/src/index.ts`, `packages/api/src/auth-routes.ts:45`, `packages/api/src/server.ts`

**Interfaces:**

- Produces:

```ts
export const READING_STALE_MS = 5 * 60_000;
export interface HealthResult {
  ok: boolean;
  problems: string[];
}
export interface Health {
  markReading(): void;
  check(): HealthResult;
}
export function createHealth(
  db: PiPulseDb,
  options?: { monotonic?: () => number; trackReadings?: boolean }
): Health;
// ServerOptions.health?: Health  — GET /api/health: 200 {status:'ok'} | 503 {status:'unhealthy', problems}
```

- [ ] **Step 1: Write the failing tests** (`packages/api/test/health.test.ts`)

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import { createHealth, READING_STALE_MS } from '../src/health.js';
import { buildServer } from '../src/index.js';
import { hashPassword, parsePasswordHash, type PasswordHash } from '../src/auth.js';

let db: PiPulseDb;
let mono: number;
beforeEach(() => {
  db = openDb(':memory:');
  mono = 0;
});
afterEach(() => db.close());

let passwordHash: PasswordHash;
beforeAll(async () => {
  passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
});

describe('createHealth', () => {
  it('is healthy at start and while readings arrive', () => {
    const health = createHealth(db, { monotonic: () => mono, trackReadings: true });
    expect(health.check()).toEqual({ ok: true, problems: [] });
    mono += READING_STALE_MS - 1;
    health.markReading();
    mono += READING_STALE_MS - 1;
    expect(health.check().ok).toBe(true);
  });

  it('reports no readings for 5 min, on the monotonic clock only', () => {
    const health = createHealth(db, { monotonic: () => mono, trackReadings: true });
    mono += READING_STALE_MS;
    expect(health.check()).toEqual({ ok: false, problems: ['no readings for 5 min'] });
  });

  it('ignores the wall clock (an NTP jump does not flip it)', () => {
    const realNow = Date.now;
    const health = createHealth(db, { monotonic: () => mono, trackReadings: true });
    Date.now = () => realNow() + 10 * 60 * 60_000;
    try {
      expect(health.check().ok).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it('skips the reading check when not tracking readings', () => {
    const health = createHealth(db, { monotonic: () => mono });
    mono += READING_STALE_MS * 10;
    expect(health.check().ok).toBe(true);
  });

  it('reports the database once it is unusable', () => {
    const health = createHealth(db, { monotonic: () => mono });
    db.close();
    expect(health.check()).toEqual({ ok: false, problems: ['database unavailable'] });
    db = openDb(':memory:');
  });
});

describe('GET /api/health', () => {
  it('answers 200 when healthy and 503 naming the problem when not', async () => {
    const health = createHealth(db, { monotonic: () => mono, trackReadings: true });
    const app = buildServer(db, { health });
    expect((await app.inject('/api/health')).json()).toEqual({ status: 'ok' });
    mono += READING_STALE_MS;
    const res = await app.inject('/api/health');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unhealthy', problems: ['no readings for 5 min'] });
    await app.close();
  });

  it('stays public when reads are protected', async () => {
    const app = buildServer(db, { auth: { passwordHash, protectReads: true } });
    expect((await app.inject('/api/config')).statusCode).toBe(401);
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    await app.close();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/api && NODE_OPTIONS=--disable-warning=ExperimentalWarning npx vitest run test/health.test.ts`
Expected: FAIL — `Cannot find module '../src/health.js'`.

- [ ] **Step 3: Implement `packages/api/src/health.ts`**

```ts
import type { PiPulseDb } from '@pipulse/storage';

/** Collection counts as stopped after this long without a stored reading. */
export const READING_STALE_MS = 5 * 60_000;

export interface HealthResult {
  ok: boolean;
  problems: string[];
}

export interface Health {
  /** Call on every stored reading (the scheduler's onSample). */
  markReading(): void;
  check(): HealthResult;
}

/**
 * Liveness for container managers and the installer: the database answers,
 * and (when tracking readings) something was stored recently. Measured on a
 * monotonic clock, so a wall-clock jump (NTP after boot) can't flip it.
 */
export function createHealth(
  db: PiPulseDb,
  options: { monotonic?: () => number; trackReadings?: boolean } = {}
): Health {
  const monotonic = options.monotonic ?? (() => performance.now());
  // Start counts as a reading: the first poll gets the full grace period.
  let lastReading = monotonic();
  return {
    markReading() {
      lastReading = monotonic();
    },
    check() {
      const problems: string[] = [];
      try {
        db.prepare('SELECT 1').get();
      } catch {
        problems.push('database unavailable');
      }
      if (options.trackReadings && monotonic() - lastReading >= READING_STALE_MS) {
        problems.push('no readings for 5 min');
      }
      return { ok: problems.length === 0, problems };
    }
  };
}
```

- [ ] **Step 4: Wire the route and public access**

In `packages/api/src/index.ts`: import `createHealth, type Health` from `./health.js`; add to `ServerOptions`:

```ts
  /** Liveness at /api/health (public); default checks only the database. */
  health?: Health;
```

and, next to `/api/config`:

```ts
const health = options.health ?? createHealth(db);
app.get('/api/health', async (_request, reply) => {
  const result = health.check();
  return result.ok
    ? { status: 'ok' }
    : reply.status(503).send({ status: 'unhealthy', problems: result.problems });
});
```

In `packages/api/src/auth-routes.ts:45`: `const PUBLIC_READS = new Set(['/api/session', '/api/health']);`

In `packages/api/src/server.ts`: `const health = createHealth(db, { trackReadings: true });` (import from `./health.js`), pass `health` to `buildServer`, and change the scheduler's `onSample` to:

```ts
  onSample: (sample) => {
    health.markReading();
    live.publish(sample);
  },
```

- [ ] **Step 5: Run and commit**

Run: `npm run build --workspace=packages/storage && cd packages/api && NODE_OPTIONS=--disable-warning=ExperimentalWarning npx vitest run` → all pass (existing auth tests included).

```bash
git add packages/api
git commit -m "Add /api/health for container managers and the installer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Version and Node end of support

**Files:**

- Create: `packages/api/src/version.ts`, `packages/api/test/version.test.ts`
- Modify: `packages/api/src/index.ts` (`/api/config`), `packages/api/src/server.ts` (startup log)

**Interfaces:**

- Produces:

```ts
export const NODE_SUPPORT_ENDS: Record<number, string>; // {22:'2027-04-30',24:'2028-04-30',26:'2029-04-30'}
export function readVersion(appRoot: string): string; // version.json's version, else 'dev'
export interface NodeSupport {
  version: string;
  line: number;
  supportEnds: string | null;
  ended: boolean;
}
export function nodeSupport(nodeVersion?: string, today?: Date): NodeSupport; // nodeVersion like 'v22.23.3'
// ServerOptions.version?: string; ServerOptions.node?: NodeSupport → /api/config gains `version` ('dev' default) and `node`
```

- [ ] **Step 1: Failing tests** (`packages/api/test/version.test.ts`)

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '@pipulse/storage';
import { buildServer } from '../src/index.js';
import { nodeSupport, readVersion } from '../src/version.js';

describe('readVersion', () => {
  it('reads version.json, or reports dev without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-version-'));
    expect(readVersion(dir)).toBe('dev');
    writeFileSync(join(dir, 'version.json'), '{"version":"0.6.0"}');
    expect(readVersion(dir)).toBe('0.6.0');
    writeFileSync(join(dir, 'version.json'), 'not json');
    expect(readVersion(dir)).toBe('dev');
  });
});

describe('nodeSupport', () => {
  it('knows each line and whether its support ended', () => {
    expect(nodeSupport('v22.23.3', new Date('2027-04-30T12:00:00'))).toEqual({
      version: '22.23.3',
      line: 22,
      supportEnds: '2027-04-30',
      ended: false
    });
    expect(nodeSupport('v22.23.3', new Date('2027-05-01T00:00:01')).ended).toBe(true);
    expect(nodeSupport('v24.21.0', new Date('2026-09-28')).supportEnds).toBe('2028-04-30');
  });

  it('never guesses for an unknown line', () => {
    expect(nodeSupport('v99.0.0', new Date('2030-01-01'))).toEqual({
      version: '99.0.0',
      line: 99,
      supportEnds: null,
      ended: false
    });
  });
});

describe('/api/config', () => {
  it('serves the version and Node support', async () => {
    const db = openDb(':memory:');
    const node = nodeSupport('v22.23.3', new Date('2026-09-28'));
    const app = buildServer(db, { version: '0.6.0', node });
    const body = (await app.inject('/api/config')).json();
    expect(body.version).toBe('0.6.0');
    expect(body.node).toEqual(node);
    await app.close();
    db.close();
  });
});
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run test/version.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `packages/api/src/version.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * End of security support per Node major (nodejs/Release schedule). Renovate
 * can't know these dates: add a line here when bumping to a new Node major.
 */
export const NODE_SUPPORT_ENDS: Record<number, string> = {
  22: '2027-04-30',
  24: '2028-04-30',
  26: '2029-04-30'
};

/** The release version stamped into version.json at the app root; 'dev' in a checkout. */
export function readVersion(appRoot: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(appRoot, 'version.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : 'dev';
  } catch {
    return 'dev';
  }
}

export interface NodeSupport {
  version: string;
  line: number;
  /** YYYY-MM-DD, or null for a line not in NODE_SUPPORT_ENDS. */
  supportEnds: string | null;
  ended: boolean;
}

export function nodeSupport(nodeVersion = process.version, today = new Date()): NodeSupport {
  const version = nodeVersion.replace(/^v/, '');
  const line = Number(version.split('.')[0]);
  const supportEnds = NODE_SUPPORT_ENDS[line] ?? null;
  // Support runs through the whole last day, in local time.
  const ended =
    supportEnds !== null &&
    today.getTime() >= new Date(`${supportEnds}T00:00:00`).getTime() + 86_400_000;
  return { version, line, supportEnds, ended };
}
```

In `packages/api/src/index.ts` add to `ServerOptions`:

```ts
  /** The release version (from version.json); 'dev' when unset. */
  version?: string;
  /** The running Node and its end of security support. */
  node?: NodeSupport;
```

and in the `/api/config` handler object add `version: options.version ?? 'dev', node: options.node ?? nodeSupport(),`.

In `packages/api/src/server.ts`:

```ts
// The app root is three levels above packages/api/dist/server.js.
const VERSION = readVersion(fileURLToPath(new URL('../../../', import.meta.url)));
const NODE = nodeSupport();
```

pass `version: VERSION, node: NODE` to `buildServer`, and in the `listen().then` change the log line's start to `` `[pipulse] ${VERSION} (Node ${NODE.version}) listening on http://${HOST}:${port}` `` and, right after it:

```ts
if (NODE.ended)
  console.warn(
    `[pipulse] Node ${NODE.line} no longer gets security fixes (since ${NODE.supportEnds})`
  );
```

- [ ] **Step 4: Run and commit** — `npx vitest run` in `packages/api` → pass.

```bash
git add packages/api
git commit -m "Report PiPulse's version and Node's end of support

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Host root and container awareness (server side)

**Files:**

- Modify: `packages/collector/src/index.ts` (`readDeviceInfo`), `packages/api/src/index.ts` (`PluginInfo`), `packages/api/src/server.ts`
- Create: `packages/api/src/container.ts`
- Test: `packages/collector/test/device-info.test.ts`, `packages/api/test/container.test.ts`

**Interfaces:**

- Produces:

```ts
// collector
export async function readDeviceInfo(options?: { hostRoot?: string }): Promise<DeviceInfo>;
export function hostOverrides(hostRoot: string): { os?: string; model?: string }; // exported for tests
// api
PluginInfo.unavailable?: string;
export const CONTAINER_UNAVAILABLE = 'Not available in Docker';
export const FIRMWARE_PLUGINS: ReadonlySet<string>; // {'cpu_voltage','throttled'}
export function splitForContainer<P extends { id: string }>(plugins: P[], inContainer: boolean): { run: P[]; unavailable: Set<string> };
```

- [ ] **Step 1: Failing tests**

`packages/collector/test/device-info.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostOverrides } from '../src/index.js';

describe('hostOverrides', () => {
  it("reads the host's OS name and Pi model under the host root", () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-host-'));
    mkdirSync(join(root, 'etc'));
    writeFileSync(
      join(root, 'etc/os-release'),
      'NAME="Debian GNU/Linux"\nPRETTY_NAME="Raspbian GNU/Linux 12 (bookworm)"\n'
    );
    // /proc/device-tree/model ends with a NUL byte.
    writeFileSync(join(root, 'model'), 'Raspberry Pi 5 Model B Rev 1.0\0');
    expect(hostOverrides(root)).toEqual({
      os: 'Raspbian GNU/Linux 12 (bookworm)',
      model: 'Raspberry Pi 5 Model B Rev 1.0'
    });
  });

  it('leaves out what is missing', () => {
    expect(hostOverrides(mkdtempSync(join(tmpdir(), 'pp-host-')))).toEqual({});
  });
});
```

`packages/api/test/container.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openDb } from '@pipulse/storage';
import { buildServer } from '../src/index.js';
import { CONTAINER_UNAVAILABLE, splitForContainer } from '../src/container.js';

const plugins = [{ id: 'cpu_load' }, { id: 'cpu_voltage' }, { id: 'throttled' }];

describe('splitForContainer', () => {
  it('runs everything natively', () => {
    expect(splitForContainer(plugins, false)).toEqual({ run: plugins, unavailable: new Set() });
  });

  it('holds back the firmware plugins in a container', () => {
    const { run, unavailable } = splitForContainer(plugins, true);
    expect(run.map((p) => p.id)).toEqual(['cpu_load']);
    expect([...unavailable]).toEqual(['cpu_voltage', 'throttled']);
  });
});

describe('/api/config plugins', () => {
  it('passes the unavailable reason through', async () => {
    const db = openDb(':memory:');
    const app = buildServer(db, {
      plugins: [
        { id: 'cpu_load', label: 'CPU', unit: '%', intervalMs: 5000 },
        {
          id: 'throttled',
          label: 'Throttling',
          unit: 'flags',
          intervalMs: 60000,
          unavailable: CONTAINER_UNAVAILABLE
        }
      ]
    });
    const { plugins: served } = (await app.inject('/api/config')).json();
    expect(served[1].unavailable).toBe('Not available in Docker');
    expect(served[0].unavailable).toBeUndefined();
    await app.close();
    db.close();
  });
});
```

- [ ] **Step 2: Run to see them fail** (`hostOverrides` not exported; `container.js` missing).

- [ ] **Step 3: Implement**

In `packages/collector/src/index.ts` (add `import { readFileSync } from 'node:fs'; import { join } from 'node:path';`):

```ts
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The host's OS name and Pi model, read under `hostRoot` (a container mounts
 * the host's /etc/os-release and /proc/device-tree/model there). Missing
 * files are left out, so the usual sources apply.
 */
export function hostOverrides(hostRoot: string): { os?: string; model?: string } {
  const result: { os?: string; model?: string } = {};
  const osRelease = readText(join(hostRoot, 'etc/os-release'));
  const pretty = osRelease?.match(/^PRETTY_NAME="?([^"\n]*)"?$/m)?.[1];
  if (pretty) result.os = pretty;
  const model = readText(join(hostRoot, 'model'))?.replace(/\0/g, '').trim();
  if (model) result.model = model;
  return result;
}
```

and change `readDeviceInfo` to take `options: { hostRoot?: string } = {}` and return `{ ...info, ...(options.hostRoot ? hostOverrides(options.hostRoot) : {}) }` where `info` is today's object.

`packages/api/src/container.ts`:

```ts
/** Shown on a tile whose reading a container can't make. */
export const CONTAINER_UNAVAILABLE = 'Not available in Docker';

/** Plugins that need the Pi firmware (vcgencmd, /dev/vchiq), absent from the image. */
export const FIRMWARE_PLUGINS: ReadonlySet<string> = new Set(['cpu_voltage', 'throttled']);

/** In a container, the firmware plugins aren't scheduled at all. */
export function splitForContainer<P extends { id: string }>(
  plugins: P[],
  inContainer: boolean
): { run: P[]; unavailable: Set<string> } {
  if (!inContainer) return { run: plugins, unavailable: new Set() };
  return {
    run: plugins.filter((p) => !FIRMWARE_PLUGINS.has(p.id)),
    unavailable: new Set(plugins.filter((p) => FIRMWARE_PLUGINS.has(p.id)).map((p) => p.id))
  };
}
```

`packages/api/src/index.ts` `PluginInfo` gains:

```ts
  /** Why this plugin isn't running here (e.g. 'Not available in Docker'); absent when it runs. */
  unavailable?: string;
```

`packages/api/src/server.ts`:

```ts
const IN_CONTAINER = process.env['PIPULSE_IN_CONTAINER'] === 'true';
const HOST_ROOT = process.env['PIPULSE_HOST_ROOT'];
const { run: RUN_PLUGINS, unavailable: UNAVAILABLE } = splitForContainer(
  builtinPlugins,
  IN_CONTAINER
);
```

use `readDeviceInfo(HOST_ROOT ? { hostRoot: HOST_ROOT } : {})`, `startScheduler(db, RUN_PLUGINS, …)`, and the `plugins` option:

```ts
  plugins: builtinPlugins.map(({ id, label, unit, intervalMs }) => ({
    id,
    label,
    unit,
    intervalMs,
    ...(UNAVAILABLE.has(id) ? { unavailable: CONTAINER_UNAVAILABLE } : {})
  })),
```

- [ ] **Step 4: Run and commit** — collector and api tests pass (`npm run build --workspace=packages/collector` first).

```bash
git add packages/collector packages/api
git commit -m "Read host facts under PIPULSE_HOST_ROOT and skip firmware plugins in containers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Dashboard — unavailable tiles and the About section

**Files:**

- Create: `packages/web/src/about.tsx`, `packages/web/test/about.test.tsx`
- Modify: `packages/web/src/types.ts`, `packages/web/src/tile.tsx:48-62`, `packages/web/src/history.ts` (`chartGroups`), `packages/web/src/settings-page.tsx`, `packages/web/test/tile.test.tsx`, `packages/web/test/history.test.ts`, `packages/web/test/settings-page.test.tsx`

**Interfaces:**

- Consumes: `/api/config` `version`, `node: {version, line, supportEnds, ended}`, `plugins[].unavailable` (Tasks 2–3).
- Produces: `PluginInfo.unavailable?: string`, `Config.version?: string`, `Config.node?: NodeSupport` in `types.ts`; `AboutSection()` (no props, fetches `/api/config` via `getJson`).

- [ ] **Step 1: Failing tests**

Add to `packages/web/test/tile.test.tsx` (follow the file's existing render helper; the assertion is what matters):

```tsx
it('says why a plugin is unavailable instead of waiting for readings', () => {
  renderTile({ plugin: { ...plugin, unavailable: 'Not available in Docker' }, latest: undefined });
  expect(root.textContent).toContain('Not available in Docker');
  expect(root.textContent).not.toContain('Waiting for the first reading');
});
```

Add to `packages/web/test/history.test.ts`:

```ts
it('leaves unavailable plugins off History', () => {
  const groups = chartGroups([
    { id: 'cpu_load', label: 'CPU', unit: '%', intervalMs: 5000 },
    {
      id: 'throttled',
      label: 'Throttling',
      unit: 'flags',
      intervalMs: 60000,
      unavailable: 'Not available in Docker'
    }
  ]);
  expect(JSON.stringify(groups)).not.toContain('throttled');
});
```

`packages/web/test/about.test.tsx` (same fetch-stub pattern as `notifications.test.tsx`):

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { AboutSection } from '../src/about.js';

let root: HTMLElement;
let config: object;
beforeEach(() => {
  config = {
    version: '0.6.0',
    node: { version: '22.23.3', line: 22, supportEnds: '2027-04-30', ended: false }
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/config' ? Response.json(config) : new Response('', { status: 404 })
    )
  );
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

async function show() {
  await act(async () => render(<AboutSection />, root));
  await vi.waitFor(() => expect(root.textContent).not.toContain('Loading'));
}

describe('AboutSection', () => {
  it('shows the versions and when Node support ends', async () => {
    await show();
    expect(root.querySelector('h2')?.textContent).toBe('About');
    expect(root.textContent).toContain('PiPulse 0.6.0');
    expect(root.textContent).toContain('Node 22.23.3');
    expect(root.textContent).toContain('security fixes until 30 Apr 2027');
    expect(root.querySelector('svg')).toBeNull();
  });

  it('warns in words once support has ended', async () => {
    config = {
      ...config,
      node: { version: '22.23.3', line: 22, supportEnds: '2027-04-30', ended: true }
    };
    await show();
    expect(root.textContent).toContain('Node 22 no longer gets security fixes (since 30 Apr 2027)');
    expect(root.querySelector('svg')).not.toBeNull();
  });

  it('says nothing about support for an unknown line or an older server', async () => {
    config = { version: 'dev' };
    await show();
    expect(root.textContent).toContain('PiPulse dev');
    expect(root.textContent).not.toContain('security fixes');
  });
});
```

In `packages/web/test/settings-page.test.tsx`: make the fetch stub answer `/api/config` with `{ version: 'dev' }`, and extend the headings assertion to `['Data retention', 'Storage', 'Notifications', 'About']`.

- [ ] **Step 2: Run to see them fail** — `cd packages/web && npx vitest run`.

- [ ] **Step 3: Implement**

`types.ts`: `PluginInfo` gains `unavailable?: string;`; add

```ts
export interface NodeSupport {
  version: string;
  line: number;
  supportEnds: string | null;
  ended: boolean;
}
```

and `Config` gains `version?: string; node?: NodeSupport;`.

`tile.tsx`, at the top of the component body before `if (!latest)`:

```tsx
if (plugin.unavailable) {
  return (
    <section class="tile" aria-labelledby={`tile-${plugin.id}`}>
      <div class="tile-head">
        <h2 id={`tile-${plugin.id}`}>{plugin.label}</h2>
      </div>
      <p class="waiting">{plugin.unavailable}</p>
    </section>
  );
}
```

`history.ts` `chartGroups`: filter `plugins.filter((p) => !p.unavailable)` before grouping.

`about.tsx`:

```tsx
import { useEffect, useState } from 'preact/hooks';
import { getJson } from './api.js';
import { StatusIcon } from './tile.js';
import type { Config } from './types.js';

/** "2027-04-30" → "30 Apr 2027", fixed (not locale-dependent) so it reads the same everywhere. */
function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ][m! - 1];
  return `${d} ${month} ${y}`;
}

/** Which PiPulse and Node this is, and whether that Node still gets security fixes. */
export function AboutSection() {
  const [config, setConfig] = useState<Config | 'loading' | 'error'>('loading');
  useEffect(() => {
    getJson<Config>('/api/config').then(setConfig, () => setConfig('error'));
  }, []);
  return (
    <section aria-labelledby="settings-about">
      <h2 id="settings-about">About</h2>
      {config === 'loading' && <p class="waiting">Loading</p>}
      {config === 'error' && (
        <p class="waiting">Couldn't load the version from the PiPulse server.</p>
      )}
      {typeof config === 'object' && (
        <>
          <p>PiPulse {config.version ?? 'dev'}</p>
          {config.node && (
            <p>
              Node {config.node.version}
              {config.node.supportEnds &&
                !config.node.ended &&
                `, security fixes until ${formatDay(config.node.supportEnds)}`}
            </p>
          )}
          {config.node?.ended && config.node.supportEnds && (
            <p class="alert-severity">
              <StatusIcon level="warning" />
              Node {config.node.line} no longer gets security fixes (since{' '}
              {formatDay(config.node.supportEnds)}).
            </p>
          )}
        </>
      )}
    </section>
  );
}
```

`settings-page.tsx`: render `<AboutSection />` after `<NotificationsSection />`.

- [ ] **Step 4: Run and commit** — web tests pass; `npx prettier --write` the changed files.

```bash
git add packages/web
git commit -m "Show unavailable plugins and an About section on the dashboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Prompt notification shutdown

**Files:**

- Modify: `packages/notify/src/sender.ts` (`SendOptions`, `sendNext`, `startNotifications().stop`)
- Test: `packages/notify/test/sender.test.ts`

**Interfaces:**

- Produces: `SendOptions.stopSignal?: AbortSignal`; `export const STOP_WAIT_MS = 5_000;`; `Notifications.stop()` resolves within `STOP_WAIT_MS` and never counts an interrupted delivery as an attempt.

- [ ] **Step 1: Failing test** (add to the `startNotifications` describe block)

```ts
it('stops within 5 s, leaving an interrupted delivery pending and uncounted', async () => {
  add('a');
  const hang = action('a', ['hang']);
  const n = startNotifications(db, {
    webhooks: [
      {
        id: 'a',
        url: 'http://x',
        method: 'POST',
        headers: {},
        events: ['raised', 'cleared'],
        minSeverity: 'warning',
        timeoutMs: 60_000
      }
    ],
    hostname: 'Io',
    metrics: [],
    now: () => now,
    intervalMs: 1e9,
    actions: [hang]
  });
  await new Promise((resolve) => setTimeout(resolve, 20)); // delivery in flight
  const started = performance.now();
  await n.stop();
  expect(performance.now() - started).toBeLessThan(STOP_WAIT_MS);
  expect(headOf(db, 'a')).toMatchObject({ attempts: 0, lastError: null });
});
```

(import `STOP_WAIT_MS` from `../src/sender.js`). The existing `action` helper's `'hang'` rejects on abort, so with the fix `stop()` returns at once.

- [ ] **Step 2: Run to see it fail** — it times out (stop waits for the 60 s timeout) or counts an attempt.

- [ ] **Step 3: Implement**

`SendOptions` gains `stopSignal?: AbortSignal;`. In `sendNext`:

```ts
  const signals = [AbortSignal.timeout(timeoutMs), ...(options.stopSignal ? [options.stopSignal] : [])];
  try {
    await action.deliver(row.payload, AbortSignal.any(signals));
    markSent(db, row.id, options.now());
    return true;
  } catch (error) {
    // Cut short by shutdown: not the receiver's fault, so not an attempt.
    if (options.stopSignal?.aborted) return false;
    …unchanged…
```

In `startNotifications`: `const stopping = new AbortController();`, add `stopSignal: stopping.signal` to `sendOptions`, export `STOP_WAIT_MS = 5_000`, and:

```ts
    async stop() {
      clearInterval(timer);
      stopped = true;
      stopping.abort();
      const lanesDone = Promise.all(lanes.map((lane) => lane.done()));
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        lanesDone,
        new Promise((resolve) => (timeout = setTimeout(resolve, STOP_WAIT_MS)))
      ]);
      clearTimeout(timeout);
    }
```

- [ ] **Step 4: Run and commit** — `npx vitest run` in `packages/notify` → pass.

```bash
git add packages/notify
git commit -m "Stop notifications within 5 s without counting interrupted deliveries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Verified Node download and the tarball

**Files:**

- Create: `packaging/node-versions.json`, `packaging/node-keys/pubring.kbx`, `packaging/node-keys/README.md`, `packaging/lib.sh`, `packaging/fetch-node.sh`, `packaging/build-tarball.sh`, `packaging/test/run.sh`, `packaging/test/fetch-node.test.sh`, `packaging/test/tarball.test.sh`
- Modify: `.prettierignore` (add `packaging/node-keys/`), `.gitignore` (add `/out/`)

**Interfaces:**

- Produces:
  - `lib.sh`: `log MSG`, `die MSG` (exit 1), `pipulse_arch` (prints `armhf|arm64|amd64`, honours `PIPULSE_ARCH`, dies on `armel`/`armv6`), `node_version ARCH` (reads `node-versions.json` next to the script), `node_dist ARCH` (`armv7l|arm64|x64`).
  - `fetch-node.sh ARCH DEST_DIR` → `DEST_DIR/node/` containing `bin/node`; env `PIPULSE_NODE_MIRROR` (default `https://nodejs.org/dist`) for tests.
  - `build-tarball.sh VERSION OUT_DIR` → `OUT_DIR/pipulse-VERSION.tar.gz` with top folder `pipulse-VERSION/` holding `package.json`, `package-lock.json`, `packages/*/{package.json,dist}`, production `node_modules`, `packaging/`, `install.sh` (copy of `packaging/install.sh`), `version.json`.
  - `packaging/test/run.sh [NAME…]` runs `packaging/test/*.test.sh` (all or named); each test prints `ok - …`/`not ok - …` and exits non-zero on failure.

- [ ] **Step 1: Fetch the keys and pin versions**

```bash
curl -fsSL -o packaging/node-keys/pubring.kbx https://github.com/nodejs/release-keys/raw/HEAD/gpg-only-active-keys/pubring.kbx
```

`packaging/node-keys/README.md`: one paragraph — the Node release team's active keys from `nodejs/release-keys` (`gpg-only-active-keys/pubring.kbx`); refresh with the command above when Node adds a releaser (a verification failure naming an unknown key is the sign).

`packaging/node-versions.json`:

```json
{
  "armhf": "22.23.3",
  "arm64": "24.21.0",
  "amd64": "24.21.0"
}
```

- [ ] **Step 2: Write the failing shell tests**

`packaging/test/fetch-node.test.sh` (runs in `debian:bookworm-slim` with `gpgv curl xz-utils ca-certificates`):

```sh
#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
. "$here/lib.sh"
fail=0
check() { if "$@"; then echo "ok - $name"; else echo "not ok - $name"; fail=1; fi; }

name='maps a 64-bit kernel with 32-bit userland to armhf'
mkdir -p /tmp/fakebin
printf '#!/bin/sh\necho armhf\n' > /tmp/fakebin/dpkg && chmod +x /tmp/fakebin/dpkg
check sh -c "PATH=/tmp/fakebin:\$PATH; . '$here/lib.sh'; [ \"\$(pipulse_arch)\" = armhf ]"

name='refuses armv6'
check sh -c "! PIPULSE_ARCH=armel sh -c '. \"$here/lib.sh\"; pipulse_arch' 2>/dev/null"

name='fetches and verifies the pinned Node'
dest=$(mktemp -d)
check sh -c "'$here/fetch-node.sh' amd64 '$dest' && '$dest/node/bin/node' --version | grep -q \"^v$(node_version amd64)\$\""

name='refuses a tampered SHASUMS256.txt'
mirror=$(mktemp -d); v=$(node_version amd64)
mkdir -p "$mirror/v$v"
curl -fsSL "https://nodejs.org/dist/v$v/SHASUMS256.txt" | sed '1s/^./0/' > "$mirror/v$v/SHASUMS256.txt"
curl -fsSL -o "$mirror/v$v/SHASUMS256.txt.sig" "https://nodejs.org/dist/v$v/SHASUMS256.txt.sig"
check sh -c "! PIPULSE_NODE_MIRROR='file://$mirror' '$here/fetch-node.sh' amd64 '$(mktemp -d)' 2>/dev/null"

name='refuses a list signed by an unknown key'
check sh -c "! PIPULSE_NODE_KEYRING=/dev/null '$here/fetch-node.sh' amd64 '$(mktemp -d)' 2>/dev/null"

exit $fail
```

`packaging/test/tarball.test.sh` (runs after `npm ci && npm run build` in the repo):

```sh
#!/bin/sh
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.0-test "$out"
tar -tzf "$out/pipulse-0.0.0-test.tar.gz" > "$out/list"
fail=0
for path in pipulse-0.0.0-test/version.json pipulse-0.0.0-test/install.sh \
  pipulse-0.0.0-test/packages/api/dist/server.js pipulse-0.0.0-test/packages/web/dist/index.html \
  pipulse-0.0.0-test/node_modules/fastify/package.json pipulse-0.0.0-test/packaging/setup.sh; do
  if grep -qx "$path" "$out/list"; then echo "ok - has $path"; else echo "not ok - missing $path"; fail=1; fi
done
if grep -q '/node_modules/vitest/' "$out/list"; then echo 'not ok - dev dependency included'; fail=1; else echo 'ok - no dev dependencies'; fi
if grep -q 'packages/[^/]*/src/' "$out/list"; then echo 'not ok - sources included'; fail=1; else echo 'ok - no sources'; fi
exit $fail
```

`packaging/test/run.sh`:

```sh
#!/bin/sh
# Runs packaging/test/*.test.sh (or the named ones); fails if any fails.
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
status=0
if [ "$#" -eq 0 ]; then set -- "$dir"/*.test.sh; else set -- $(for n in "$@"; do echo "$dir/$n.test.sh"; done); fi
for t in "$@"; do echo "# $(basename "$t")"; sh "$t" || status=1; done
exit $status
```

- [ ] **Step 3: Run to see them fail** (in Docker; ensure Docker is running):

```bash
docker run --rm -v "$PWD":/src -w /src debian:bookworm-slim sh -c \
  'apt-get -qq update && apt-get -qq install -y gpgv curl xz-utils ca-certificates >/dev/null && sh packaging/test/run.sh fetch-node'
```

Expected: `not ok` lines (`lib.sh` / `fetch-node.sh` missing).

- [ ] **Step 4: Implement `packaging/lib.sh`**

```sh
# Shared helpers for PiPulse's packaging scripts. POSIX sh; source it.
log() { printf '[pipulse] %s\n' "$*"; }
die() { printf '[pipulse] error: %s\n' "$*" >&2; exit 1; }

# The CPU as Debian names it: userland, not kernel (a Pi 4 on 32-bit Pi OS is armhf).
pipulse_arch() {
  arch=${PIPULSE_ARCH:-}
  if [ -z "$arch" ]; then
    if command -v dpkg >/dev/null 2>&1; then arch=$(dpkg --print-architecture)
    else case $(uname -m) in armv7l) arch=armhf ;; aarch64) arch=arm64 ;; x86_64) arch=amd64 ;; *) arch=$(uname -m) ;; esac
    fi
  fi
  case $arch in
    armhf | arm64 | amd64) printf '%s\n' "$arch" ;;
    armel | armv6l) die "this Pi (armv6) is not supported: Node 22 has no official build for it" ;;
    *) die "unsupported CPU: $arch" ;;
  esac
}

pipulse_packaging_dir() { cd "$(dirname "$0")" && pwd; }

# node_version ARCH — the pinned Node version for that CPU.
node_version() {
  sed -n "s/.*\"$1\": *\"\([0-9.]*\)\".*/\1/p" "${PIPULSE_NODE_VERSIONS:-$(dirname "$0")/node-versions.json}"
}

# node_dist ARCH — Node's name for that CPU in its download file names.
node_dist() { case $1 in armhf) echo armv7l ;; arm64) echo arm64 ;; amd64) echo x64 ;; esac; }
```

(`node_version` resolves `node-versions.json` next to the calling script; `fetch-node.sh` and `install.sh` live beside it. Tests set `PIPULSE_NODE_VERSIONS` when calling from elsewhere — adjust `fetch-node.test.sh` to export `PIPULSE_NODE_VERSIONS="$here/node-versions.json"` at the top.)

- [ ] **Step 5: Implement `packaging/fetch-node.sh`**

```sh
#!/bin/sh
# fetch-node.sh ARCH DEST — downloads the pinned Node for ARCH into DEST/node,
# verifying SHASUMS256.txt's signature with the Node release keys first.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
[ "$#" -eq 2 ] || die "usage: fetch-node.sh ARCH DEST"
arch=$1 dest=$2
version=$(PIPULSE_NODE_VERSIONS="$here/node-versions.json" node_version "$arch")
[ -n "$version" ] || die "no Node version pinned for $arch"
mirror=${PIPULSE_NODE_MIRROR:-https://nodejs.org/dist}
keyring=${PIPULSE_NODE_KEYRING:-$here/node-keys/pubring.kbx}
file="node-v$version-linux-$(node_dist "$arch").tar.xz"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/SHASUMS256.txt" "$mirror/v$version/SHASUMS256.txt"
curl -fsSL -o "$work/SHASUMS256.txt.sig" "$mirror/v$version/SHASUMS256.txt.sig"
gpgv --keyring "$keyring" "$work/SHASUMS256.txt.sig" "$work/SHASUMS256.txt" 2>/dev/null ||
  die "Node $version: SHASUMS256.txt is not signed by a Node release key"
curl -fsSL -o "$work/$file" "$mirror/v$version/$file"
(cd "$work" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) ||
  die "Node $version: $file does not match its signed checksum"
mkdir -p "$dest/node"
tar -xJf "$work/$file" -C "$dest/node" --strip-components=1
log "Node $version ($arch) verified"
```

- [ ] **Step 6: Implement `packaging/build-tarball.sh`**

```sh
#!/bin/sh
# build-tarball.sh VERSION OUT_DIR — packs the built app (run `npm run build` first).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
. "$here/lib.sh"
[ "$#" -eq 2 ] || die "usage: build-tarball.sh VERSION OUT_DIR"
version=$1 out=$2
name="pipulse-$version"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
root="$stage/$name"
mkdir -p "$root/packages" "$out"
cp "$repo/package.json" "$repo/package-lock.json" "$root/"
for pkg in "$repo"/packages/*/; do
  p=$(basename "$pkg")
  [ -d "$pkg/dist" ] || die "packages/$p has no dist/: run npm run build first"
  mkdir -p "$root/packages/$p"
  cp "$pkg/package.json" "$root/packages/$p/"
  cp -R "$pkg/dist" "$root/packages/$p/"
done
(cd "$root" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
cp -R "$here" "$root/packaging"
rm -rf "$root/packaging/test"
cp "$here/install.sh" "$root/install.sh"
printf '{"version":"%s"}\n' "$version" > "$root/version.json"
tar -czf "$out/$name.tar.gz" -C "$stage" "$name"
log "built $out/$name.tar.gz"
```

(`install.sh` is created in Task 8; until then create an empty executable placeholder `packaging/install.sh` containing `#!/bin/sh` so this task's test passes — Task 8 replaces it.)

- [ ] **Step 7: Run the tests** — Docker command from Step 3 for `fetch-node`; for `tarball`, in a `node:22-bookworm-slim` container: `npm ci && npm run build && sh packaging/test/run.sh tarball`. Expected: all `ok`. Also run `shellcheck packaging/*.sh packaging/test/*.sh` (in `koalaman/shellcheck-alpine` or installed) → clean.

- [ ] **Step 8: Commit**

```bash
git add packaging .prettierignore .gitignore
git commit -m "Add verified Node downloads and the release tarball

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `setup.sh`, the service, the env template and the `pipulse` command

**Files:**

- Create: `packaging/setup.sh`, `packaging/pipulse.service`, `packaging/pipulse.env`, `packaging/pipulse`, `packaging/test/setup.test.sh`

**Interfaces:**

- Consumes: `lib.sh` (Task 6).
- Produces:
  - `setup.sh [--no-start] [--unit-dir DIR]`: steps 1–5 of the spec, idempotent. `--unit-dir` defaults to `/etc/systemd/system` (tarball); the `.deb` passes `none` (its unit is packaged). Warnings on stderr start with `[pipulse] warning:`.
  - `/usr/bin/pipulse {version|notify-test [id]|hash-password}`.

- [ ] **Step 1: Failing test** `packaging/test/setup.test.sh` (runs as root in `debian:bookworm-slim` with `adduser` and `iproute2`; no systemd):

```sh
#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
groupadd -f video
sh "$here/setup.sh" --no-start > /tmp/setup.log 2>&1 || { cat /tmp/setup.log; bad 'setup ran'; }
id pipulse >/dev/null 2>&1 && ok 'user exists' || bad 'user exists'
[ "$(getent passwd pipulse | cut -d: -f7)" = /usr/sbin/nologin ] && ok 'no login shell' || bad 'no login shell'
id -nG pipulse | grep -qw video && ok 'in video group' || bad 'in video group'
[ "$(stat -c '%U:%G %a' /etc/pipulse)" = 'root:pipulse 750' ] && ok '/etc/pipulse mode' || bad '/etc/pipulse mode'
[ "$(stat -c '%U:%G %a' /etc/pipulse/pipulse.env)" = 'root:pipulse 640' ] && ok 'env mode' || bad 'env mode'
[ "$(stat -c '%U %a' /var/lib/pipulse)" = 'pipulse 700' ] && ok '/var/lib/pipulse mode' || bad '/var/lib/pipulse mode'
grep -q 'no systemd' /tmp/setup.log && ok 'says it skipped the service' || bad 'says it skipped the service'
echo 'PIPULSE_PORT=8889' >> /etc/pipulse/pipulse.env
sh "$here/setup.sh" --no-start >/dev/null 2>&1
grep -q '^PIPULSE_PORT=8889$' /etc/pipulse/pipulse.env && ok 'keeps an existing env' || bad 'keeps an existing env'
# A process on the configured port produces a warning naming it.
python3 -m http.server 8889 >/dev/null 2>&1 & srv=$!
sleep 1
sh "$here/setup.sh" --no-start 2>&1 | grep -q 'warning: port 8889 is already in use' && ok 'warns about a taken port' || bad 'warns about a taken port'
kill $srv
exit $fail
```

(Container needs `python3` for the listener; install `adduser iproute2 python3`.)

- [ ] **Step 2: Run to see it fail** (`setup.sh` missing).

- [ ] **Step 3: Implement**

`packaging/pipulse.service`: exactly the unit in the spec's `pipulse.service` section.

`packaging/pipulse.env`:

```sh
# PiPulse settings — read by systemd (EnvironmentFile) and Docker (env_file).
# Uncomment and change what you need, then: sudo systemctl restart pipulse
# Files mentioned here belong in /etc/pipulse/ (root:pipulse, mode 640).

# Network
#PIPULSE_HOST=0.0.0.0
#PIPULSE_PORT=8888
#PIPULSE_ALLOWED_ORIGINS=

# History kept per resolution (s, min, h, d, w, y or forever)
#PIPULSE_RETENTION_RAW=2d
#PIPULSE_RETENTION_1M=14d
#PIPULSE_RETENTION_1H=1y
#PIPULSE_RETENTION_1D=forever

# Sign-in: make a hash with `pipulse hash-password > /etc/pipulse/admin.hash`
#PIPULSE_ADMIN_PASSWORD_HASH_FILE=/etc/pipulse/admin.hash
#PIPULSE_PROTECT_READS=false

# Alert rules and notifications
#PIPULSE_ALERTS_FILE=/etc/pipulse/rules.json
#PIPULSE_NOTIFY_FILE=/etc/pipulse/notify.json

# A private certificate authority for HTTPS webhook receivers (e.g. a homelab CA)
#NODE_EXTRA_CA_CERTS=/etc/pipulse/homelab-ca.pem
```

`packaging/pipulse`:

```sh
#!/bin/sh
# pipulse — PiPulse's command-line helper (installed as /usr/bin/pipulse).
set -eu
node=/opt/pipulse/node/bin/node
app=/opt/pipulse/app
env=/etc/pipulse/pipulse.env
run() {
  # Load the service's settings (and NODE_EXTRA_CA_CERTS) the way systemd does.
  if [ -r "$env" ]; then set -a; . "$env"; set +a; fi
  exec "$node" --disable-warning=ExperimentalWarning "$@"
}
case ${1:-} in
  version)
    ver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$app/version.json" 2>/dev/null || true)
    echo "PiPulse ${ver:-dev}, Node $("$node" --version)" ;;
  notify-test)
    shift
    if [ "$(id -u)" -eq 0 ]; then exec setpriv --reuid=pipulse --regid=pipulse --init-groups "$0" notify-test "$@"; fi
    run "$app/packages/api/dist/notify-test.js" "$@" ;;
  hash-password)
    run "$app/packages/api/dist/hash-password.js" ;;
  *)
    echo 'usage: pipulse version | notify-test [webhook-id] | hash-password' >&2; exit 2 ;;
esac
```

`packaging/setup.sh`:

```sh
#!/bin/sh
# setup.sh [--no-start] [--unit-dir DIR|none] — the one setup both install
# paths run: user, folders, settings file, service, and warnings. Idempotent.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
start=yes unit_dir=/etc/systemd/system
while [ "$#" -gt 0 ]; do
  case $1 in
    --no-start) start=no ;;
    --unit-dir) unit_dir=$2; shift ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done
[ "$(id -u)" -eq 0 ] || die 'run as root'

# 1. User
if ! getent passwd pipulse >/dev/null; then
  adduser --system --group --home /var/lib/pipulse --no-create-home --shell /usr/sbin/nologin pipulse >/dev/null
fi
if getent group video >/dev/null; then adduser pipulse video >/dev/null; fi

# 2. Folders
install -d -o root -g pipulse -m 750 /etc/pipulse
install -d -o pipulse -g pipulse -m 700 /var/lib/pipulse

# 3. Settings, only if missing
if [ ! -e /etc/pipulse/pipulse.env ]; then
  install -o root -g pipulse -m 640 "$here/pipulse.env" /etc/pipulse/pipulse.env
fi
# The .deb ships pipulse.env as a conffile owned by root: give the service read access.
chown root:pipulse /etc/pipulse/pipulse.env
chmod 640 /etc/pipulse/pipulse.env

# 4. Service
if [ "$start" = yes ] && [ -d /run/systemd/system ]; then
  if [ "$unit_dir" != none ]; then install -m 644 "$here/pipulse.service" "$unit_dir/pipulse.service"; fi
  systemctl daemon-reload
  systemctl enable pipulse >/dev/null 2>&1
  systemctl restart pipulse
  log 'service enabled and started'
else
  log 'no systemd running (or --no-start): service not started'
fi

# 5. Warnings (never change anything)
port=$(sed -n 's/^PIPULSE_PORT=\([0-9]*\).*/\1/p' /etc/pipulse/pipulse.env | tail -n 1)
port=${port:-8888}
if command -v ss >/dev/null 2>&1; then
  holder=$(ss -Hltnp "sport = :$port" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n 1)
  if [ -n "$holder" ] && [ "$holder" != node ]; then
    printf '[pipulse] warning: port %s is already in use by %s; set PIPULSE_PORT in /etc/pipulse/pipulse.env\n' "$port" "$holder" >&2
  elif [ -z "$holder" ] && ss -Hltn "sport = :$port" | grep -q .; then
    printf '[pipulse] warning: port %s is already in use; set PIPULSE_PORT in /etc/pipulse/pipulse.env\n' "$port" >&2
  fi
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  if ! ufw status | grep -qE "^$port(/tcp)?[[:space:]]"; then
    printf '[pipulse] warning: ufw is active and has no rule for port %s; to allow your LAN:\n  sudo ufw allow from 192.168.1.0/24 to any port %s proto tcp\n' "$port" "$port" >&2
  fi
fi
```

- [ ] **Step 4: Run the test** (`debian:bookworm-slim`, as in Task 6, installing `adduser iproute2 python3`) → all `ok`; `shellcheck packaging/setup.sh packaging/pipulse` clean.

- [ ] **Step 5: Commit**

```bash
git add packaging
git commit -m "Add the shared setup script, service unit, settings template and pipulse command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `install.sh` — apt one-liner, tarball, rollback, uninstall

**Files:**

- Modify: `packaging/install.sh` (replace the placeholder)
- Create: `packaging/test/install.test.sh`, `packaging/test/rollback.test.sh`

**Interfaces:**

- Consumes: `lib.sh`, `fetch-node.sh`, `setup.sh`, `build-tarball.sh`.
- Produces: `install.sh [--tarball] [--version X.Y.Z] [--from FILE] [--no-start] [--uninstall] [--purge]`; constants `REPO=seviyon/PiPulse`, `APT_URL=https://seviyon.github.io/PiPulse/apt`. Env for tests: `PIPULSE_HEALTH_URL` (default `http://127.0.0.1:$PORT/api/health`), `PIPULSE_HEALTH_WAIT` (default `30`), `PIPULSE_RESTART_CMD` (default `systemctl restart pipulse`).

- [ ] **Step 1: Failing tests**

`packaging/test/install.test.sh` (root, `node:22-bookworm-slim` + `gpgv curl xz-utils adduser iproute2`, after `npm ci && npm run build`):

```sh
#!/bin/sh
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.0-test "$out" >/dev/null
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.0-test.tar.gz" --no-start || bad 'install ran'
[ -x /opt/pipulse/node/bin/node ] && ok 'private node' || bad 'private node'
[ -f /opt/pipulse/app/version.json ] && ok 'app installed' || bad 'app installed'
[ -x /usr/bin/pipulse ] && ok 'pipulse command' || bad 'pipulse command'
pipulse version | grep -q '^PiPulse 0.0.0-test, Node v' && ok 'pipulse version' || bad 'pipulse version'
# Start it the way the unit would and check it answers.
su -s /bin/sh pipulse -c 'cd /var/lib/pipulse && PIPULSE_DB_PATH=/var/lib/pipulse/pipulse.sqlite PIPULSE_PORT=18888 PIPULSE_WEB_DIR=/opt/pipulse/app/packages/web/dist /opt/pipulse/node/bin/node --disable-warning=ExperimentalWarning /opt/pipulse/app/packages/api/dist/server.js' & pid=$!
for _ in $(seq 1 30); do curl -fs http://127.0.0.1:18888/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fs http://127.0.0.1:18888/api/config | grep -q '"version":"0.0.0-test"' && ok 'serves the stamped version' || bad 'serves the stamped version'
kill $pid; wait $pid 2>/dev/null || true
sh "$repo/packaging/install.sh" --uninstall
[ ! -e /opt/pipulse ] && [ -d /var/lib/pipulse ] && [ -f /etc/pipulse/pipulse.env ] && ok 'uninstall keeps data and settings' || bad 'uninstall keeps data and settings'
sh "$repo/packaging/install.sh" --purge
! getent passwd pipulse >/dev/null && [ ! -e /var/lib/pipulse ] && [ ! -e /etc/pipulse ] && ok 'purge removes everything' || bad 'purge removes everything'
exit $fail
```

`packaging/test/rollback.test.sh`: builds two tarballs — a good one (`0.0.1`) and a broken one (`0.0.2`) whose `packages/api/dist/server.js` is replaced by a script serving `/api/health` with `503` — installs the good one with a fake restart command, then the broken one, and asserts the good version is back:

```sh
#!/bin/sh
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.1 "$out" >/dev/null
"$repo/packaging/build-tarball.sh" 0.0.2 "$out" >/dev/null
# Break 0.0.2: it starts, but /api/health answers 503.
work=$(mktemp -d); tar -xzf "$out/pipulse-0.0.2.tar.gz" -C "$work"
cat > "$work/pipulse-0.0.2/packages/api/dist/server.js" <<'JS'
import { createServer } from 'node:http';
createServer((q, s) => { s.statusCode = 503; s.end('{"status":"unhealthy"}'); }).listen(Number(process.env.PIPULSE_PORT));
JS
tar -czf "$out/pipulse-0.0.2.tar.gz" -C "$work" pipulse-0.0.2
# A stand-in for systemd: (re)start whatever is installed, on port 18889.
cat > /usr/local/bin/fake-restart <<'SH'
#!/bin/sh
pkill -f /opt/pipulse/app/packages/api/dist/server.js || true
sleep 1
PIPULSE_PORT=18889 PIPULSE_DB_PATH=/tmp/rb.sqlite PIPULSE_WEB_DIR=/opt/pipulse/app/packages/web/dist \
  nohup /opt/pipulse/node/bin/node --disable-warning=ExperimentalWarning /opt/pipulse/app/packages/api/dist/server.js >/tmp/rb.log 2>&1 &
SH
chmod +x /usr/local/bin/fake-restart
export PIPULSE_RESTART_CMD=fake-restart PIPULSE_HEALTH_URL=http://127.0.0.1:18889/api/health PIPULSE_HEALTH_WAIT=20 PIPULSE_FORCE_RESTART=1
fail=0
sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.1.tar.gz" && echo 'ok - good version installs' || { echo 'not ok - good version installs'; fail=1; }
if sh "$repo/packaging/install.sh" --from "$out/pipulse-0.0.2.tar.gz"; then echo 'not ok - broken version reported success'; fail=1; else echo 'ok - broken version refused'; fi
grep -q '"0.0.1"' /opt/pipulse/app/version.json && echo 'ok - rolled back to 0.0.1' || { echo 'not ok - rolled back to 0.0.1'; fail=1; }
up=no; for _ in $(seq 1 20); do curl -fs http://127.0.0.1:18889/api/health >/dev/null 2>&1 && { up=yes; break; }; sleep 1; done
[ "$up" = yes ] && echo 'ok - 0.0.1 running again' || { echo 'not ok - 0.0.1 running again'; fail=1; }
exit $fail
```

(`PIPULSE_FORCE_RESTART=1` makes `install.sh` restart and health-check even without systemd, using `PIPULSE_RESTART_CMD`; only tests set it. Install `procps` for `pkill`.)

- [ ] **Step 2: Run to see them fail** (placeholder `install.sh` does nothing).

- [ ] **Step 3: Implement `packaging/install.sh`**

```sh
#!/bin/sh
# PiPulse installer.
#   curl -fsSL https://github.com/seviyon/PiPulse/releases/latest/download/install.sh | sudo sh
# Default: add PiPulse's signed apt repository and `apt-get install pipulse`.
# --tarball [--version X.Y.Z] | --from FILE   install from a release tarball instead
# --no-start                                  install without starting the service
# --uninstall | --purge                       remove a tarball install (purge: data too)
# Everything is inside main(), called on the last line, so a truncated download runs nothing.
set -eu
REPO=seviyon/PiPulse
APT_URL=https://seviyon.github.io/PiPulse/apt

log() { printf '[pipulse] %s\n' "$*"; }
die() { printf '[pipulse] error: %s\n' "$*" >&2; exit 1; }

install_apt() {
  command -v apt-get >/dev/null 2>&1 || die 'no apt here: use --tarball'
  log 'adding the PiPulse apt repository'
  curl -fsSL "$APT_URL/pipulse.gpg" -o /usr/share/keyrings/pipulse.gpg
  echo "deb [signed-by=/usr/share/keyrings/pipulse.gpg] $APT_URL stable main" > /etc/apt/sources.list.d/pipulse.list
  apt-get update -qq
  apt-get install -y pipulse
  log 'installed; upgrades now come with `sudo apt upgrade`'
}

fetch_release() { # fetch_release VERSION DIR → DIR/pipulse-VERSION.tar.gz, checked
  base="https://github.com/$REPO/releases/download/v$1"
  curl -fsSL -o "$2/pipulse-$1.tar.gz" "$base/pipulse-$1.tar.gz"
  curl -fsSL -o "$2/SHA256SUMS" "$base/SHA256SUMS"
  (cd "$2" && grep " pipulse-$1.tar.gz\$" SHA256SUMS | sha256sum -c --quiet -) || die "pipulse-$1.tar.gz does not match SHA256SUMS"
}

latest_version() {
  curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" | sed 's|.*/v||'
}

health_ok() {
  url=${PIPULSE_HEALTH_URL:-}
  if [ -z "$url" ]; then
    port=$(sed -n 's/^PIPULSE_PORT=\([0-9]*\).*/\1/p' /etc/pipulse/pipulse.env 2>/dev/null | tail -n 1)
    host=$(sed -n 's/^PIPULSE_HOST=\(.*\)/\1/p' /etc/pipulse/pipulse.env 2>/dev/null | tail -n 1)
    case ${host:-0.0.0.0} in 0.0.0.0 | '::' | '[::]') host=127.0.0.1 ;; esac
    url="http://$host:${port:-8888}/api/health"
  fi
  i=0
  while [ "$i" -lt "${PIPULSE_HEALTH_WAIT:-30}" ]; do
    curl -fs "$url" >/dev/null 2>&1 && return 0
    i=$((i + 1)); sleep 1
  done
  return 1
}

restart() { sh -c "${PIPULSE_RESTART_CMD:-systemctl restart pipulse}"; }

install_tarball() { # install_tarball FILE NO_START
  tarball=$1 no_start=$2
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  tar -xzf "$tarball" -C "$work"
  src=$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'pipulse-*' | head -n 1)
  [ -n "$src" ] || die "$tarball is not a PiPulse release tarball"
  arch=$(PIPULSE_NODE_VERSIONS="$src/packaging/node-versions.json" sh -c ". '$src/packaging/lib.sh'; pipulse_arch")
  sh "$src/packaging/fetch-node.sh" "$arch" "$work/staged"
  mkdir -p /opt/pipulse
  rm -rf /opt/pipulse/app.new /opt/pipulse/node.new /opt/pipulse/app.previous /opt/pipulse/node.previous
  mv "$src" /opt/pipulse/app.new
  mv "$work/staged/node" /opt/pipulse/node.new
  had_previous=no
  if [ -d /opt/pipulse/app ]; then
    mv /opt/pipulse/app /opt/pipulse/app.previous
    mv /opt/pipulse/node /opt/pipulse/node.previous
    had_previous=yes
  fi
  mv /opt/pipulse/app.new /opt/pipulse/app
  mv /opt/pipulse/node.new /opt/pipulse/node
  chown -R root:root /opt/pipulse
  install -m 755 /opt/pipulse/app/packaging/pipulse /usr/bin/pipulse
  if [ "$no_start" = yes ]; then
    sh /opt/pipulse/app/packaging/setup.sh --no-start
  elif [ -n "${PIPULSE_FORCE_RESTART:-}" ]; then
    sh /opt/pipulse/app/packaging/setup.sh --no-start
    restart
  else
    [ -d /run/systemd/system ] || die 'systemd is not running: use --no-start'
    sh /opt/pipulse/app/packaging/setup.sh
  fi
  if [ "$no_start" = yes ]; then
    rm -rf /opt/pipulse/app.previous /opt/pipulse/node.previous
    log "installed $(cat /opt/pipulse/app/version.json) (not started)"
    return 0
  fi
  if health_ok; then
    rm -rf /opt/pipulse/app.previous /opt/pipulse/node.previous
    log "running $(cat /opt/pipulse/app/version.json)"
    return 0
  fi
  if [ "$had_previous" = yes ]; then
    log 'the new version did not become healthy: rolling back'
    rm -rf /opt/pipulse/app /opt/pipulse/node
    mv /opt/pipulse/app.previous /opt/pipulse/app
    mv /opt/pipulse/node.previous /opt/pipulse/node
    install -m 755 /opt/pipulse/app/packaging/pipulse /usr/bin/pipulse
    restart
    die "rolled back; still running $(cat /opt/pipulse/app/version.json)"
  fi
  die 'PiPulse did not become healthy; see: journalctl -u pipulse'
}

uninstall() { # uninstall PURGE
  if [ -d /run/systemd/system ]; then
    systemctl disable --now pipulse >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/pipulse.service
    systemctl daemon-reload
  fi
  rm -rf /opt/pipulse /usr/bin/pipulse
  if [ "$1" = yes ]; then
    rm -rf /etc/pipulse /var/lib/pipulse
    if getent passwd pipulse >/dev/null; then deluser --system pipulse >/dev/null 2>&1 || userdel pipulse; fi
    getent group pipulse >/dev/null && { delgroup --system pipulse >/dev/null 2>&1 || groupdel pipulse; } || true
    log 'removed PiPulse, its settings and its data'
  else
    log 'removed PiPulse; kept /etc/pipulse and /var/lib/pipulse (use --purge to remove them)'
  fi
}

main() {
  mode=apt version= from= no_start=no
  while [ "$#" -gt 0 ]; do
    case $1 in
      --tarball) mode=tarball ;;
      --version) version=$2; mode=tarball; shift ;;
      --from) from=$2; mode=tarball; shift ;;
      --no-start) no_start=yes ;;
      --uninstall) mode=uninstall ;;
      --purge) mode=purge ;;
      -h | --help) sed -n '2,9p' "$0"; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done
  [ "$(id -u)" -eq 0 ] || die 'run as root (sudo)'
  case $mode in
    apt) install_apt ;;
    uninstall) uninstall no ;;
    purge) uninstall yes ;;
    tarball)
      if [ -z "$from" ]; then
        dl=$(mktemp -d)
        version=${version:-$(latest_version)}
        fetch_release "$version" "$dl"
        from="$dl/pipulse-$version.tar.gz"
      fi
      install_tarball "$from" "$no_start" ;;
  esac
}

main "$@"
```

(The installer is self-contained on purpose: when piped from `curl`, `lib.sh` isn't on disk yet. After unpacking it uses the tarball's own `packaging/` scripts.)

- [ ] **Step 4: Run** `install` and `rollback` tests in the container → all `ok`; `shellcheck packaging/install.sh` clean.

- [ ] **Step 5: Commit**

```bash
git add packaging
git commit -m "Add install.sh: apt one-liner, tarball install with rollback, uninstall

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The `.deb`

**Files:**

- Create: `packaging/deb/control.in`, `packaging/deb/postinst`, `packaging/deb/prerm`, `packaging/deb/postrm`, `packaging/deb/conffiles`, `packaging/deb/copyright`, `packaging/build-deb.sh`, `packaging/test/deb.test.sh`, `packaging/lintian-overrides`

**Interfaces:**

- Consumes: tarball (Task 6), `fetch-node.sh`, `setup.sh --unit-dir none`.
- Produces: `build-deb.sh VERSION ARCH TARBALL OUT_DIR` → `OUT_DIR/pipulse_VERSION_ARCH.deb`.

- [ ] **Step 1: Failing test** `packaging/test/deb.test.sh` (root, `node:22-bookworm-slim` + `gpgv curl xz-utils adduser iproute2 lintian`):

```sh
#!/bin/sh
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=$(mktemp -d)
"$repo/packaging/build-tarball.sh" 0.0.1 "$out" >/dev/null
"$repo/packaging/build-tarball.sh" 0.0.2 "$out" >/dev/null
"$repo/packaging/build-deb.sh" 0.0.1 amd64 "$out/pipulse-0.0.1.tar.gz" "$out" >/dev/null
"$repo/packaging/build-deb.sh" 0.0.2 amd64 "$out/pipulse-0.0.2.tar.gz" "$out" >/dev/null
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
lintian --fail-on error "$out/pipulse_0.0.1_amd64.deb" && ok 'lintian clean' || bad 'lintian clean'
apt-get install -y "$out/pipulse_0.0.1_amd64.deb" >/dev/null && ok 'installs' || bad 'installs'
[ -x /opt/pipulse/node/bin/node ] && id pipulse >/dev/null && ok 'node and user' || bad 'node and user'
echo 'PIPULSE_PORT=8889' >> /etc/pipulse/pipulse.env
DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::=--force-confold "$out/pipulse_0.0.2_amd64.deb" >/dev/null && ok 'upgrades' || bad 'upgrades'
grep -q '"0.0.2"' /opt/pipulse/app/version.json && ok 'new version in place' || bad 'new version in place'
grep -q '^PIPULSE_PORT=8889$' /etc/pipulse/pipulse.env && ok 'edited env kept' || bad 'edited env kept'
apt-get remove -y pipulse >/dev/null
[ ! -e /opt/pipulse ] && [ -f /etc/pipulse/pipulse.env ] && [ -d /var/lib/pipulse ] && ok 'remove keeps data and settings' || bad 'remove keeps data and settings'
apt-get purge -y pipulse >/dev/null
[ ! -e /etc/pipulse ] && [ ! -e /var/lib/pipulse ] && ! getent passwd pipulse >/dev/null && ok 'purge removes everything' || bad 'purge removes everything'
exit $fail
```

- [ ] **Step 2: Run to see it fail.**

- [ ] **Step 3: Implement**

`packaging/deb/control.in`:

```
Package: pipulse
Version: @VERSION@
Architecture: @ARCH@
Maintainer: Andres <seviyon@users.noreply.github.com>
Depends: adduser
Section: admin
Priority: optional
Homepage: https://github.com/seviyon/PiPulse
Description: Raspberry Pi system monitor with a live web dashboard
 PiPulse collects CPU, temperature, memory, disk and network readings into
 SQLite, checks them against alert rules, sends webhook notifications and
 serves a live dashboard and history charts. Includes its own Node.js.
```

`packaging/deb/conffiles`: `/etc/pipulse/pipulse.env`

`packaging/deb/postinst`:

```sh
#!/bin/sh
set -e
if [ "$1" = configure ]; then
  sh /opt/pipulse/app/packaging/setup.sh --unit-dir none
fi
```

(With the unit packaged in `/lib/systemd/system/`, `setup.sh --unit-dir none` still runs `daemon-reload`, `enable`, `restart` when systemd runs; in a container it skips. `setup.sh` never overwrites the conffile — it installs `pipulse.env` only when missing — and it sets the conffile's owner and mode to `root:pipulse 640`.)

`packaging/deb/prerm`:

```sh
#!/bin/sh
set -e
if [ -d /run/systemd/system ] && [ "$1" = remove ]; then
  systemctl disable --now pipulse >/dev/null 2>&1 || true
fi
```

`packaging/deb/postrm`:

```sh
#!/bin/sh
set -e
if [ "$1" = purge ]; then
  rm -rf /etc/pipulse /var/lib/pipulse
  if getent passwd pipulse >/dev/null; then deluser --system pipulse >/dev/null 2>&1 || true; fi
  if getent group pipulse >/dev/null; then delgroup --system pipulse >/dev/null 2>&1 || true; fi
fi
if [ -d /run/systemd/system ]; then systemctl daemon-reload >/dev/null 2>&1 || true; fi
```

`packaging/build-deb.sh`:

```sh
#!/bin/sh
# build-deb.sh VERSION ARCH TARBALL OUT_DIR — the .deb for one CPU (with its Node).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
[ "$#" -eq 4 ] || die "usage: build-deb.sh VERSION ARCH TARBALL OUT_DIR"
version=$1 arch=$2 tarball=$3 out=$4
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/DEBIAN" "$root/opt/pipulse" "$root/usr/bin" "$root/lib/systemd/system" "$root/etc/pipulse" "$root/usr/share/doc/pipulse"
tar -xzf "$tarball" -C "$root/opt/pipulse"
mv "$root/opt/pipulse/pipulse-$version" "$root/opt/pipulse/app"
sh "$here/fetch-node.sh" "$arch" "$root/opt/pipulse"
install -m 755 "$here/pipulse" "$root/usr/bin/pipulse"
install -m 644 "$here/pipulse.service" "$root/lib/systemd/system/pipulse.service"
install -m 640 "$here/pipulse.env" "$root/etc/pipulse/pipulse.env"
install -m 644 "$here/deb/copyright" "$root/usr/share/doc/pipulse/copyright"
sed -e "s/@VERSION@/$version/" -e "s/@ARCH@/$arch/" "$here/deb/control.in" > "$root/DEBIAN/control"
echo "Installed-Size: $(du -sk "$root" | cut -f1)" >> "$root/DEBIAN/control"
install -m 644 "$here/deb/conffiles" "$root/DEBIAN/conffiles"
for s in postinst prerm postrm; do install -m 755 "$here/deb/$s" "$root/DEBIAN/$s"; done
mkdir -p "$out"
dpkg-deb --root-owner-group --build "$root" "$out/pipulse_${version}_${arch}.deb" >/dev/null
log "built $out/pipulse_${version}_${arch}.deb"
```

`packaging/deb/copyright`: machine-readable DEP-5 header naming the repository's `LICENSE` (copy its text). `packaging/lintian-overrides`: only for findings that are inherent to bundling Node (e.g. `embedded-library`, `binary-without-manpage`, `dir-or-file-in-opt`); install it to `usr/share/lintian/overrides/pipulse` in `build-deb.sh`. Add each override only after lintian reports it, with a comment explaining why.

- [ ] **Step 4: Run** the test → all `ok`; `shellcheck` clean.

- [ ] **Step 5: Commit**

```bash
git add packaging
git commit -m "Build a .deb per CPU with its own Node

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docker image and compose file

**Files:**

- Create: `Dockerfile`, `.dockerignore`, `compose.yaml`, `packaging/healthcheck.mjs`, `packaging/test/docker.sh` (host-side smoke script, not a `*.test.sh`)

**Interfaces:**

- Consumes: `/api/health` (Task 1), `PIPULSE_IN_CONTAINER`/`PIPULSE_HOST_ROOT` (Task 3).
- Produces: image with `ARG VERSION`; `packaging/test/docker.sh IMAGE` exits 0 when the container becomes `healthy`, `/api/config` answers and `cpu_voltage` is `unavailable`.

- [ ] **Step 1: Failing smoke script** `packaging/test/docker.sh`:

```sh
#!/bin/sh
# docker.sh IMAGE — start IMAGE and require health, config and the unavailable firmware plugins.
set -eu
image=$1
cid=$(docker run -d -e PIPULSE_PORT=18890 -p 18890:18890 "$image")
trap 'docker rm -f "$cid" >/dev/null' EXIT
for _ in $(seq 1 90); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid")" = healthy ] && break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$cid")" = healthy ] || { docker logs "$cid"; echo 'not ok - healthy'; exit 1; }
echo 'ok - healthy'
curl -fs http://127.0.0.1:18890/api/config | grep -q '"id":"cpu_voltage"[^}]*"unavailable":"Not available in Docker"' && echo 'ok - firmware plugins unavailable' || { echo 'not ok - firmware plugins unavailable'; exit 1; }
```

Run `sh packaging/test/docker.sh pipulse:test` before the Dockerfile exists → fails (no image).

- [ ] **Step 2: Implement**

`packaging/healthcheck.mjs`:

```js
// Docker HEALTHCHECK: exit 0 when /api/health answers 200 (the slim image has no curl).
const port = process.env.PIPULSE_PORT ?? '8888';
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(4000)
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
```

`Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# Build once on the build machine's CPU: the output is plain JavaScript.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:<digest> AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts && npm run build
ARG VERSION=dev
RUN mkdir /app && cp package.json package-lock.json /app/ \
 && for p in packages/*/; do mkdir -p /app/$p && cp $p/package.json /app/$p && cp -R $p/dist /app/$p; done \
 && cd /app && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && printf '{"version":"%s"}\n' "$VERSION" > /app/version.json

FROM node:24-bookworm-slim@sha256:<digest>
RUN groupadd --system pipulse && useradd --system --gid pipulse --home /data --shell /usr/sbin/nologin pipulse \
 && mkdir /data && chown pipulse:pipulse /data
COPY --from=build /app /opt/pipulse/app
COPY packaging/healthcheck.mjs /opt/pipulse/healthcheck.mjs
ENV PIPULSE_DB_PATH=/data/pipulse.sqlite \
    PIPULSE_WEB_DIR=/opt/pipulse/app/packages/web/dist \
    PIPULSE_HOST_ROOT=/host \
    PIPULSE_IN_CONTAINER=true \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
USER pipulse
VOLUME /data
EXPOSE 8888
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
  CMD ["node", "/opt/pipulse/healthcheck.mjs"]
CMD ["node", "/opt/pipulse/app/packages/api/dist/server.js"]
```

Replace `<digest>` with the current digest: `docker buildx imagetools inspect node:24-bookworm-slim --format '{{json .Manifest.Digest}}'` (Renovate keeps it current).

`.dockerignore`: `node_modules`, `**/node_modules`, `**/dist`, `.git`, `.superpowers`, `.playwright-mcp`, `out`, `docs`.

`compose.yaml`: exactly the spec's compose file.

- [ ] **Step 3: Run** `docker build -t pipulse:test --build-arg VERSION=0.0.0-test . && sh packaging/test/docker.sh pipulse:test` → both `ok`. (`compose.yaml` is validated in CI with `docker compose -f compose.yaml config -q`.)

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore compose.yaml packaging
git commit -m "Add the 64-bit Docker image with a health check, and compose.yaml

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: CI packaging jobs

**Files:**

- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: every `packaging/test/*.test.sh`, `packaging/test/docker.sh`.

- [ ] **Step 1: Add jobs** after `build-and-test`:

```yaml
shellcheck:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: shellcheck packaging/*.sh packaging/pipulse packaging/deb/postinst packaging/deb/prerm packaging/deb/postrm packaging/test/*.sh

packaging:
  runs-on: ubuntu-latest
  container: node:22-bookworm-slim
  steps:
    - uses: actions/checkout@v4
    - run: apt-get update -qq && apt-get install -y -qq gpgv curl xz-utils ca-certificates adduser iproute2 procps python3 lintian gnupg apt-utils >/dev/null
    - run: npm ci && npm run build
    - run: sh packaging/test/run.sh

docker:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: docker/setup-buildx-action@v3
    - uses: docker/build-push-action@v6
      with:
        context: .
        load: true
        tags: pipulse:test
        build-args: VERSION=0.0.0-ci
    - run: docker compose -f compose.yaml config -q
    - run: sh packaging/test/docker.sh pipulse:test
```

(`setup.test.sh` groups users and must run on a clean container; `run.sh` runs `setup`, `install`, `deb`, `rollback` in sequence in one container — make `run.sh`'s default order `fetch-node tarball setup install rollback deb` and have `install.test.sh`/`rollback.test.sh`/`deb.test.sh` start with `sh "$repo/packaging/install.sh" --purge >/dev/null 2>&1 || true` so each starts clean.)

- [ ] **Step 2: Push the branch and confirm the three jobs pass** (`gh pr checks` or the Actions tab). Fix what fails in its own task's files.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml packaging/test
git commit -m "Run the packaging tests, shellcheck and the Docker smoke test in CI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Release workflow and the apt repository

**Files:**

- Create: `.github/workflows/release.yml`, `packaging/apt-publish.sh`, `packaging/next-version.sh`, `packaging/test/next-version.test.sh`, `packaging/test/apt.test.sh`

**Interfaces:**

- Produces:
  - `next-version.sh LATEST_TAG BUMP` → prints the next version (`''` + any bump → `0.6.0`; `v0.6.0 patch` → `0.6.1`; `v0.6.1 minor` → `0.7.0`; `v0.7.0 major` → `1.0.0`).
  - `apt-publish.sh REPO_DIR KEEP DEB…` → adds the `.deb`s to `REPO_DIR/pool/main/`, keeps the newest `KEEP` per architecture, regenerates `dists/stable/main/binary-{armhf,arm64,amd64}/Packages(.gz)` and `dists/stable/Release`, signs `InRelease` and `Release.gpg` with the default GPG key (`gpg --batch --pinentry-mode loopback --passphrase-fd 0`), and exports the public key to `REPO_DIR/pipulse.gpg` (binary).

- [ ] **Step 1: Failing tests**

`packaging/test/next-version.test.sh`:

```sh
#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
fail=0
t() { got=$(sh "$here/next-version.sh" "$1" "$2"); [ "$got" = "$3" ] && echo "ok - '$1' $2 → $3" || { echo "not ok - '$1' $2 → $got, want $3"; fail=1; }; }
t '' patch 0.6.0
t '' minor 0.6.0
t v0.6.0 patch 0.6.1
t v0.6.1 minor 0.7.0
t v0.7.3 major 1.0.0
exit $fail
```

`packaging/test/apt.test.sh` (needs `gnupg apt-utils`): generate a throwaway key (`gpg --batch --quick-gen-key 'PiPulse test <t@example.invalid>' default default never` with `%no-protection`), build two amd64 `.deb`s (0.0.1, 0.0.2) via the Task 9 scripts, `apt-publish.sh "$repo_dir" 1 …`, then:

```sh
cp "$repo_dir/pipulse.gpg" /usr/share/keyrings/pipulse.gpg
echo "deb [signed-by=/usr/share/keyrings/pipulse.gpg] file://$repo_dir stable main" > /etc/apt/sources.list.d/pipulse.list
apt-get update -qq && echo 'ok - signed index accepted' || { echo 'not ok - signed index accepted'; exit 1; }
[ "$(apt-cache policy pipulse | sed -n 's/ *Candidate: //p')" = 0.0.2 ] && echo 'ok - newest candidate' || { echo 'not ok - newest candidate'; exit 1; }
[ "$(ls "$repo_dir/pool/main" | wc -l)" -eq 1 ] && echo 'ok - kept only the newest' || { echo 'not ok - kept only the newest'; exit 1; }
```

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement**

`packaging/next-version.sh`:

```sh
#!/bin/sh
# next-version.sh LATEST_TAG BUMP — the next release version (first release: 0.6.0).
set -eu
latest=${1#v} bump=$2
if [ -z "$latest" ]; then echo 0.6.0; exit 0; fi
IFS=. read -r major minor patch <<EOF
$latest
EOF
case $bump in
  patch) echo "$major.$minor.$((patch + 1))" ;;
  minor) echo "$major.$((minor + 1)).0" ;;
  major) echo "$((major + 1)).0.0" ;;
  *) echo "unknown bump: $bump" >&2; exit 1 ;;
esac
```

`packaging/apt-publish.sh`:

```sh
#!/bin/sh
# apt-publish.sh REPO_DIR KEEP DEB... — add DEBs to the apt repo, keep the newest
# KEEP per architecture, regenerate and sign the indexes (key: GPG default key;
# passphrase on stdin when APT_SIGNING_PASSPHRASE is set).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
repo=$1 keep=$2
shift 2
mkdir -p "$repo/pool/main"
cp "$@" "$repo/pool/main/"
for arch in armhf arm64 amd64; do
  # shellcheck disable=SC2012
  ls "$repo/pool/main"/pipulse_*_"$arch".deb 2>/dev/null | sort -V | head -n "-$keep" | xargs -r rm -f
done
cd "$repo"
for arch in armhf arm64 amd64; do
  d="dists/stable/main/binary-$arch"
  mkdir -p "$d"
  apt-ftparchive --arch "$arch" packages pool/main > "$d/Packages"
  gzip -9fk "$d/Packages"
done
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=PiPulse -o APT::FTPArchive::Release::Label=PiPulse \
  -o APT::FTPArchive::Release::Suite=stable -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures='armhf arm64 amd64' -o APT::FTPArchive::Release::Components=main \
  release dists/stable > dists/stable/Release
sign() { if [ -n "${APT_SIGNING_PASSPHRASE:-}" ]; then printf '%s' "$APT_SIGNING_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 "$@"; else gpg --batch --yes "$@"; fi; }
sign --clearsign -o dists/stable/InRelease dists/stable/Release
sign -abs -o dists/stable/Release.gpg dists/stable/Release
gpg --export > pipulse.gpg
log "apt repository updated in $repo"
```

`.github/workflows/release.yml`:

```yaml
name: Release

on:
  pull_request:
    types: [closed]
    branches: [main]
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to release (e.g. 0.6.1)'
        required: true

permissions:
  contents: write
  packages: write

concurrency: release

jobs:
  release:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.pull_request.merged &&
       (contains(github.event.pull_request.labels.*.name, 'release:patch') ||
        contains(github.event.pull_request.labels.*.name, 'release:minor') ||
        contains(github.event.pull_request.labels.*.name, 'release:major')))
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # The merge commit itself, even if main moved on since.
          ref: ${{ github.event.pull_request.merge_commit_sha || github.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22.x
          cache: npm
      - name: Version
        id: version
        env:
          LABELS: ${{ join(github.event.pull_request.labels.*.name, ' ') }}
          INPUT: ${{ inputs.version }}
        run: |
          if [ -n "$INPUT" ]; then v=$INPUT; else
            bump=$(printf '%s' "$LABELS" | tr ' ' '\n' | sed -n 's/^release://p' | sort | tail -n 1)
            v=$(sh packaging/next-version.sh "$(git tag -l 'v*' --sort=-v:refname | head -n 1)" "$bump")
          fi
          git rev-parse -q --verify "refs/tags/v$v" >/dev/null && { echo "v$v already exists"; exit 1; }
          echo "version=$v" >> "$GITHUB_OUTPUT"
      - run: sudo apt-get update -qq && sudo apt-get install -y -qq gpgv lintian apt-utils >/dev/null
      - run: npm ci && npm test
      - name: Tarball and .debs
        env:
          V: ${{ steps.version.outputs.version }}
        run: |
          sh packaging/build-tarball.sh "$V" out
          for arch in armhf arm64 amd64; do sh packaging/build-deb.sh "$V" "$arch" "out/pipulse-$V.tar.gz" out; lintian --fail-on error "out/pipulse_${V}_${arch}.deb"; done
          cp packaging/install.sh compose.yaml out/
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/arm64,linux/amd64
          push: true
          build-args: VERSION=${{ steps.version.outputs.version }}
          tags: |
            ghcr.io/seviyon/pipulse:${{ steps.version.outputs.version }}
            ghcr.io/seviyon/pipulse:latest
      - name: Import the signing key
        env:
          APT_SIGNING_KEY: ${{ secrets.APT_SIGNING_KEY }}
        run: printf '%s' "$APT_SIGNING_KEY" | gpg --batch --import
      - name: Apt repository
        env:
          V: ${{ steps.version.outputs.version }}
          APT_SIGNING_PASSPHRASE: ${{ secrets.APT_SIGNING_PASSPHRASE }}
        run: |
          git fetch origin gh-pages:gh-pages 2>/dev/null || true
          git worktree add pages gh-pages 2>/dev/null || { git worktree add --orphan -b gh-pages pages; }
          sh packaging/apt-publish.sh pages/apt 3 out/pipulse_"$V"_*.deb
          cd pages && git add -A && git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit -qm "apt: pipulse $V" && git push origin gh-pages
      - name: Checksums
        env:
          APT_SIGNING_PASSPHRASE: ${{ secrets.APT_SIGNING_PASSPHRASE }}
        run: |
          cd out && sha256sum pipulse-*.tar.gz pipulse_*.deb install.sh compose.yaml > SHA256SUMS
          printf '%s' "$APT_SIGNING_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 -abs -o SHA256SUMS.asc SHA256SUMS
      - name: Tag and publish
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          V: ${{ steps.version.outputs.version }}
        run: |
          gh release create "v$V" --target "$(git rev-parse HEAD)" --title "PiPulse $V" --generate-notes \
            out/pipulse-"$V".tar.gz out/pipulse_"$V"_*.deb out/install.sh out/compose.yaml out/SHA256SUMS out/SHA256SUMS.asc
      - name: Check what users get
        env:
          V: ${{ steps.version.outputs.version }}
        run: |
          sleep 60 # GitHub Pages publishes asynchronously
          docker run --rm debian:bookworm-slim sh -c "
            apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null &&
            curl -fsSL https://seviyon.github.io/PiPulse/apt/pipulse.gpg -o /usr/share/keyrings/pipulse.gpg &&
            echo 'deb [signed-by=/usr/share/keyrings/pipulse.gpg] https://seviyon.github.io/PiPulse/apt stable main' > /etc/apt/sources.list.d/pipulse.list &&
            apt-get update -qq && apt-get install -y -qq pipulse >/dev/null &&
            grep -q '\"$V\"' /opt/pipulse/app/version.json"
```

Add a **dry-run** job to `ci.yml`, run when `packaging/**`, `Dockerfile`, `compose.yaml` or `.github/workflows/**` change (`dorny/paths-filter` or `on.pull_request.paths` in a separate `release-dry-run.yml`): the same steps up to and including the `.deb` builds and a `docker buildx build --platform linux/arm64,linux/amd64` without push; no signing, no publishing.

- [ ] **Step 4: Run** `next-version` and `apt` tests (add `gnupg apt-utils` to the CI container install line) → all `ok`; `actionlint .github/workflows/*.yml` (via `rhysd/actionlint` container) clean.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows packaging
git commit -m "Release from labelled merges: tarball, .debs, image and a signed apt repository

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Renovate

**Files:**

- Create: `renovate.json`

- [ ] **Step 1: Write `renovate.json`**

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended", "helpers:pinGitHubActionDigests", "docker:pinDigests"],
  "labels": ["release:patch"],
  "vulnerabilityAlerts": { "labels": ["release:patch", "security"] },
  "packageRules": [
    {
      "matchUpdateTypes": ["patch", "minor", "digest", "pin", "pinDigest"],
      "automerge": true,
      "platformAutomerge": true
    },
    { "matchUpdateTypes": ["major"], "automerge": false },
    {
      "matchFileNames": ["packaging/node-versions.json"],
      "matchDepNames": ["node-armhf"],
      "allowedVersions": "<23"
    },
    {
      "matchFileNames": ["packaging/node-versions.json"],
      "matchDepNames": ["node-arm64", "node-amd64"],
      "allowedVersions": "/^(24|26|28)\\./",
      "groupName": "bundled Node (64-bit)"
    }
  ],
  "customManagers": [
    {
      "customType": "regex",
      "fileMatch": ["^packaging/node-versions\\.json$"],
      "matchStrings": ["\"(?<arch>armhf|arm64|amd64)\": \"(?<currentValue>[0-9.]+)\""],
      "depNameTemplate": "node-{{arch}}",
      "packageNameTemplate": "node",
      "datasourceTemplate": "node-version"
    }
  ]
}
```

- [ ] **Step 2: Validate** — `npx --yes --package renovate -- renovate-config-validator renovate.json` → `Config validated successfully`.

- [ ] **Step 3: Commit**

```bash
git add renovate.json
git commit -m "Keep every dependency, action, base image and bundled Node current with Renovate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Docs

**Files:**

- Create: `docs/RELEASING.md`
- Modify: `README.md`, `docs/PLAN.md`, `CLAUDE.md`

- [ ] **Step 1: `docs/RELEASING.md`** — sections, in the repo's tone:
  1. **How releases happen** — labels, versions from `v0.6.0`, what `release.yml` publishes, the manual "Run workflow" with a version.
  2. **One-time setup** — exact steps: install the Renovate GitHub App (github.com/apps/renovate → Only select repositories → `PiPulse`); Settings → Branches → protect `main` (require a PR, require the `build-and-test`, `shellcheck`, `packaging`, `docker` checks) and Settings → General → allow auto-merge; create the three labels (`gh label create release:patch --color 0e8a16` etc.); generate the apt key:

```bash
gpg --quick-gen-key 'PiPulse apt repository <seviyon@users.noreply.github.com>' rsa4096 sign 3y
gpg --armor --export-secret-keys 'PiPulse apt repository' | gh secret set APT_SIGNING_KEY
gh secret set APT_SIGNING_PASSPHRASE   # paste the passphrase
gpg --armor --export-secret-keys 'PiPulse apt repository' > ~/pipulse-apt-key.asc  # keep offline, then delete locally
```

     then Settings → Pages → Deploy from branch `gh-pages` / root (after the first release creates it).

3. **Rotating the apt key** — new key, update both secrets, release; users re-run the `curl …/pipulse.gpg` line. 4. **New Node major** — add the line's end date to `NODE_SUPPORT_ENDS` in `packages/api/src/version.ts` and to Renovate's `allowedVersions`.

- [ ] **Step 2: `README.md`** — status line (Phase 6 packaging in progress, until the exit criterion); replace "Getting started" with **Install** (the one-liner; the two-step form; the manual apt lines; tarball `--tarball`/`--version`/`--from`; Docker on 64-bit with `compose.yaml`; configuration in `/etc/pipulse/pipulse.env` and `sudo systemctl restart pipulse`; `pipulse` command; upgrade/uninstall/purge; Node support table and the 32-bit end date) and **Develop** (today's npm commands and the env var table); roadmap row 6 `🚧 In progress`.

- [ ] **Step 3: `docs/PLAN.md`** — Phase 6 row `🚧 In progress` with what is built; the Docker section corrected (64-bit only, no `pid: host`, `vcgencmd` unavailable, real-host check open for the Pi 5); a "Node support" paragraph (22 on 32-bit until 2027-04-30; `armv6` unsupported).

- [ ] **Step 4: `CLAUDE.md`** — "Next up" says Phase 6 is implemented on `phase-6-packaging`, awaiting its exit criterion; conventions: packaging scripts are POSIX sh tested by `packaging/test/*.test.sh` in Debian containers (Docker must be running locally); never edit `package.json` versions (the release stamps `version.json`); a new Node major needs `NODE_SUPPORT_ENDS`.

- [ ] **Step 5:** `npm run lint`, `git ls-files | xargs npx prettier --check --ignore-unknown`, `npm test` → green. Commit:

```bash
git add README.md CLAUDE.md docs
git commit -m "Document installing, releasing and Phase 6

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the tasks

1. Open the PR (label `release:minor`, so merging it releases `v0.6.0`), CI green including the release dry-run.
2. The operator does the one-time GitHub setup (`docs/RELEASING.md`).
3. Exit criterion part 1 on `Io` with a tarball built from the branch (spec checks 1–6). Capture `/api/config`, `/api/health`, `systemctl status pipulse` and `systemd-analyze security pipulse` before purging.
4. Merge → `v0.6.0` → exit criterion part 2 (spec checks 7–9), including `apt upgrade` to the next release.
5. Record results in `CLAUDE.md`, `README.md`, `docs/PLAN.md`; mark Phase 6 done in a follow-up PR (label none, or `release:patch` if code changed).
