import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';

const BODY =
  '<!doctype html><meta charset="utf-8"><title>PiPulse uses HTTPS</title>' +
  '<p>This PiPulse address uses <strong>HTTPS</strong>. Put <code>https://</code> in front of the same address and port, and update your bookmark.</p>\n';

/** Fixed bytes: nothing from the request is read, echoed or routed. */
export const HINT_RESPONSE =
  'HTTP/1.1 400 Bad Request\r\n' +
  'Content-Type: text/html; charset=utf-8\r\n' +
  `Content-Length: ${Buffer.byteLength(BODY)}\r\n` +
  'Cache-Control: no-store\r\n' +
  'Connection: close\r\n\r\n' +
  BODY;

/**
 * tlsClientError handler: a plain-HTTP request (an old http:// bookmark) that
 * OpenSSL already recognised gets the hint page on the raw socket; anything
 * else is dropped, as Node does without a handler. `_parent` (the TCP socket
 * under the TLS one) is undocumented: without it, the request is dropped too. Node has already
 * destroyed the TLS socket by now, so a request of hundreds of KB (never a browser's) can lose
 * the page to a connection reset; normal requests arrive whole and get it.
 */
export function answerPlainHttp(error: Error & { code?: string }, socket: TLSSocket): void {
  const raw = (socket as unknown as { _parent?: Socket | null })._parent;
  if (error.code === 'ERR_SSL_HTTP_REQUEST' && raw && raw.writable && !raw.destroyed) {
    raw.setTimeout(5000, () => raw.destroy());
    raw.end(HINT_RESPONSE);
    return;
  }
  socket.destroy();
}
