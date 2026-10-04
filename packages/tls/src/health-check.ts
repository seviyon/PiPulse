import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { RELEASE_DEFAULT, readTlsConfig } from './config.js';
import { parseSans } from './inspect.js';
import { parseBundle, parseCertificateFile } from './pem.js';

export interface CheckResult {
  /** 0 healthy, 1 unhealthy or not answering, 2 TLS verification failed. */
  code: 0 | 1 | 2;
  message: string;
}

// Node's (OpenSSL X509_V_ERR) codes for a certificate the client refuses (as opposed to a server that isn't there).
export const VERIFY_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'INVALID_CA',
  'INVALID_PURPOSE',
  'CERT_CHAIN_TOO_LONG',
  'PATH_LENGTH_EXCEEDED',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE'
]);

/** Node reports name-constraint violations as UNSPECIFIED, with OpenSSL's text. */
export function verificationFailure(error: { code?: string; message: string }): boolean {
  if (VERIFY_CODES.has(error.code ?? '')) return true;
  return error.code === 'UNSPECIFIED' && /subtree violation|name constraint/i.test(error.message);
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const MAX_HEALTH_BODY_BYTES = 64 * 1024;

/** Monitoring is running; a pre-6b server (no `monitoring` field) says status ok. */
export function healthy(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const { monitoring, status } = body as { monitoring?: unknown; status?: unknown };
  return monitoring === 'ok' || (monitoring === undefined && status === 'ok');
}

const WILDCARDS = new Set(['0.0.0.0', '::', '[::]']);

/**
 * Where the check connects and which identity the certificate must be valid
 * for. A concrete PIPULSE_HOST is verified as exactly that address or name,
 * so a certificate that doesn't cover the configured endpoint fails. A
 * wildcard bind has no single endpoint: loopback, verified for the name the
 * operator declared (PIPULSE_TLS_NAMES), else a local identity the
 * certificate lists, else its first DNS name.
 */
export function healthTarget(
  env: NodeJS.ProcessEnv,
  sans: { dns: string[]; ip: string[] },
  names: string[]
): { connect: string; identity: string } {
  const configured = env['PIPULSE_HOST']?.trim();
  if (configured && !WILDCARDS.has(configured)) {
    const host = configured.replace(/^\[(.*)\]$/, '$1');
    return { connect: host, identity: host };
  }
  const identity =
    names[0] ??
    (sans.dns.includes('localhost')
      ? 'localhost'
      : sans.ip.includes('127.0.0.1')
        ? '127.0.0.1'
        : (sans.ip[0] ?? sans.dns[0] ?? '127.0.0.1'));
  return { connect: '127.0.0.1', identity };
}

/**
 * The one check the installer, the Docker HEALTHCHECK and `pipulse tls enable`
 * share: resolves the mode as the server does, then asks /api/health. Over
 * HTTPS it verifies the certificate against the active source's trust
 * (PIPULSE_TLS_CA or Node's bundled root certificates for an operator certificate, ca.crt for
 * a generated one) and for the identity healthTarget() picks — verification
 * is never turned off.
 */
export async function checkHealth(
  env: NodeJS.ProcessEnv,
  options: { timeoutMs?: number; readState?: (path: string) => string | undefined } = {}
): Promise<CheckResult> {
  let config;
  try {
    config = readTlsConfig(env, {
      releaseDefault: RELEASE_DEFAULT,
      ...(options.readState ? { readState: options.readState } : {})
    });
  } catch (error) {
    return { code: 1, message: messageOf(error) };
  }
  const port = Number(env['PIPULSE_PORT']?.trim() || 8889);
  const timeoutMs = options.timeoutMs ?? 4000;

  if (config.mode === 'http' || !config.source) {
    const { connect: host } = healthTarget(env, { dns: [], ip: [] }, []);
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/api/health`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const body: unknown = await res.json().catch(() => undefined);
      return res.ok && healthy(body)
        ? { code: 0, message: 'healthy' }
        : { code: 1, message: `unhealthy (HTTP ${res.status})` };
    } catch (error) {
      return { code: 1, message: `not answering: ${messageOf(error)}` };
    }
  }

  const source = config.source;
  let certs: string[];
  let ca: string | undefined;
  let target: { connect: string; identity: string };
  try {
    if (source.kind === 'operator') {
      certs = parseCertificateFile(readFileSync(source.certPath, 'utf8'), 'PIPULSE_TLS_CERT');
      ca = source.caPath ? readFileSync(source.caPath, 'utf8') : undefined;
    } else {
      certs = parseBundle(readFileSync(source.bundlePath, 'utf8'), 'leaf.pem').certs;
      ca = readFileSync(source.caPath, 'utf8');
    }
    target = healthTarget(
      env,
      parseSans(new X509Certificate(certs[0]!).subjectAltName),
      config.names
    );
  } catch (error) {
    return { code: 1, message: `can't read the certificate: ${messageOf(error)}` };
  }
  const { connect, identity } = target;
  // SNI carries names only (never IPs); the identity check is explicit either way.
  const byName = isIP(identity) === 0;

  return new Promise<CheckResult>((resolve) => {
    let settled = false;
    const finish = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const req = request(
      {
        host: connect,
        port,
        path: '/api/health',
        ...(byName ? { servername: identity } : {}),
        // tls.checkServerIdentity never matches an IPv6 literal (it runs the host through
        // domainToASCII, which returns ''), so an IP identity goes through X509Certificate.
        checkServerIdentity: (_host, cert) =>
          isIP(identity) !== 0
            ? new X509Certificate(cert.raw).checkIP(identity)
              ? undefined
              : Object.assign(new Error(`IP ${identity} is not in the certificate`), {
                  code: 'ERR_TLS_CERT_ALTNAME_INVALID'
                })
            : checkServerIdentity(identity, cert),
        headers: { host: identity.includes(':') ? `[${identity}]:${port}` : `${identity}:${port}` },
        timeout: timeoutMs,
        ...(ca !== undefined ? { ca } : {})
      },
      (res) => {
        let data = '';
        let bytes = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_HEALTH_BODY_BYTES) {
            req.destroy(new Error('health response is too large'));
            return;
          }
          data += chunk;
        });
        res.on('end', () => {
          let body: unknown;
          try {
            body = JSON.parse(data);
          } catch {
            body = undefined;
          }
          finish(
            res.statusCode === 200 && healthy(body)
              ? { code: 0, message: 'healthy' }
              : { code: 1, message: `unhealthy (HTTP ${res.statusCode ?? '?'})` }
          );
        });
      }
    );
    const deadline = setTimeout(() => {
      req.destroy(new Error('timed out'));
    }, timeoutMs);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      finish(
        verificationFailure({ code, message: messageOf(error) })
          ? {
              code: 2,
              message: `TLS verification failed: ${VERIFY_CODES.has(code) ? code : messageOf(error)}`
            }
          : { code: 1, message: `not answering: ${messageOf(error)}` }
      );
    });
    req.end();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkHealth(process.env);
  if (result.code !== 0) console.error(`[pipulse] health check: ${result.message}`);
  process.exit(result.code);
}
