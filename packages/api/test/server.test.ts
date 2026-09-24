import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { openDb, saveSettings } from '@pipulse/storage';
import { SAVED_RULES_KEY } from '@pipulse/alerts';

// Runs the built server (root `pretest` builds it) as a real process — the
// Phase 2 exit criterion: plain HTTP and a WebSocket client both get live data.
const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url));

let dir: string;

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('api server process', () => {
  it('serves collected metrics over HTTP, pushes live samples over WebSocket, and exits cleanly', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pipulse-api-'));
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverPath], {
      env: {
        ...process.env,
        PIPULSE_DB_PATH: join(dir, 'pipulse.sqlite'),
        PIPULSE_HOST: '127.0.0.1',
        PIPULSE_PORT: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

    const baseUrl = await Promise.race([
      new Promise<string>((resolve) => {
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          const match = /listening on (http:\/\/\S+)/.exec(stdout);
          if (match?.[1]) resolve(match[1]);
        });
      }),
      once(child, 'exit').then(([code]) => {
        throw new Error(`server exited early with code ${String(code)}: ${stderr}`);
      })
    ]);

    const dashboard = await fetch(`${baseUrl}/`);
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain('<div id="app">');

    const config = (await (await fetch(`${baseUrl}/api/config`)).json()) as {
      plugins: { id: string }[];
      device: { memoryTotalMb: number; kernel: string };
      uptimeMs: number;
    };
    expect(config.plugins.map((plugin) => plugin.id)).toContain('cpu_load');
    expect(config.device.memoryTotalMb).toBeGreaterThan(0);
    expect(config.uptimeMs).toBeGreaterThan(0);
    expect(config.device.kernel).not.toBe('');

    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/live`);
    type LiveMessage =
      { type: 'snapshot'; samples: { metric: string }[] } | { type: 'sample'; metric: string };
    let resolvePushed: (metric: string) => void;
    let resolveCpuLoad: () => void;
    const pushed = new Promise<string>((resolve) => (resolvePushed = resolve));
    // Plugins finish their first read at different times (cpu_load's takes
    // ~500 ms on CI runners), so wait for cpu_load specifically — from the
    // snapshot if it landed before we connected, else from a pushed sample.
    const cpuLoadSeen = new Promise<void>((resolve) => (resolveCpuLoad = resolve));
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as LiveMessage;
      const metrics =
        message.type === 'snapshot'
          ? message.samples.map((sample) => sample.metric)
          : [message.metric];
      if (message.type === 'sample') resolvePushed(message.metric);
      if (metrics.includes('cpu_load')) resolveCpuLoad();
    });
    // cpu_load/memory_used poll every 5 s, so a pushed sample arrives within ~5 s.
    expect(await pushed).toEqual(expect.any(String));
    await cpuLoadSeen;
    socket.close();

    const latest = (await (await fetch(`${baseUrl}/api/metrics/latest`)).json()) as {
      metric: string;
    }[];
    expect(latest.map((sample) => sample.metric)).toContain('cpu_load');

    const series = (await (
      await fetch(`${baseUrl}/api/metrics/cpu_load/series?from=${Date.now() - 600_000}`)
    ).json()) as {
      resolution: string;
      points: unknown[];
    };
    expect(series.resolution).toBe('raw');
    expect(series.points.length).toBeGreaterThan(0);

    child.kill('SIGTERM');
    const [exitCode] = await once(child, 'exit');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  }, 20000);

  it('checks only rules in force against saved raw retention at startup', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pipulse-api-'));
    const dbPath = join(dir, 'pipulse.sqlite');
    const rulesPath = join(dir, 'alerts.json');
    writeFileSync(
      rulesPath,
      JSON.stringify({
        rules: [
          {
            id: 'long_for',
            metric: 'cpu_load',
            atLeast: 50,
            for: '2h',
            severity: 'warning',
            message: 'Busy'
          }
        ]
      })
    );
    const db = openDb(dbPath);
    saveSettings(db, { 'retention.raw': '1h' });
    db.close();
    const start = (disabled: boolean) => {
      const seeded = openDb(dbPath);
      saveSettings(seeded, {
        [SAVED_RULES_KEY]: disabled ? [{ id: 'long_for', disabled: true }] : undefined
      });
      seeded.close();
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverPath], {
        env: {
          ...process.env,
          PIPULSE_DB_PATH: dbPath,
          PIPULSE_HOST: '127.0.0.1',
          PIPULSE_PORT: '0',
          PIPULSE_ALERTS_FILE: rulesPath
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      return Promise.race([
        new Promise<'listening'>((resolve) => {
          child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
            if (stdout.includes('listening on')) {
              child.kill('SIGTERM');
              resolve('listening');
            }
          });
        }),
        once(child, 'exit').then(([code]) => `exited ${String(code)}: ${stderr}`)
      ]).then(async (outcome) => {
        if (outcome === 'listening' && child.exitCode === null) await once(child, 'exit');
        return outcome;
      });
    };

    // In force (the file rule as written): 1 h of raw readings can't serve it.
    expect(await start(false)).toMatch(
      /exited 1: .*raw retention saved on the Settings page \(1h\) is shorter than rule "long_for"/
    );
    // Disabled from the browser, it never runs, so the server starts.
    expect(await start(true)).toBe('listening');
  }, 20000);

  it('refuses to start with an invalid retention setting, naming the variable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pipulse-api-'));
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverPath], {
      env: {
        ...process.env,
        PIPULSE_DB_PATH: join(dir, 'pipulse.sqlite'),
        PIPULSE_PORT: '0',
        PIPULSE_RETENTION_RAW: '10m'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const [exitCode] = await once(child, 'exit');

    expect(exitCode).toBe(1);
    expect(stderr).toContain('[pipulse] PIPULSE_RETENTION_RAW must be a duration like');
    // A readable message, not a stack trace.
    expect(stderr).not.toContain('    at ');
  });
});
