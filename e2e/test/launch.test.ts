import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertSample } from '@pipulse/storage';
import { afterEach, describe, expect, it } from 'vitest';
import {
  E2E_PASSWORD,
  liveServerCount,
  startServer,
  type RunningServer
} from '../src/harness/launch.js';
import { TLS_FIXTURES } from '../src/harness/paths.js';

const running: RunningServer[] = [];
const start = async (...args: Parameters<typeof startServer>) => {
  const server = await startServer(...args);
  running.push(server);
  return server;
};
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  delete process.env['PIPULSE_PROTECT_READS'];
  delete process.env['PIPULSE_TLS'];
});

const json = async <T>(url: string, init?: RequestInit) =>
  (await fetch(url, init)).json() as Promise<T>;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('startServer', () => {
  it('starts a plain HTTP server in its own folder, and stop() ends it', async () => {
    const server = await start();
    expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
    expect(await json(`${server.baseUrl}/api/session`)).toMatchObject({
      editable: false,
      protectReads: false
    });
    expect(existsSync(join(server.dir, 'pipulse.sqlite'))).toBe(true);
    const { pid } = server;
    expect(alive(pid)).toBe(true);
    await server.stop();
    expect(alive(pid)).toBe(false);
    expect(existsSync(server.dir)).toBe(false);
  });

  it('does not inherit the developer’s PIPULSE_* settings', async () => {
    process.env['PIPULSE_PROTECT_READS'] = 'true';
    process.env['PIPULSE_TLS'] = 'on';
    const server = await start();
    expect(server.baseUrl.startsWith('http://')).toBe(true);
    const config = await fetch(`${server.baseUrl}/api/config`);
    expect(config.status).toBe(200);
  });

  it('refuses to hand out a server whose plugins are not the fakes', async () => {
    const folders = () => readdirSync(tmpdir()).filter((name) => name.startsWith('pipulse-e2e-'));
    const before = folders();
    await expect(startServer({ hook: false })).rejects.toThrow(/fake collector not loaded/);
    // Nothing is left behind: no folder (and the process was killed before the folder went).
    expect(folders()).toEqual(before);
  });

  it('the drift guard also works with read protection and with HTTPS, and leaves no process', async () => {
    await expect(startServer({ hook: false, password: true, protectReads: true })).rejects.toThrow(
      /fake collector not loaded/
    );
    await expect(startServer({ hook: false, tls: true })).rejects.toThrow(
      /fake collector not loaded/
    );
    expect(liveServerCount()).toBe(0);
  });

  it('writes an admin password when asked, and the password signs in', async () => {
    const server = await start({ password: true });
    expect(await json(`${server.baseUrl}/api/session`)).toMatchObject({ editable: true });
    const response = await fetch(`${server.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.baseUrl },
      body: JSON.stringify({ password: E2E_PASSWORD })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('pipulse_session=');
  });

  it('protects reads when asked', async () => {
    const server = await start({ password: true, protectReads: true });
    expect((await fetch(`${server.baseUrl}/api/config`)).status).toBe(401);
  });

  it('restart() keeps the port and the database', async () => {
    const server = await start({ readings: { cpu_load: 33 } });
    const seen = async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const rows = await json<{ metric: string; value: number }[]>(
          `${server.baseUrl}/api/metrics/latest`
        );
        const row = rows.find((r) => r.metric === 'cpu_load');
        if (row) return row.value;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return undefined;
    };
    expect(await seen()).toBe(33);
    const { port, dir } = server;
    server.setReadings({ cpu_load: 44 });
    await server.restart();
    expect(server.port).toBe(port);
    expect(server.dir).toBe(dir);
    // Right after the restart the stored reading is still there (it may already be the new one).
    const rows = await json<{ metric: string }[]>(`${server.baseUrl}/api/metrics/latest`);
    expect(rows.some((r) => r.metric === 'cpu_load')).toBe(true);
  });

  it('halt() stops the process but keeps the folder, and restart() brings it back', async () => {
    const server = await start({});
    const { dir, port } = server;
    await server.halt();
    await expect(fetch(`${server.baseUrl}/health`)).rejects.toThrow();
    expect(existsSync(dir)).toBe(true);
    await server.restart();
    expect(server.port).toBe(port);
    expect((await fetch(`${server.baseUrl}/api/config`)).status).toBe(200);
  });

  it('runs seed(db, now) before the server starts, so the history is there from the first request', async () => {
    let seenNow = 0;
    const server = await start({
      seed: (db, now) => {
        seenNow = now;
        insertSample(db, { metric: 'memory_used', ts: now - 3_600_000, value: 77 });
      }
    });
    expect(seenNow).toBeGreaterThan(0);
    const from = seenNow - 7_200_000;
    const rows = await json<{ ts: number; value: number }[]>(
      `${server.baseUrl}/api/metrics/memory_used/history?from=${from}&to=${seenNow}`
    );
    expect(rows.map((row) => row.value)).toContain(77);
  });

  it('keeps the server’s output for the report', async () => {
    const server = await start();
    expect(server.logs()).toContain('listening on');
    expect(server.logs()).toContain('[e2e] fake alert engine:');
  });

  it('serves HTTPS with the verified test certificate when asked', async () => {
    const server = await start({ tls: true });
    expect(server.baseUrl).toBe(`https://127.0.0.1:${server.port}`);
    const body = await new Promise<string>((resolve, reject) => {
      get(
        `${server.baseUrl}/api/session`,
        { ca: readFileSync(join(TLS_FIXTURES, 'root-ca.crt')), servername: 'localhost' },
        (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString()));
          res.on('end', () => resolve(text));
        }
      ).on('error', reject);
    });
    expect(JSON.parse(body)).toMatchObject({ editable: false });
  });

  describe('refuses bad options', () => {
    it('a missing dashboard build', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'e2e-empty-'));
      try {
        await expect(startServer({ webDist: empty })).rejects.toThrow(/run npm run build first/);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });

    it('an environment variable that is not PIPULSE_*', async () => {
      await expect(startServer({ env: { PATH: 'x' } })).rejects.toThrow(/only PIPULSE_/);
    });

    it('an environment variable the harness manages itself', async () => {
      await expect(
        startServer({ env: { PIPULSE_DB_PATH: '/tmp/elsewhere.sqlite' } })
      ).rejects.toThrow(/managed by the harness/);
    });

    it('read protection without a password', async () => {
      await expect(startServer({ protectReads: true })).rejects.toThrow(/needs password/);
    });
  });
});
