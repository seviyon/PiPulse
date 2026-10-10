import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import {
  ALERTS_MARKER,
  DEFAULT_READINGS,
  FAKE_INTERVAL_MS,
  READINGS_ENV,
  readReadings,
  writeReadings,
  type Readings
} from './readings.js';
import { E2E_ROOT, REPO_ROOT, SERVER_JS, TLS_FIXTURES, WEB_DIST } from './paths.js';

export const E2E_PASSWORD = 'e2e-password';

export interface ServerOptions {
  password?: boolean; // writes admin.hash, sets PIPULSE_ADMIN_PASSWORD_HASH_FILE
  protectReads?: boolean; // PIPULSE_PROTECT_READS=true (needs password)
  alertsFile?: object; // written to <dir>/alerts.json → PIPULSE_ALERTS_FILE
  env?: Record<string, string>; // extra PIPULSE_* only (e.g. PIPULSE_RETENTION_RAW); others refused
  readings?: Readings; // merged over DEFAULT_READINGS
  seed?: (db: PiPulseDb, now: number) => void; // runs before the server starts
  tls?: boolean; // HTTPS with the committed test certificate
  tlsLeafOnly?: boolean; // internal: serve the leaf without its intermediate (the negative test)
  hook?: boolean; // default true; false only for the drift test
  webDist?: string; // internal: the dashboard folder (to test the missing-build error)
}

export interface RunningServer {
  baseUrl: string;
  port: number;
  dir: string;
  pid: number;
  setReadings(values: Readings): void; // merged over current
  stop(): Promise<void>; // SIGTERM, wait, SIGKILL after 5 s; then removes the folder
  halt(): Promise<void>; // SIGTERM and wait, but keep the folder, so restart() can bring it back
  restart(): Promise<void>; // same folder, same port
  logs(): string; // stdout + stderr so far
}

const REGISTER = join(E2E_ROOT, 'dist', 'harness', 'register.js');
const START_TIMEOUT_MS = 20_000;
const KILL_AFTER_MS = 5_000;

/** What the harness sets itself: a test may add PIPULSE_* settings, never repoint these. */
const MANAGED_ENV = new Set([
  'PIPULSE_DB_PATH',
  'PIPULSE_HOST',
  'PIPULSE_PORT',
  'PIPULSE_WEB_DIR',
  'PIPULSE_RUNTIME_DIR',
  'PIPULSE_TLS',
  'PIPULSE_TLS_CERT',
  'PIPULSE_TLS_KEY',
  'PIPULSE_TLS_TIMESYNC_DIR',
  'PIPULSE_ADMIN_PASSWORD_HASH_FILE',
  'PIPULSE_PROTECT_READS',
  'PIPULSE_ALERTS_FILE',
  READINGS_ENV
]);

// Every server this process started and has not seen exit; killed if the process itself exits.
const live = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of live) child.kill('SIGKILL');
});

/** How many servers started by this process are still running (for tests of the cleanup). */
export function liveServerCount(): number {
  return live.size;
}

function checkOptions(options: ServerOptions, webDist: string): void {
  if (!existsSync(join(webDist, 'index.html'))) {
    throw new Error(`${join(webDist, 'index.html')} is missing: run npm run build first`);
  }
  if (!existsSync(SERVER_JS)) throw new Error(`${SERVER_JS} is missing: run npm run build first`);
  for (const key of Object.keys(options.env ?? {})) {
    if (!key.startsWith('PIPULSE_')) {
      throw new Error(`env ${key}: only PIPULSE_* variables may be passed to the server`);
    }
    if (MANAGED_ENV.has(key)) {
      throw new Error(`env ${key}: managed by the harness (use the matching option)`);
    }
  }
  if (options.protectReads && !options.password) {
    throw new Error('protectReads needs password: nobody could sign in');
  }
}

/** The environment is built from scratch: nothing of the developer's own PIPULSE_* leaks in. */
function buildEnv(dir: string, port: number, options: ServerOptions, webDist: string) {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: dir,
    TZ: 'UTC',
    LANG: 'C.UTF-8',
    PIPULSE_DB_PATH: join(dir, 'pipulse.sqlite'),
    PIPULSE_HOST: '127.0.0.1',
    PIPULSE_PORT: String(port),
    PIPULSE_WEB_DIR: webDist,
    PIPULSE_RUNTIME_DIR: join(dir, 'run'), // absent: nothing is written to a real /run/pipulse
    PIPULSE_TLS: options.tls ? 'on' : 'off',
    [READINGS_ENV]: join(dir, 'readings.json')
  };
  if (options.password) {
    env['PIPULSE_ADMIN_PASSWORD_HASH_FILE'] = join(dir, 'admin.hash');
    if (options.protectReads) env['PIPULSE_PROTECT_READS'] = 'true';
  }
  if (options.alertsFile) env['PIPULSE_ALERTS_FILE'] = join(dir, 'alerts.json');
  if (options.tls) {
    env['PIPULSE_TLS_CERT'] = join(dir, 'cert.pem');
    env['PIPULSE_TLS_KEY'] = join(dir, 'key.pem');
    env['PIPULSE_TLS_TIMESYNC_DIR'] = join(dir, 'timesync');
  }
  return { ...env, ...options.env };
}

