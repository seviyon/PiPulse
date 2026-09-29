import { chmodSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSecureFile, statSignature, TlsFileError } from '../src/files.js';
import { fixture, tempDir } from './helpers.js';

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, mode: number, text = fixture('leaf.crt')) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
};

describe('readSecureFile, operator policy', () => {
  it('reads a private key the owner alone can read', () => {
    const path = write('key.pem', 0o600, fixture('leaf.key'));
    expect(readSecureFile(path, { kind: 'operator', secret: true }, 'PIPULSE_TLS_KEY')).toContain(
      'PRIVATE KEY'
    );
  });

  it('refuses a world-readable key with a chmod hint', () => {
    const path = write('key.pem', 0o644, fixture('leaf.key'));
    expect(() =>
      readSecureFile(path, { kind: 'operator', secret: true }, 'PIPULSE_TLS_KEY')
    ).toThrow('PIPULSE_TLS_KEY: readable by every user; chmod o-r it');
  });

  it('lets a certificate be world-readable', () => {
    const path = write('cert.pem', 0o644);
    expect(readSecureFile(path, { kind: 'operator', secret: false }, 'PIPULSE_TLS_CERT')).toContain(
      'CERTIFICATE'
    );
  });

  it('follows symlinks (certbot live/ links)', () => {
    const target = write('fullchain3.pem', 0o644);
    const link = join(dir, 'fullchain.pem');
    symlinkSync(target, link);
    expect(readSecureFile(link, { kind: 'operator', secret: false }, 'PIPULSE_TLS_CERT')).toContain(
      'CERTIFICATE'
    );
  });

  it('refuses a directory and a missing file, naming only the setting', () => {
    mkdirSync(join(dir, 'd'));
    expect(() =>
      readSecureFile(join(dir, 'd'), { kind: 'operator', secret: false }, 'PIPULSE_TLS_CERT')
    ).toThrow('PIPULSE_TLS_CERT: not a regular file');
    expect(() =>
      readSecureFile(join(dir, 'nope'), { kind: 'operator', secret: false }, 'PIPULSE_TLS_CERT')
    ).toThrow('PIPULSE_TLS_CERT: file not found');
  });

  it('refuses a file over 64 KiB', () => {
    const path = write('big.pem', 0o644, 'x'.repeat(65 * 1024));
    expect(() =>
      readSecureFile(path, { kind: 'operator', secret: false }, 'PIPULSE_TLS_CERT')
    ).toThrow('larger than 64 KiB');
  });
});

describe('readSecureFile, generated policy', () => {
  const uid = process.getuid!();
  const gid = process.getgid!();

  it('reads a file with the expected owner and mode', () => {
    const path = write('leaf.pem', 0o640);
    expect(
      readSecureFile(path, { kind: 'generated', maxMode: 0o640, uid, gid }, 'leaf.pem')
    ).toContain('CERTIFICATE');
  });

  it('refuses a symlink', () => {
    const target = write('real.pem', 0o640);
    const link = join(dir, 'leaf.pem');
    symlinkSync(target, link);
    expect(() => readSecureFile(link, { kind: 'generated', maxMode: 0o640 }, 'leaf.pem')).toThrow(
      'leaf.pem: is a symbolic link, which is not allowed here'
    );
  });

  it('refuses broader permissions and another owner', () => {
    const path = write('leaf.pem', 0o644);
    expect(() => readSecureFile(path, { kind: 'generated', maxMode: 0o640 }, 'leaf.pem')).toThrow(
      'leaf.pem: permissions 644 are broader than 640'
    );
    chmodSync(path, 0o640);
    expect(() =>
      readSecureFile(path, { kind: 'generated', maxMode: 0o640, uid: uid + 1 }, 'leaf.pem')
    ).toThrow(`leaf.pem: owned by uid ${uid}, expected ${uid + 1}`);
    expect(() =>
      readSecureFile(path, { kind: 'generated', maxMode: 0o640, gid: gid + 1 }, 'leaf.pem')
    ).toThrow(`leaf.pem: group ${gid}, expected ${gid + 1}`);
  });
});

describe('statSignature', () => {
  it('changes when a file is replaced or retargeted, and reports missing files', () => {
    const a = write('a.pem', 0o644);
    const link = join(dir, 'live.pem');
    symlinkSync(a, link);
    const before = statSignature([link]);
    const b = write('b.pem', 0o644, fixture('leaf2.crt'));
    rmSync(link);
    symlinkSync(b, link);
    expect(statSignature([link])).not.toBe(before);
    utimesSync(b, new Date(0), new Date(0));
    expect(statSignature([join(dir, 'nope'), b])).toMatch(/^missing\|\d+:\d+:0:\d+:\d+:\d+$/);
  });

  it('changes when generated-file permissions or ownership change', () => {
    const path = write('permissions.pem', 0o640);
    const before = statSignature([path]);
    chmodSync(path, 0o600);
    expect(statSignature([path])).not.toBe(before);
  });
});

it('exports TlsFileError', () => {
  expect(new TlsFileError('x')).toBeInstanceOf(Error);
});
