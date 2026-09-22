import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

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

    const config = (await (await fetch(`${baseUrl}/api/config`)).json()) as {
      plugins: { id: string }[];
    };
    expect(config.plugins.map((plugin) => plugin.id)).toContain('cpu_load');

    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/live`);
    const liveSample = new Promise<{ type: string; metric: string }>((resolve) => {
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { type: string; metric: string };
        if (message.type === 'sample') resolve(message);
      });
    });
    // cpu_load/memory_used poll every 5 s, so a pushed sample arrives within ~5 s.
    expect((await liveSample).metric).toEqual(expect.any(String));
    socket.close();

    const latest = (await (await fetch(`${baseUrl}/api/metrics/latest`)).json()) as {
      metric: string;
    }[];
    expect(latest.map((sample) => sample.metric)).toContain('cpu_load');

    child.kill('SIGTERM');
    const [exitCode] = await once(child, 'exit');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  }, 20000);
});
