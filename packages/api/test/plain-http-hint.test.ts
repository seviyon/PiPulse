import { request, createServer, type Server } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerPlainHttp } from '../src/plain-http.js';
import { fixture } from '../../tls/test/helpers.js';

let server: Server;
let port: number;
beforeEach(async () => {
  server = createServer(
    { key: fixture('leaf.key'), cert: fixture('leaf.crt') + fixture('intermediate.crt') },
    (_q, r) => r.end('tls ok')
  );
  server.on('tlsClientError', answerPlainHttp);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const raw = (bytes: string) =>
  new Promise<string>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(bytes));
    let got = '';
    socket.on('data', (d) => (got += d.toString()));
    socket.on('close', () => resolve(got));
    socket.on('error', () => resolve(got));
  });

describe('plain HTTP on the HTTPS port', () => {
  it('answers a fixed 400 page pointing at https://, and closes', async () => {
    const answer = await raw('GET /api/health HTTP/1.1\r\nHost: evil.example\r\n\r\n');
    expect(answer).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(answer).toContain('https://');
    expect(answer).not.toContain('evil.example');
    expect(answer).toContain('Connection: close');
  });
  it('drops anything that is neither TLS nor HTTP', async () => {
    expect(await raw('\x00\x01garbage\r\n\r\n')).toBe('');
  });
  it('keeps serving TLS afterwards', async () => {
    await raw('GET / HTTP/1.1\r\n\r\n');
    const body = await new Promise<string>((resolve, reject) => {
      request(
        {
          host: '127.0.0.1',
          port,
          ca: fixture('root-ca.crt'),
          servername: 'localhost',
          agent: false
        },
        (res) => {
          let text = '';
          res.on('data', (d) => (text += d));
          res.on('end', () => resolve(text));
        }
      )
        .on('error', reject)
        .end();
    });
    expect(body).toBe('tls ok');
  });
});

// Node has destroyed the TLS socket by the time the handler runs, so a request far bigger than
// any browser sends (hundreds of KB) can lose the page to a reset. Browsers cap headers at
// ~8-64 KB; these sizes must always get the hint, on every Node line CI runs.
describe('plain HTTP requests of browser size', () => {
  it.each([1_000, 8_000, 16_000, 64_000])(
    'still delivers the hint for %i bytes of headers',
    async (size) => {
      const request = `GET / HTTP/1.1\r\nHost: x\r\nCookie: ${'a'.repeat(size)}\r\n\r\n`;
      const answer = await raw(request);
      expect(answer).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    }
  );
});
