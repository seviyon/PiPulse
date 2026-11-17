import { describe, expect, it } from 'vitest';
import {
  parseBundle,
  parseCertificateFile,
  parseKeyFile,
  parsePemBlocks,
  PemError
} from '../../src/common/pem.js';
import { fixture } from '../helpers.js';

const leaf = fixture('leaf.crt');
const intermediate = fixture('intermediate.crt');
const key = fixture('leaf.key');

describe('parsePemBlocks', () => {
  it('reads blocks in order and rebuilds each canonically', () => {
    const blocks = parsePemBlocks(key + '\n' + leaf, 'f');
    expect(blocks.map((b) => b.label)).toEqual(['PRIVATE KEY', 'CERTIFICATE']);
    expect(blocks[1]!.pem).toBe(leaf.endsWith('\n') ? leaf : leaf + '\n');
  });

  it('accepts CRLF line endings', () => {
    expect(parsePemBlocks(leaf.replace(/\n/g, '\r\n'), 'f')).toHaveLength(1);
  });

  it.each([
    ['empty', ''],
    ['only whitespace', '\n \n'],
    ['text before a block', 'hello\n' + leaf],
    ['trailing non-PEM data', leaf + 'trailing\n'],
    [
      'content after a broken block',
      '-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----\n' + leaf
    ],
    ['mismatched END label', leaf.replace('END CERTIFICATE', 'END PRIVATE KEY')],
    [
      'a Proc-Type encrypted legacy key',
      '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n\nAAAA\n-----END RSA PRIVATE KEY-----\n'
    ]
  ])('refuses %s', (_name, text) => {
    expect(() => parsePemBlocks(text, 'PIPULSE_TLS_CERT')).toThrow(PemError);
  });

  it('names the setting and never echoes content', () => {
    expect(() => parsePemBlocks('secret-looking junk', 'PIPULSE_TLS_KEY')).toThrow(
      "PIPULSE_TLS_KEY has content that isn't a PEM block"
    );
  });

  it('limits size and block count', () => {
    expect(() => parsePemBlocks(leaf.repeat(9), 'f')).toThrow('more than 8 PEM blocks');
    expect(() => parsePemBlocks('x'.repeat(65 * 1024), 'f')).toThrow('larger than 64 KiB');
  });
});

describe('parseBundle (leaf.pem)', () => {
  it('returns the key and the certificates in order, key first or last', () => {
    expect(parseBundle(key + leaf + intermediate, 'leaf.pem').certs).toHaveLength(2);
    const later = parseBundle(leaf + intermediate + key, 'leaf.pem');
    expect(later.key).toContain('BEGIN PRIVATE KEY');
    expect(later.certs[0]).toContain('BEGIN CERTIFICATE');
  });

  it.each([
    ['no key', leaf, 'exactly one PRIVATE KEY'],
    ['two keys', key + key + leaf, 'exactly one PRIVATE KEY'],
    ['no certificate', key, 'no certificate'],
    ['an EC PRIVATE KEY', fixture('leaf.ec.key') + leaf, 'unexpected EC PRIVATE KEY block'],
    [
      'an RSA PRIVATE KEY',
      fixture('rsa-leaf.rsa.key') + fixture('rsa-leaf.crt'),
      'unexpected RSA PRIVATE KEY block'
    ],
    ['an encrypted key', fixture('leaf.encrypted.key') + leaf, 'is encrypted']
  ])('refuses %s', (_name, text, message) => {
    expect(() => parseBundle(text, 'leaf.pem')).toThrow(message);
  });
});

