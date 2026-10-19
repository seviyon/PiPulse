export class PemError extends Error {
  override name = 'PemError';
}

export const MAX_PEM_BYTES = 64 * 1024;
export const MAX_PEM_BLOCKS = 8;

export interface PemBlock {
  label: string;
  /** The block rebuilt with LF endings, ready for node:crypto / node:tls. */
  pem: string;
}

// One block from the current position (sticky); the body is base64 lines only,
// so RFC 1421 headers (Proc-Type: 4,ENCRYPTED) don't match.
const BLOCK =
  /-----BEGIN ([A-Z0-9 ]+)-----\n([A-Za-z0-9+/=\n]+)-----END ([A-Z0-9 ]+)-----(?:\n|$)/y;

/**
 * Splits `text` into PEM blocks. CRLF is normalised for parsing only; only
 * whitespace may sit between blocks. Errors name `what` (a setting or file
 * name) and never quote the content.
 */
export function parsePemBlocks(text: string, what: string): PemBlock[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_PEM_BYTES) {
    throw new PemError(`${what} is larger than 64 KiB`);
  }
  // CRLF and bare CR to LF, and no trailing blanks on a line (an editor or a mail client
  // adds them): per line, so a long run of spaces can't make the match quadratic.
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
  const blocks: PemBlock[] = [];
  let at = 0;
  for (;;) {
    while (at < normalized.length && /\s/.test(normalized[at]!)) at++;
    if (at >= normalized.length) break;
    BLOCK.lastIndex = at;
    const match = BLOCK.exec(normalized);
    if (!match || match[1] !== match[3]) {
      throw new PemError(`${what} has content that isn't a PEM block`);
    }
    blocks.push({
      label: match[1]!,
      pem: `-----BEGIN ${match[1]}-----\n${match[2]}-----END ${match[1]}-----\n`
    });
    if (blocks.length > MAX_PEM_BLOCKS) throw new PemError(`${what} has more than 8 PEM blocks`);
    at = BLOCK.lastIndex;
  }
  if (blocks.length === 0) throw new PemError(`${what} is empty`);
  return blocks;
}

const OPERATOR_KEY_LABELS = new Set(['PRIVATE KEY', 'EC PRIVATE KEY', 'RSA PRIVATE KEY']);

// A legacy (RFC 1421) encrypted key keeps its header inside the block, which the block
// pattern doesn't match: say what it is instead of "isn't a PEM block".
const LEGACY_ENCRYPTED = /^Proc-Type:\s*4,\s*ENCRYPTED\s*$/im;

function refuseEncrypted(blocks: PemBlock[], what: string): void {
  if (blocks.some((block) => block.label === 'ENCRYPTED PRIVATE KEY')) {
    throw new PemError(`${what} is encrypted; PiPulse needs an unencrypted key`);
  }
}

function refuseLegacyEncrypted(text: string, what: string): void {
  if (text.length <= MAX_PEM_BYTES * 2 && LEGACY_ENCRYPTED.test(text))
    throw new PemError(`${what} is encrypted; PiPulse needs an unencrypted key`);
}

/** A generated leaf.pem: one PKCS#8 PRIVATE KEY and the certificate chain, leaf first. */
export function parseBundle(text: string, what: string): { key: string; certs: string[] } {
  refuseLegacyEncrypted(text, what);
  const blocks = parsePemBlocks(text, what);
  refuseEncrypted(blocks, what);
  const other = blocks.find((b) => b.label !== 'PRIVATE KEY' && b.label !== 'CERTIFICATE');
  if (other) throw new PemError(`${what} has an unexpected ${other.label} block`);
  const keys = blocks.filter((b) => b.label === 'PRIVATE KEY');
  if (keys.length !== 1) throw new PemError(`${what} must hold exactly one PRIVATE KEY`);
  const certs = blocks.filter((b) => b.label === 'CERTIFICATE').map((b) => b.pem);
  if (certs.length === 0) throw new PemError(`${what} has no certificate`);
  return { key: keys[0]!.pem, certs };
}

/** An operator key file: one unencrypted PKCS#8, SEC1 (EC) or PKCS#1 (RSA) key. */
export function parseKeyFile(text: string, what: string): string {
  refuseLegacyEncrypted(text, what);
  // `openssl ecparam -genkey` writes the curve parameters before the key: not a second key.
  const blocks = parsePemBlocks(text, what).filter((block) => block.label !== 'EC PARAMETERS');
  refuseEncrypted(blocks, what);
  if (blocks.length !== 1 || !OPERATOR_KEY_LABELS.has(blocks[0]!.label)) {
    throw new PemError(`${what} must hold exactly one private key`);
  }
  return blocks[0]!.pem;
}

/** A certificate file (operator certificate + chain, or a CA file): certificates only. */
export function parseCertificateFile(text: string, what: string): string[] {
  const blocks = parsePemBlocks(text, what);
  const other = blocks.find((b) => b.label !== 'CERTIFICATE');
  if (other) throw new PemError(`${what} has an unexpected ${other.label} block`);
  return blocks.map((b) => b.pem);
}
