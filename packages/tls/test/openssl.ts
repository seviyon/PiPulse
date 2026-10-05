import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * The OpenSSL the tests drive: PIPULSE_TEST_OPENSSL, else Homebrew's
 * openssl@3 (macOS ships LibreSSL as /usr/bin/openssl), else /usr/bin/openssl.
 * Fails loudly rather than skipping: issuance is the riskiest part of 6b-2.
 */
function find(): string {
  const candidates = [
    process.env['PIPULSE_TEST_OPENSSL'],
    '/opt/homebrew/opt/openssl@3/bin/openssl',
    '/usr/local/opt/openssl@3/bin/openssl',
    '/usr/bin/openssl'
  ];
  for (const path of candidates) {
    if (!path || !existsSync(path)) continue;
    const version = execFileSync(path, ['version']).toString();
    if (/^OpenSSL (1\.1\.1|3\.)/.test(version)) return path;
  }
  throw new Error('the tls tests need OpenSSL 1.1.1 or 3.x: set PIPULSE_TEST_OPENSSL');
}

export const TEST_OPENSSL = find();
