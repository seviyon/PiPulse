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

  describe('PRETTY_NAME as os-release writes it', () => {
    const osFor = (line: string) => {
      const root = mkdtempSync(join(tmpdir(), 'pp-host-'));
      mkdirSync(join(root, 'etc'));
      writeFileSync(join(root, 'etc/os-release'), `NAME=x\n${line}\nID=x\n`);
      return hostOverrides(root).os;
    };

    it.each([
      [
        'double-quoted',
        'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"',
        'Debian GNU/Linux 12 (bookworm)'
      ],
      ['single-quoted', "PRETTY_NAME='Debian GNU/Linux 12'", 'Debian GNU/Linux 12'],
      ['single-quoted with a double quote inside', `PRETTY_NAME='The "Pi" OS'`, 'The "Pi" OS'],
      [
        'single-quoted, backslashes kept as they are',
        String.raw`PRETTY_NAME='a\nb\"c'`,
        String.raw`a\nb\"c`
      ],
      ['with an escaped double quote', String.raw`PRETTY_NAME="The \"Pi\" OS"`, 'The "Pi" OS'],
      [
        'with escaped backslash, dollar and backtick',
        String.raw`PRETTY_NAME="a\\b\$c\`d"`,
        'a\\b$c`d'
      ],
      [
        'with another backslash kept as it is (as the shell does)',
        String.raw`PRETTY_NAME="a\qb"`,
        String.raw`a\qb`
      ],
      ['unquoted', 'PRETTY_NAME=Raspbian', 'Raspbian'],
      ['unquoted with spaces (older files)', 'PRETTY_NAME=Debian 12', 'Debian 12'],
      ['unquoted with an escaped space', String.raw`PRETTY_NAME=Debian\ 12`, 'Debian 12'],
      ['unquoted, a # inside the word is part of it', 'PRETTY_NAME=Pi#4', 'Pi#4'],
      ['unquoted, followed by a comment after two spaces', 'PRETTY_NAME=Raspbian  # x', 'Raspbian'],
      [
        'unquoted, followed by a long comment',
        'PRETTY_NAME=Raspbian # a longer comment',
        'Raspbian'
      ],
      ['unquoted, with blanks after it', 'PRETTY_NAME=Raspbian   ', 'Raspbian'],
      ['followed by a comment', 'PRETTY_NAME="Debian 12" # the name', 'Debian 12'],
      ['single-quoted, followed by a comment', "PRETTY_NAME='Debian 12'  # x", 'Debian 12']
    ])('reads a name that is %s', (_, line, expected) => {
      expect(osFor(line)).toBe(expected);
    });

    it.each([
      ['an unterminated double quote', 'PRETTY_NAME="Debian 12'],
      ['an unterminated single quote', "PRETTY_NAME='Debian 12"],
      ['text after the closing quote', 'PRETTY_NAME="a"b'],
      ['text after a single-quoted value', "PRETTY_NAME='a'b"],
      ['an empty value', "PRETTY_NAME=''"]
    ])('leaves the OS out for %s', (_, line) => {
      expect(osFor(line)).toBeUndefined();
    });
  });
});