describe('parseKeyFile (operator key)', () => {
  it.each([
    ['PKCS#8', 'leaf.key', 'BEGIN PRIVATE KEY'],
    ['SEC1', 'leaf.ec.key', 'BEGIN EC PRIVATE KEY'],
    ['PKCS#1', 'rsa-leaf.rsa.key', 'BEGIN RSA PRIVATE KEY']
  ])('accepts %s', (_name, file, begins) => {
    expect(parseKeyFile(fixture(file), 'PIPULSE_TLS_KEY')).toContain(begins);
  });

  it('refuses an encrypted key, a certificate, and two keys', () => {
    expect(() => parseKeyFile(fixture('leaf.encrypted.key'), 'PIPULSE_TLS_KEY')).toThrow(
      'PIPULSE_TLS_KEY is encrypted; PiPulse needs an unencrypted key'
    );
    expect(() => parseKeyFile(leaf, 'PIPULSE_TLS_KEY')).toThrow('exactly one private key');
    expect(() => parseKeyFile(key + key, 'PIPULSE_TLS_KEY')).toThrow('exactly one private key');
  });
});

describe('parseCertificateFile', () => {
  it('returns every certificate', () => {
    expect(parseCertificateFile(leaf + intermediate, 'PIPULSE_TLS_CERT')).toHaveLength(2);
  });

  it('refuses a key inside the certificate file', () => {
    expect(() => parseCertificateFile(leaf + key, 'PIPULSE_TLS_CERT')).toThrow(
      'PIPULSE_TLS_CERT has an unexpected PRIVATE KEY block'
    );
  });
});

