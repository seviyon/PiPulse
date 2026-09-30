import { rmSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { request } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import type { Server as HttpsServer } from 'node:https';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import {
  loadCertificate,
  startReloader,
  statSignature,
  type CertSource,
  type CertificateProvider
} from '@pipulse/tls';
import { hashPassword, parsePasswordHash } from '../src/auth.js';
import { buildServer, createLiveFeed } from '../src/index.js';
import { fixture, tempDir } from '../../tls/test/helpers.js';

const ca = fixture('root-ca.crt');
const chain = (crt: string) => fixture(crt) + fixture('intermediate.crt');

let db: PiPulseDb;
let dir: string;
let app: FastifyInstance | undefined;
let provider: CertificateProvider | undefined;
beforeEach(() => {
  db = openDb(':memory:');
  dir = tempDir();
});
afterEach(async () => {
  provider?.stop();
  provider = undefined;
  await app?.close();
  app = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  fingerprint: string;
}
function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
  payload?: string
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, ca, servername: 'localhost', headers, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            fingerprint: (res.socket as import('node:tls').TLSSocket).getPeerCertificate()
              .fingerprint256
          })
        );
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}
async function start(options: Parameters<typeof buildServer>[1] = {}): Promise<number> {
  app = buildServer(db, {
    https: { key: fixture('leaf.key'), cert: chain('leaf.crt') },
    ...options
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as AddressInfo).port;
}

describe('HTTPS server', () => {
  it('serves the API over TLS that verifies against the test root', async () => {
    const port = await start();
    const res = await get(port, '/api/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ monitoring: 'ok' });
  });

  it('marks the session cookie Secure and accepts an https:// same-host origin', async () => {
    const passwordHash = parsePasswordHash(await hashPassword('secret', { N: 1024, r: 8, p: 1 }));
    const port = await start({ auth: { passwordHash } });
    const res = await get(
      port,
      '/api/login',
      {
        'content-type': 'application/json',
        origin: `https://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`
      },
      'POST',
      JSON.stringify({ password: 'secret' })
    );
    expect(res.status).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/; Secure$/);
  });

  it('sends no HSTS by default and the opted-in max-age when set', async () => {
    let port = await start();
    expect((await get(port, '/api/health')).headers['strict-transport-security']).toBeUndefined();
    await app!.close();
    port = await start({ hstsSeconds: 86_400 });
    expect((await get(port, '/api/health')).headers['strict-transport-security']).toBe(
      'max-age=86400'
    );
  });

  it('never sends HSTS over plain HTTP, even when asked', async () => {
    app = buildServer(db, { hstsSeconds: 86_400 });
    const res = await app.inject('/api/health');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('a plain HTTP request to the HTTPS port is dropped and the server keeps serving', async () => {
    const port = await start();
    await new Promise<void>((resolve) => {
      const socket = connect(port, '127.0.0.1', () =>
        socket.write('GET /api/health HTTP/1.1\r\nHost: x\r\n\r\n')
      );
      socket.on('close', () => resolve());
      socket.on('error', () => resolve());
      socket.resume();
    });
    expect((await get(port, '/api/health')).status).toBe(200);
  });

  it('swaps in a replacement certificate while a wss client stays connected and live data keeps flowing', async () => {
    const certPath = join(dir, 'cert.pem');
    const keyPath = join(dir, 'key.pem');
    writeFileSync(certPath, chain('leaf.crt'));
    writeFileSync(keyPath, fixture('leaf.key'));
    chmodSync(keyPath, 0o600);
    const source: CertSource = { kind: 'operator', certPath, keyPath, caPath: join(dir, 'ca.pem') };
    writeFileSync(source.caPath!, ca);
    const initial = loadCertificate(source, { names: [] });
    const live = createLiveFeed();
    app = buildServer(db, { live, https: { key: initial.key, cert: initial.cert } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    provider = startReloader({
      initial,
      load: () => loadCertificate(source, { names: [] }),
      signature: () => statSignature([certPath, keyPath]),
      apply: (cert) =>
        (app!.server as unknown as HttpsServer).setSecureContext({
          key: cert.key,
          cert: cert.cert
        }),
      timer: false
    });

    const socket = new WebSocket(`wss://127.0.0.1:${port}/api/live`, {
      ca,
      servername: 'localhost'
    });
    const messages: { type: string }[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data)) as { type: string }));
    await new Promise((resolve) => socket.once('open', resolve));
    const before = (await get(port, '/api/health')).fingerprint;

    // Replace atomically (the way the renew job will), then two polls.
    writeFileSync(join(dir, 'key.new'), fixture('leaf2.key'));
    chmodSync(join(dir, 'key.new'), 0o600);
    writeFileSync(join(dir, 'cert.new'), chain('leaf2.crt'));
    renameSync(join(dir, 'key.new'), keyPath);
    renameSync(join(dir, 'cert.new'), certPath);
    provider.poll();
    provider.poll();
    expect(provider.reload()).toMatchObject({ state: 'ok' });

    live.publish({ metric: 'cpu_load', ts: Date.now(), value: 1 });
    await expect.poll(() => messages.some((m) => m.type === 'sample')).toBe(true);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const after = (await get(port, '/api/health')).fingerprint;
    expect(after).not.toBe(before);
    expect(after).toBe(provider.current().fingerprint);

    // A refused replacement (key for another certificate) keeps the new one serving.
    writeFileSync(join(dir, 'cert.new'), chain('leaf.crt'));
    renameSync(join(dir, 'cert.new'), certPath);
    provider.poll();
    provider.poll();
    expect(provider.reload().state).toBe('failing');
    expect((await get(port, '/api/health')).fingerprint).toBe(after);
    socket.close();
  });
});
