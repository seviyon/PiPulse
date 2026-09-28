import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the built command, so it depends on `npm run build` (as `npm test` does first).
const COMMAND = fileURLToPath(new URL('../dist/notify-test.js', import.meta.url));

let server: Server;
let dir: string;
let file: string;
const received: unknown[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      if (request.url === '/ok') received.push(JSON.parse(body));
      response.statusCode = request.url === '/ok' ? 200 : 500;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  dir = mkdtempSync(join(tmpdir(), 'pipulse-notify-test-'));
  file = join(dir, 'notify.json');
  writeFileSync(
    file,
    JSON.stringify({
      webhooks: [
        { id: 'ok', url: `http://127.0.0.1:${port}/ok` },
        { id: 'bad', url: `http://127.0.0.1:${port}/bad` }
      ]
    }),
    { mode: 0o600 }
  );
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

function run(
  args: string[],
  env: Record<string, string | undefined>
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', COMMAND, ...args],
      { env },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      }
    );
  });
}

describe('notify-test', () => {
  it('sends to every webhook and exits 1 when one fails', async () => {
    const result = await run([], { ...process.env, PIPULSE_NOTIFY_FILE: file });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('ok: delivered');
    expect(result.stdout).toContain('bad: failed (HTTP 500)');
  });

  it('sends only the named webhook, a test message, and exits 0', async () => {
    received.length = 0;
    const result = await run(['ok'], { ...process.env, PIPULSE_NOTIFY_FILE: file });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('bad');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'info',
      title: expect.stringContaining('PiPulse test notification')
    });
  });

  it('exits 1 for an unknown webhook id', async () => {
    const result = await run(['nope'], { ...process.env, PIPULSE_NOTIFY_FILE: file });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no webhook "nope"');
  });

  it('exits 2 when PIPULSE_NOTIFY_FILE is unset', async () => {
    const env = { ...process.env };
    delete env['PIPULSE_NOTIFY_FILE'];
    const result = await run([], env);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('PIPULSE_NOTIFY_FILE is not set');
  });
});