async function writeFiles(dir: string, options: ServerOptions): Promise<void> {
  writeReadings(join(dir, 'readings.json'), { ...DEFAULT_READINGS, ...options.readings });
  if (options.password) {
    // The cost the API's own tests use; the default would make every start slow.
    const auth = (await import(
      pathToFileURL(join(REPO_ROOT, 'packages', 'api', 'dist', 'auth.js')).href
    )) as {
      hashPassword(password: string, cost: { N: number; r: number; p: number }): Promise<string>;
    };
    writeFileSync(
      join(dir, 'admin.hash'),
      await auth.hashPassword(E2E_PASSWORD, { N: 1024, r: 8, p: 1 }),
      {
        mode: 0o600
      }
    );
  }
  if (options.alertsFile) {
    writeFileSync(join(dir, 'alerts.json'), JSON.stringify(options.alertsFile));
  }
  if (options.tls) {
    const read = (name: string) => readFileSync(join(TLS_FIXTURES, name), 'utf8');
    const chain = options.tlsLeafOnly
      ? read('leaf.crt')
      : read('leaf.crt') + read('intermediate.crt');
    writeFileSync(join(dir, 'cert.pem'), chain);
    writeFileSync(join(dir, 'key.pem'), read('leaf.key'), { mode: 0o600 });
    mkdirSync(join(dir, 'timesync'));
    writeFileSync(join(dir, 'timesync', 'synchronized'), '');
  }
  if (options.seed) {
    const db = openDb(join(dir, 'pipulse.sqlite'));
    try {
      options.seed(db, Date.now());
    } finally {
      db.close();
    }
  }
}

interface Reply {
  status: number;
  setCookie: string | undefined;
  body: string;
}

/** One request; for HTTPS the chain is checked against the test root (verification is never skipped). */
function call(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Reply> {
  const secure = url.startsWith('https:');
  const send = secure ? httpsRequest : httpRequest;
  const tlsOptions = secure
    ? { ca: readFileSync(join(TLS_FIXTURES, 'root-ca.crt')), servername: 'localhost' }
    : {};
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      { method: init.method ?? 'GET', headers: init.headers, ...tlsOptions },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, setCookie: res.headers['set-cookie']?.[0], body })
        );
      }
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** /api/config as the drift guard sees it: signed in first when reads are protected. */
async function readConfig(
  baseUrl: string,
  options: ServerOptions
): Promise<{ plugins?: { intervalMs: number }[] }> {
  const headers: Record<string, string> = {};
  if (options.protectReads) {
    const login = await call(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ password: E2E_PASSWORD })
    });
    if (login.status !== 200 || !login.setCookie) {
      throw new Error(`the harness could not sign in (HTTP ${login.status}): ${login.body}`);
    }
    headers['cookie'] = login.setCookie.split(';')[0]!;
  }
  return JSON.parse((await call(`${baseUrl}/api/config`, { headers })).body) as {
    plugins?: { intervalMs: number }[];
  };
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
  try {
    await once(child, 'exit');
  } finally {
    clearTimeout(timer);
  }
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const webDist = options.webDist ?? WEB_DIST;
  checkOptions(options, webDist);
  const dir = mkdtempSync(join(tmpdir(), 'pipulse-e2e-'));
  let log = '';
  let child: ChildProcess | undefined;
  let port = 0;
  let baseUrl = '';

  const launch = async (): Promise<void> => {
    const args = ['--disable-warning=ExperimentalWarning'];
    if (options.hook !== false) args.push('--import', pathToFileURL(REGISTER).href);
    args.push(SERVER_JS);
    const spawned = spawn(process.execPath, args, {
      env: buildEnv(dir, port, options, webDist),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child = spawned;
    live.add(spawned);
    spawned.once('exit', () => live.delete(spawned));
    let out = '';
    spawned.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the server did not start in ${START_TIMEOUT_MS} ms:\n${log}`)),
        START_TIMEOUT_MS
      );
      spawned.stdout.on('data', (chunk: Buffer) => {
        log += chunk.toString();
        out += chunk.toString();
        const match = /listening on (https?:\/\/\S+)/.exec(out);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      spawned.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      spawned.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the server exited early with code ${String(code)}:\n${log}`));
      });
    });
    port = Number(new URL(url).port);
    baseUrl = `${new URL(url).protocol}//127.0.0.1:${port}`;
    // Drift guard: if the hook no longer applies, the tests would run on real readings.
    const config = await readConfig(baseUrl, options);
    const plugins = config.plugins ?? [];
    if (plugins.length === 0 || plugins.some((plugin) => plugin.intervalMs !== FAKE_INTERVAL_MS)) {
      throw new Error(
        `fake collector not loaded: /api/config reports real plugin intervals\n${log}`
      );
    }
    if (!log.includes(ALERTS_MARKER)) {
      throw new Error(
        `fake alerts not loaded: the server never started the fake alert engine\n${log}`
      );
    }
  };

  try {
    await writeFiles(dir, options);
    await launch();
  } catch (error) {
    if (child) await terminate(child);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  const readingsPath = join(dir, 'readings.json');
  const server: RunningServer = {
    get baseUrl() {
      return baseUrl;
    },
    get port() {
      return port;
    },
    get pid() {
      return child!.pid!;
    },
    dir,
    setReadings(values) {
      writeReadings(readingsPath, { ...readReadings(readingsPath), ...values });
    },
    async stop() {
      if (child) await terminate(child);
      rmSync(dir, { recursive: true, force: true });
    },
    async halt() {
      if (child) await terminate(child);
    },
    async restart() {
      if (child) await terminate(child);
      try {
        await launch();
      } catch (error) {
        if (child) await terminate(child); // a failed restart leaves no process behind
        throw error;
      }
    },
    logs() {
      return log;
    }
  };
  return server;
}
