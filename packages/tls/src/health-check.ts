import { X509Certificate } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity, rootCertificates } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { RELEASE_DEFAULT, listenPort, readTlsConfig } from './settings/config.js';
import { parseSans } from './inspect/inspect.js';
import { userId } from './ca/layout.js';
import { parseBundle, parseCertificateFile } from './common/pem.js';
import { DEFAULT_RUNTIME_DIR, readRuntimeStatus, type RuntimeView } from './ca/runtime-status.js';

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

/** The served certificate was not issued by the CA in ca.crt. */
const ISSUER_MISMATCH = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_SIGNATURE_FAILURE'
]);
/** How long after leaf.pem was written the server may still be serving the one before it. */
export const RELOAD_PENDING_MS = 10 * 60_000;

/**
 * `new-ca` and `restore-ca` put the new CA's ca.crt and leaf.pem on disk before the server's
 * reloader (two stable 60 s polls) switches to them; until then the served certificate does not
 * verify against ca.crt. That window is not a broken server: a message when (and only when) the
 * leaf on disk is recent AND the running server says it serves a different certificate than
 * leaf.pem holds. Anything else stays a verification failure.
 */
export function pendingReload(
  bundlePath: string,
  leafPem: string,
  env: NodeJS.ProcessEnv,
  options: { servedFingerprint?: () => string | undefined; now?: () => number }
): string | undefined {
  try {
    const age = (options.now ?? Date.now)() - statSync(bundlePath).mtimeMs;
    if (age < 0 || age > RELOAD_PENDING_MS) return undefined;
    const served = options.servedFingerprint?.() ?? servedByStatusFile(env);
    if (served === undefined || served === new X509Certificate(leafPem).fingerprint256)
      return undefined;
    return `healthy: certificate replacement pending reload (leaf.pem was written ${Math.round(age / 1000)} s ago and the server still serves the previous one); not verified`;
  } catch {
    return undefined;
  }
}

/** The certificate a running server says it serves; undefined when the status file doesn't say. */
export function servedFingerprintOf(view: RuntimeView): string | undefined {
  return view.state === 'running' ? view.status.certificate?.fingerprint : undefined;
}

function servedByStatusFile(env: NodeJS.ProcessEnv): string | undefined {
  return servedFingerprintOf(
    readRuntimeStatus(env['PIPULSE_RUNTIME_DIR']?.trim() || DEFAULT_RUNTIME_DIR, {
      expectUid: userId('pipulse')
    })
  );
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
  // A wildcard (`*.example.com`) is no host name: probing it would send `Host: *.example.com`,
  // which the server's allowed-hosts list can't hold. Use a plain name, else a name the wildcard covers.
  const plain = sans.dns.find((name) => !name.startsWith('*'));
  const wildcard = sans.dns.find((name) => name.startsWith('*.'));
  const identity =
    names[0] ??
    (sans.dns.includes('localhost')
      ? 'localhost'
      : sans.ip.includes('127.0.0.1')
        ? '127.0.0.1'
        : (sans.ip[0] ??
          plain ??
          (wildcard ? `pipulse.${wildcard.slice(2)}` : undefined) ??
          '127.0.0.1'));
  return { connect: '127.0.0.1', identity };
}

/**
 * GET over plain HTTP: no redirect followed, no proxy (a fresh Agent never reads
 * NODE_USE_ENV_PROXY / HTTP_PROXY, which Node 24 applies to `fetch` and to the default agent,
 * loopback included), the body read only up to MAX_HEALTH_BODY_BYTES, the whole answer within
 * `timeoutMs`.
 */
function httpGet(
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs);
    const req = httpRequest(
      { host, port, path: '/api/health', agent: new HttpAgent({ keepAlive: false }) },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_HEALTH_BODY_BYTES) {
            req.destroy(new Error('health response is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          clearTimeout(deadline);
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = undefined;
          }
          resolve({ status: res.statusCode!, body }); // always set on a client response
        });
      }
    );
    req.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    req.end();
  });
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
  options: {
    timeoutMs?: number;
    readState?: (path: string) => string | undefined;
    /** SHA-256 of the certificate the running server serves (tests; else its status file). */
    servedFingerprint?: () => string | undefined;
    now?: () => number;
  } = {}
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
  let port: number;
  try {
    port = listenPort(env);
  } catch (error) {
    return { code: 1, message: messageOf(error) };
  }
  const timeoutMs = options.timeoutMs ?? 4000;

  if (config.mode === 'http' || !config.source) {
    const { connect: host } = healthTarget(env, { dns: [], ip: [] }, []);
    try {
      // A redirect is not an answer from PiPulse, and only a small JSON body is expected.
      const res = await httpGet(host, port, timeoutMs);
      return res.status === 200 && healthy(res.body)
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
        // Never inherited from NODE_TLS_REJECT_UNAUTHORIZED: the Docker HEALTHCHECK and a root
        // shell see the operator's environment, and "0" there would turn every check off.
        rejectUnauthorized: true,
        // A fresh agent: Node 24 sends the default agent's requests through HTTP(S)_PROXY when
        // NODE_USE_ENV_PROXY is set, loopback included.
        agent: new HttpsAgent({ keepAlive: false }),
        // Exactly what the server judges an operator certificate by: PIPULSE_TLS_CA, else Node's
        // bundled roots. Without this, NODE_EXTRA_CA_CERTS (set for webhooks) would be trusted too.
        ca: ca ?? [...rootCertificates]
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
              : {
                  code: 1,
                  message:
                    res.statusCode === 421
                      ? `unhealthy (HTTP 421): the server refused the host name ${identity}; set PIPULSE_TLS_NAMES to a name the certificate covers (it is added to PIPULSE_ALLOWED_HOSTS)`
                      : `unhealthy (HTTP ${res.statusCode})`
                }
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
      const pending =
        source.kind === 'generated' && ISSUER_MISMATCH.has(code)
          ? pendingReload(source.bundlePath, certs[0]!, env, options)
          : undefined;
      if (pending) return finish({ code: 0, message: pending });
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
