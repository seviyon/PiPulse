import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_DIR,
  RUNTIME_FILE,
  parseRuntimeStatus,
  printable,
  readRuntimeStatus,
  readText,
  type RuntimeStatus
} from '../../src/ca/runtime-status.js';
import { tempDir } from '../helpers.js';

// Tests that pin the behaviour mutation testing showed was unchecked.

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(':');
type Doc = Record<string, unknown> & { certificate: Record<string, unknown> };
const good = (): Doc => ({
  version: 1,
  transport: 'https',
  certificate: {
    source: 'generated',
    fingerprint: FP,
    class: 'valid',
    notAfter: 5,
    reload: { state: 'ok', lastAttempt: null, lastError: null }
  },
  pid: 4242,
  startTime: '123456',
  bootId: 'boot-a',
  writtenAt: 1
});
const reload = (doc: Doc) => doc.certificate['reload'] as Record<string, unknown>;
const text = (doc: unknown) => JSON.stringify(doc);

describe('the runtime folder and file names', () => {
  it('are the ones the unit and the docs name', () => {
    expect(DEFAULT_RUNTIME_DIR).toBe('/run/pipulse');
    expect(RUNTIME_FILE).toBe('tls-status.json');
  });
});

describe('readText, the descriptor-level reader', () => {
  const file = () => join(dir, 'tls-status.json');
  const write = (mode: number) => {
    writeFileSync(file(), 'hello', { mode });
    chmodSync(file(), mode);
  };

  it('reads a normal file, with or without an owner to match', () => {
    write(0o640);
    expect(readText(file())).toBe('hello');
    expect(readText(file(), process.getuid!())).toBe('hello');
  });

  it('refuses what is not a regular file, and says so', () => {
    execFileSync('mkfifo', [file()]);
    expect(() => readText(file())).toThrow(`${file()} is not a regular file`);
  });

  it('refuses a file anyone can write, and says so', () => {
    write(0o646);
    expect(() => readText(file())).toThrow(`${file()} is writable by everyone`);
  });

  it("refuses a file that is not the service's, and names the owner", () => {
    write(0o640);
    const other = process.getuid!() + 1;
    expect(() => readText(file(), other)).toThrow(
      `${file()} is owned by uid ${process.getuid!()}, not the service`
    );
  });

  it('closes the descriptor on every path', () => {
    const open = () => readdirSync('/dev/fd').length;
    write(0o640);
    const before = open();
    for (let i = 0; i < 40; i++) readText(file());
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, 'x', { mode: 0o646 });
    chmodSync(bad, 0o646);
    for (let i = 0; i < 40; i++) expect(() => readText(bad)).toThrow();
    expect(open()).toBeLessThanOrEqual(before + 2);
  });
});

describe('readRuntimeStatus checks the path before it reads', () => {
  const file = () => join(dir, RUNTIME_FILE);
  const content = text(good());
  const read = { read: () => content, identity: () => ({ startTime: '123456', bootId: 'boot-a' }) };
  const base = { ...read, bootId: () => 'boot-a' };

  it('refuses a folder in the file’s place even when something would read it', () => {
    mkdirSync(file());
    expect(readRuntimeStatus(dir, base)).toEqual({
      state: 'status-file-corrupt',
      problem: `${file()} is not a regular file`
    });
  });

  it('refuses a world-writable file even when something would read it', () => {
    writeFileSync(file(), content, { mode: 0o646 });
    chmodSync(file(), 0o646);
    expect(readRuntimeStatus(dir, base)).toEqual({
      state: 'status-file-corrupt',
      problem: `${file()} is writable by everyone`
    });
  });

  it("refuses a file that is not the service's, and accepts one that is", () => {
    writeFileSync(file(), content, { mode: 0o640 });
    const me = process.getuid!();
    expect(readRuntimeStatus(dir, { ...base, expectUid: me + 1 })).toEqual({
      state: 'status-file-corrupt',
      problem: `${file()} is owned by uid ${me}, not the service`
    });
    expect(readRuntimeStatus(dir, { ...base, expectUid: me }).state).toBe('running');
    expect(readRuntimeStatus(dir, base).state).toBe('running');
  });
});

