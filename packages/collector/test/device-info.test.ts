import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostOverrides } from '../src/index.js';

describe('hostOverrides', () => {
  it("reads the host's OS name and Pi model under the host root", () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-host-'));
    mkdirSync(join(root, 'etc'));
    writeFileSync(
      join(root, 'etc/os-release'),
      'NAME="Debian GNU/Linux"\nPRETTY_NAME="Raspbian GNU/Linux 12 (bookworm)"\n'
    );
    // /proc/device-tree/model ends with a NUL byte.
    writeFileSync(join(root, 'model'), 'Raspberry Pi 5 Model B Rev 1.0\0');
    expect(hostOverrides(root)).toEqual({
      os: 'Raspbian GNU/Linux 12 (bookworm)',
      model: 'Raspberry Pi 5 Model B Rev 1.0'
    });
  });

  it('leaves out what is missing', () => {
    expect(hostOverrides(mkdtempSync(join(tmpdir(), 'pp-host-')))).toEqual({});
  });

  it('reads only the start of a file: a huge or hostile file under the host root costs 4 KB', () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-host-'));
    mkdirSync(join(root, 'etc'));
    // The name is on the first line; a megabyte of junk follows, and a second PRETTY_NAME beyond the limit.
    writeFileSync(
      join(root, 'etc/os-release'),
      `PRETTY_NAME="Raspbian"\n${'#'.repeat(1 << 20)}\nPRETTY_NAME="after the limit"\n`
    );
    writeFileSync(join(root, 'model'), `Pi 5${'\0'.repeat(1 << 20)}`);
    expect(hostOverrides(root)).toEqual({ os: 'Raspbian', model: 'Pi 5' });
  });

  it('does not follow a folder or an endless file where a regular file should be', () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-host-'));
    mkdirSync(join(root, 'etc/os-release'), { recursive: true }); // a folder
    mkdirSync(join(root, 'model')); // another
    expect(hostOverrides(root)).toEqual({});
  });
});