describe('review fixes: key files people really have', () => {
  const ecKey = fixture('leaf.ec.key');
  const params = '-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n';
  const legacyEncrypted =
    '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0011\n\nAAAA\n-----END RSA PRIVATE KEY-----\n';

  it('ignores the EC PARAMETERS block that `openssl ecparam -genkey` writes before the key', () => {
    expect(parseKeyFile(params + ecKey, 'k')).toBe(parseKeyFile(ecKey, 'k'));
    expect(() => parseKeyFile(params + ecKey + key, 'k')).toThrow(/exactly one private key/);
    expect(() => parseKeyFile(params, 'k')).toThrow(/exactly one private key/);
  });

  it('says a legacy Proc-Type key is encrypted, in a key file and in a bundle', () => {
    expect(() => parseKeyFile(legacyEncrypted, 'PIPULSE_TLS_KEY')).toThrow(
      'PIPULSE_TLS_KEY is encrypted; PiPulse needs an unencrypted key'
    );
    expect(() => parseBundle(legacyEncrypted + leaf, 'leaf.pem')).toThrow(/is encrypted/);
  });

  it('accepts trailing spaces and tabs on lines, and bare CR line endings', () => {
    const padded = leaf
      .split('\n')
      .map((line) => (line === '' ? line : `${line} \t`))
      .join('\n');
    expect(parseCertificateFile(padded, 'c')).toEqual(parseCertificateFile(leaf, 'c'));
    expect(parseCertificateFile(leaf.replace(/\n/g, '\r'), 'c')).toEqual(
      parseCertificateFile(leaf, 'c')
    );
  });

  it('stays fast on a long run of spaces', () => {
    const started = performance.now();
    expect(() => parsePemBlocks(' '.repeat(60_000) + 'x', 'f')).toThrow(/isn't a PEM block/);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('text outside the blocks of a certificate file (RFC 7468: ignored)', () => {
  const bag = 'Bag Attributes\n    localKeyID: 01 02\nsubject=CN = example\nissuer=CN = ca\n';

  it('skips openssl pkcs12 explanatory text before, between and after certificates', () => {
    const plain = parseCertificateFile(leaf + intermediate, 'c');
    expect(parseCertificateFile(bag + leaf + bag + intermediate + 'end of file\n', 'c')).toEqual(
      plain
    );
  });

  it('skips the text of openssl x509 -text output after the certificate', () => {
    const text = 'Certificate:\n    Data:\n        Version: 3 (0x2)\n';
    expect(parseCertificateFile(text + leaf, 'c')).toEqual(parseCertificateFile(leaf, 'c'));
  });

  it('still refuses a broken certificate block instead of skipping it', () => {
    const broken = '-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----\n';
    expect(() => parseCertificateFile(bag + broken + leaf, 'c')).toThrow(/isn't a PEM block/);
    expect(() => parseCertificateFile(leaf + broken, 'c')).toThrow(/isn't a PEM block/);
    const mismatched = leaf.replace('END CERTIFICATE', 'END PRIVATE KEY');
    expect(() => parseCertificateFile(bag + mismatched, 'c')).toThrow(/isn't a PEM block/);
  });

  it('refuses a file with text and no block, and says so', () => {
    expect(() => parseCertificateFile(bag, 'c')).toThrow('c has no PEM block');
    expect(() => parseCertificateFile('', 'c')).toThrow('c is empty');
  });

  it('only starts a block at the beginning of a line', () => {
    expect(() => parseCertificateFile('see ' + leaf, 'c')).toThrow('c has no PEM block');
  });

  it('keeps the other limits: other labels, 8 blocks, 64 KiB', () => {
    expect(() => parseCertificateFile(bag + leaf + key, 'c')).toThrow(
      /unexpected PRIVATE KEY block/
    );
    expect(() => parseCertificateFile((bag + leaf).repeat(9), 'c')).toThrow(/more than 8/);
    expect(() => parseCertificateFile(bag + 'x'.repeat(64 * 1024) + leaf, 'c')).toThrow(
      /larger than 64 KiB/
    );
    expect(parseCertificateFile((bag + leaf).repeat(8), 'c')).toHaveLength(8);
  });

  it('stays strict for key files, bundles and the generic parser', () => {
    expect(() => parseKeyFile(bag + key, 'k')).toThrow(/isn't a PEM block/);
    expect(() => parseBundle(bag + key + leaf, 'b')).toThrow(/isn't a PEM block/);
    expect(() => parsePemBlocks(bag + leaf, 'f')).toThrow(/isn't a PEM block/);
  });

  it('stays fast on a long run of lines that nearly start a block', () => {
    const started = performance.now();
    expect(() => parseCertificateFile('-----BEGIN\n'.repeat(5000), 'c')).toThrow(
      'c has no PEM block'
    );
    expect(() => parseCertificateFile('-----BEGIN X-----\n'.repeat(3000), 'c')).toThrow(
      /isn't a PEM block/
    );
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('parsePemBlocks edges', () => {
  it('names its error PemError', () => {
    try {
      parsePemBlocks('', 'f');
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).name).toBe('PemError');
      expect(error).toBeInstanceOf(PemError);
    }
  });

  it('reads a last block with no newline after its END line, strict and skipping', () => {
    const noNewline = leaf.trimEnd();
    expect(noNewline.endsWith('\n')).toBe(false);
    expect(parsePemBlocks(noNewline, 'f')).toHaveLength(1);
    expect(parseCertificateFile(noNewline, 'f')).toHaveLength(1);
  });

  it('accepts exactly 64 KiB and refuses one byte more, counted in bytes', () => {
    const exact = leaf + '\n'.repeat(64 * 1024 - Buffer.byteLength(leaf));
    expect(Buffer.byteLength(exact)).toBe(64 * 1024);
    expect(parsePemBlocks(exact, 'f')).toHaveLength(1);
    expect(parseCertificateFile(exact, 'f')).toHaveLength(1);
    expect(() => parsePemBlocks(exact + '\n', 'f')).toThrow('f is larger than 64 KiB');
    // 40000 two-byte characters are 40000 characters but 80000 bytes.
    expect(() => parsePemBlocks(leaf + 'é'.repeat(40_000), 'f')).toThrow(/larger than 64 KiB/);
  });

  it('says a file of only whitespace is empty, in a certificate file too', () => {
    expect(() => parseCertificateFile('\n \t\n', 'f')).toThrow('f is empty');
    expect(() => parsePemBlocks('\n \t\n', 'f')).toThrow('f is empty');
  });
});
