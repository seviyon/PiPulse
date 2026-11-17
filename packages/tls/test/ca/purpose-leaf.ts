import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { TEST_OPENSSL } from '../openssl.js';

/**
 * Test-only leaves for the CA purpose-limit tests. Production's issueLeaf only makes a web
 * server leaf, so the permissive and odd leaves the tests need (no EKU, clientAuth only, email
 * and URI names) are signed here, directly with OpenSSL. The subject has a space so it never
 * reads as a host name: when a leaf has no DNS name, OpenSSL may check a host-like CN against
 * the DNS constraints, and that would spoil the result for the SAN or EKU under test.
 */
export function signTestLeaf(o: {
  dir: string;
  ca: { keyPath: string; certPath: string };
  name: string;
  san: string;
  /** Written as extendedKeyUsage; no extension when left out. */
  eku?: string;
}): string {
  const key = join(o.dir, `${o.name}.key`);
  const csr = join(o.dir, `${o.name}.csr`);
  const ext = join(o.dir, `${o.name}.ext`);
  const crt = join(o.dir, `${o.name}.crt`);
  execFileSync(
    TEST_OPENSSL,
    [
      'req',
      '-new',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      csr,
      '-subj',
      '/CN=purpose test'
    ],
    { stdio: 'pipe' }
  );
  writeFileSync(
    ext,
    [
      'basicConstraints = critical, CA:FALSE',
      'keyUsage = critical, digitalSignature',
      `subjectAltName = ${o.san}`,
      ...(o.eku === undefined ? [] : [`extendedKeyUsage = ${o.eku}`])
    ].join('\n') + '\n'
  );
  execFileSync(
    TEST_OPENSSL,
    [
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      o.ca.certPath,
      '-CAkey',
      o.ca.keyPath,
      '-CAcreateserial',
      '-CAserial',
      join(o.dir, `${o.name}.srl`),
      '-days',
      '30',
      '-extfile',
      ext,
      '-out',
      crt
    ],
    { stdio: 'pipe' }
  );
  return crt;
}

/** `openssl verify` of a leaf against one CA file, optionally for a purpose. */
export function verifyAgainst(
  caPath: string,
  leafPath: string,
  purpose?: 'sslserver' | 'sslclient' | 'smimesign'
): { ok: boolean; output: string } {
  const run = spawnSync(
    TEST_OPENSSL,
    ['verify', '-CAfile', caPath, ...(purpose ? ['-purpose', purpose] : []), leafPath],
    { encoding: 'utf8' }
  );
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}` };
}