describe('parseRuntimeStatus', () => {
  const rejects = (doc: unknown) =>
    expect(() => parseRuntimeStatus(text(doc))).toThrow('unexpected content');

  it('rejects anything that is not an object, with its own message (not a TypeError)', () => {
    for (const raw of ['null', '[]', '"x"', '7', 'true']) {
      expect(() => parseRuntimeStatus(raw)).toThrow('unexpected content');
    }
  });

  it('rejects each bad top-level field with its own message', () => {
    const edits: Array<[string, (d: Doc) => void]> = [
      ['version', (d) => (d['version'] = 2)],
      ['transport', (d) => (d['transport'] = 'ftp')],
      ['pid as text', (d) => (d['pid'] = '4242')],
      ['pid fractional', (d) => (d['pid'] = 1.5)],
      ['pid zero', (d) => (d['pid'] = 0)],
      ['pid negative', (d) => (d['pid'] = -1)],
      ['startTime number', (d) => (d['startTime'] = 7)],
      ['startTime empty', (d) => (d['startTime'] = '')],
      ['startTime spaces', (d) => (d['startTime'] = 'a b')],
      ['startTime too long', (d) => (d['startTime'] = 'a'.repeat(129))],
      ['bootId number', (d) => (d['bootId'] = 7)],
      ['bootId empty', (d) => (d['bootId'] = '')],
      ['bootId newline', (d) => (d['bootId'] = 'a\nb')],
      ['bootId too long', (d) => (d['bootId'] = 'a'.repeat(129))],
      ['writtenAt text', (d) => (d['writtenAt'] = 'now')],
      ['writtenAt fractional', (d) => (d['writtenAt'] = 1.5)],
      ['writtenAt beyond Date', (d) => (d['writtenAt'] = 8.64e15 + 2)]
    ];
    for (const [, edit] of edits) {
      const doc = good();
      edit(doc);
      rejects(doc);
    }
  });

  it('rejects each bad certificate field with its own message', () => {
    const edits: Array<[string, (d: Doc) => void]> = [
      ['source', (d) => (d.certificate['source'] = 'other')],
      ['fingerprint number', (d) => (d.certificate['fingerprint'] = 5)],
      ['fingerprint short', (d) => (d.certificate['fingerprint'] = 'AB')],
      // RegExp.test turns a one-element array into its text, so only the type check refuses it.
      ['fingerprint as an array', (d) => (d.certificate['fingerprint'] = [FP])],
      ['class', (d) => (d.certificate['class'] = 'fine')],
      ['notAfter text', (d) => (d.certificate['notAfter'] = 'soon')],
      ['reload null', (d) => (d.certificate['reload'] = null)],
      ['reload text', (d) => (d.certificate['reload'] = 'ok')],
      ['reload state', (d) => (reload(d)['state'] = 'maybe')],
      ['lastAttempt text', (d) => (reload(d)['lastAttempt'] = 'x')],
      ['lastError number', (d) => (reload(d)['lastError'] = 5)],
      ['lastError object', (d) => (reload(d)['lastError'] = { a: 1 })]
    ];
    for (const [, edit] of edits) {
      const doc = good();
      edit(doc);
      rejects(doc);
    }
    for (const certificate of ['x', 5, true, []]) rejects({ ...good(), certificate });
  });

  it('accepts a certificate of every class, from either source, and keeps what it validated', () => {
    for (const klass of [
      'valid',
      'degraded-incomplete-chain',
      'degraded-san',
      'degraded-untrusted',
      'degraded-purpose'
    ]) {
      for (const source of ['operator', 'generated']) {
        const doc = good();
        doc.certificate['class'] = klass;
        doc.certificate['source'] = source;
        reload(doc)['state'] = 'failing';
        reload(doc)['lastAttempt'] = 99;
        reload(doc)['lastError'] = 'boom';
        expect(parseRuntimeStatus(text(doc)).certificate).toEqual({
          source,
          fingerprint: FP,
          class: klass,
          notAfter: 5,
          reload: { state: 'failing', lastAttempt: 99, lastError: 'boom' }
        });
      }
    }
  });

  it('accepts plain HTTP with no certificate, and returns a copy without unknown fields', () => {
    const doc = { ...good(), transport: 'http', certificate: null, extra: 'x' };
    expect(parseRuntimeStatus(text(doc))).toEqual({
      version: 1,
      transport: 'http',
      certificate: null,
      pid: 4242,
      startTime: '123456',
      bootId: 'boot-a',
      writtenAt: 1
    } satisfies RuntimeStatus);
  });
});

describe('printable', () => {
  it('leaves text up to the limit alone and cuts longer text with an ellipsis', () => {
    expect(printable('a'.repeat(200))).toBe('a'.repeat(200));
    expect(printable('a'.repeat(201))).toBe(`${'a'.repeat(200)}…`);
    expect(printable('a'.repeat(500))).toBe(`${'a'.repeat(200)}…`);
  });

  it('replaces control characters before it measures', () => {
    expect(printable('a\nb\u001b[2Jc')).toBe('a?b?[2Jc');
  });
});

describe('the default boot and process checks read /proc', () => {
  const stat = (pid: number, startTime: string) =>
    `${pid} (node) S ${Array(18).fill('0').join(' ')} ${startTime} 0`;
  /** A fake /proc: `served` pids have a stat line, the boot id is `boot`. */
  const proc =
    (served: Record<number, string>, boot = 'boot-a') =>
    (path: string): string => {
      if (path === '/proc/sys/kernel/random/boot_id') return `${boot}\n`;
      const match = /^\/proc\/(\d+)\/stat$/.exec(path);
      const startTime = match ? served[Number(match[1])] : undefined;
      if (startTime === undefined) throw new Error('ENOENT');
      return stat(Number(match![1]), startTime);
    };
  const put = (doc: unknown) => writeFileSync(join(dir, RUNTIME_FILE), text(doc), { mode: 0o640 });

  it('says running when the pid and boot match', () => {
    put(good());
    const procRead = proc({ [process.pid]: '1', 4242: '123456' });
    expect(readRuntimeStatus(dir, { procRead }).state).toBe('running');
  });

  it('says stale after a reboot', () => {
    put(good());
    const procRead = proc({ [process.pid]: '1', 4242: '123456' }, 'boot-b');
    expect(readRuntimeStatus(dir, { procRead })).toEqual({
      state: 'not-running',
      reason: 'stale-boot'
    });
  });

  it('says the pid is gone, or was reused', () => {
    put(good());
    expect(readRuntimeStatus(dir, { procRead: proc({ [process.pid]: '1' }) })).toEqual({
      state: 'not-running',
      reason: 'stale-pid'
    });
    expect(readRuntimeStatus(dir, { procRead: proc({ [process.pid]: '1', 4242: '999' }) })).toEqual(
      { state: 'not-running', reason: 'pid-reused' }
    );
  });

  it('cannot judge the boot where it cannot read its own /proc entry, and goes on to the pid', () => {
    put({ ...good(), bootId: 'something-else' });
    // Only the server's pid is served, so this process has no identity (a non-Linux machine).
    const procRead = proc({ 4242: '123456' });
    expect(readRuntimeStatus(dir, { procRead }).state).toBe('running');
  });
});
