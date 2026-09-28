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
});
