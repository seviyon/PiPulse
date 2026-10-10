import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { install } from '../src/harness/hook.js';
import {
  DEFAULT_READINGS,
  FAKE_INTERVAL_MS,
  READINGS_ENV,
  writeReadings
} from '../src/harness/readings.js';
import { E2E_ROOT, SERVER_JS, WEB_DIST } from '../src/harness/paths.js';

// The compiled hook, as the server loads it (`npm run build` first).
const REGISTER = join(E2E_ROOT, 'dist', 'harness', 'register.js');
const NODE = ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(REGISTER).href];

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
const scratch = (inRepo: boolean): string => {
  // A probe must sit inside the repository so bare '@pipulse/*' specifiers resolve.
  const base = inRepo ? join(E2E_ROOT, 'test-results') : tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'register-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe('install', () => {
  it('says what is missing when module.registerHooks is not there', () => {
    expect(() => install({})).toThrow('e2e harness needs Node >= 22.15 (module.registerHooks)');
  });
});

describe('the hook in a child process', () => {
  it('does not redirect an importer other than the server', async () => {
    const dir = scratch(true);
    const probe = join(dir, 'probe.mjs');
    writeFileSync(
      probe,
      "import { builtinPlugins } from '@pipulse/collector';\nconsole.log(JSON.stringify(builtinPlugins.map((p) => p.intervalMs)));\n"
    );
    const child = spawn(process.execPath, [...NODE, probe], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    await once(child, 'exit');
    const intervals = JSON.parse(out) as number[];
    expect(intervals.length).toBeGreaterThan(0);
    expect(intervals).not.toContain(FAKE_INTERVAL_MS); // the real plugins, not the fakes
  });

  it('gives the real server fake plugins, with readings from the control file', async () => {
    const dir = scratch(false);
    const readings = join(dir, 'readings.json');
    writeReadings(readings, { ...DEFAULT_READINGS, cpu_load: 55.5 });
    const child = spawn(process.execPath, [...NODE, SERVER_JS], {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: dir,
        TZ: 'UTC',
        PIPULSE_DB_PATH: join(dir, 'pipulse.sqlite'),
        PIPULSE_HOST: '127.0.0.1',
        PIPULSE_PORT: '0',
        PIPULSE_TLS: 'off',
        PIPULSE_WEB_DIR: WEB_DIST,
        PIPULSE_RUNTIME_DIR: join(dir, 'run'),
        [READINGS_ENV]: readings
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    cleanup.push(() => child.kill('SIGKILL'));
    let out = '';
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const baseUrl = await Promise.race([
      new Promise<string>((resolve) => {
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          const match = /listening on (http:\/\/\S+)/.exec(out);
          if (match?.[1]) resolve(match[1]);
        });
      }),
      once(child, 'exit').then(([code]) => {
        throw new Error(`server exited early with code ${String(code)}: ${err}`);
      })
    ]);

    const config = (await (await fetch(`${baseUrl}/api/config`)).json()) as {
      plugins: { id: string; intervalMs: number }[];
    };
    expect(config.plugins.length).toBe(Object.keys(DEFAULT_READINGS).length);
    for (const plugin of config.plugins)
      expect(plugin.intervalMs, plugin.id).toBe(FAKE_INTERVAL_MS);

    const deadline = Date.now() + 10_000;
    let value: number | undefined;
    while (Date.now() < deadline && value === undefined) {
      const latest = (await (await fetch(`${baseUrl}/api/metrics/latest`)).json()) as {
        metric: string;
        value: number;
      }[];
      value = latest.find((row) => row.metric === 'cpu_load')?.value;
      if (value === undefined) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(value).toBe(55.5);
  }, 30_000);
});
