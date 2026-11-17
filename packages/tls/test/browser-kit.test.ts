import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_PURPOSE_LIMITS, caExtensions } from '../src/ca/issue.js';
import {
  KIT_MODES,
  KIT_SCOPE,
  KIT_USAGE,
  buildKitCa,
  kitLimits,
  parseKitArgs,
  runKit
} from './browser-kit-lib.js';
import { tempDir } from './helpers.js';
import { TEST_OPENSSL } from './openssl.js';

let dir: string;
beforeAll(() => {
  dir = tempDir();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const lines = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe('the kit refuses to run without a valid mode', () => {
  it('refuses to run without a mode', async () => {
    const target = join(dir, 'no-mode');
    const log = lines();
    expect(await runKit([target, '10.0.0.5'], log.io)).toBe(2);
    expect(log.err).toEqual([KIT_USAGE]);
    expect(existsSync(target)).toBe(false);
  });

  it.each(['pr-3', 'PR3', 'pr3=all', 'pr3=eku,email', ''])('refuses the mode %j', async (mode) => {
    const target = join(dir, `bad-${mode.length}-${mode.replace(/\W/g, '_')}`);
    const log = lines();
    expect(await runKit([target, '10.0.0.5', mode], log.io)).toBe(2);
    expect(log.err).toEqual([KIT_USAGE]);
    expect(log.out).toEqual([]);
    expect(existsSync(target)).toBe(false);
  });

  it('refuses extra arguments', async () => {
    const target = join(dir, 'extra');
    const log = lines();
    expect(await runKit([target, '10.0.0.5', 'pr3', 'more'], log.io)).toBe(2);
    expect(log.err).toEqual([KIT_USAGE]);
    expect(existsSync(target)).toBe(false);
  });

  it.each(['not-an-ip', '::1', 'fe80::1', '10.0.0.256', '10.0.0'])(
    'refuses the address %j (IPv4 only), before writing anything',
    async (address) => {
      const target = join(dir, `bad-ip-${address.replace(/\W/g, '_')}`);
      const log = lines();
      expect(await runKit([target, address, 'pr3'], log.io)).toBe(2);
      expect(log.err).toEqual([KIT_USAGE]);
      expect(existsSync(target)).toBe(false);
    }
  );

  it('keeps ca.key at 0600 when a re-run finds a wider file', async () => {
    const target = join(dir, 'rerun');
    mkdirSync(target);
    writeFileSync(join(target, 'ca.key'), 'old', { mode: 0o644 });
    expect(await runKit([target, '10.0.0.5', 'base'], lines().io)).toBe(0);
    expect(statSync(join(target, 'ca.key')).mode & 0o777).toBe(0o600);
  });

  it('refuses a missing folder or address', async () => {
    const log = lines();
    expect(await runKit([], log.io)).toBe(2);
    expect(await runKit(['', '10.0.0.5', 'pr3'], log.io)).toBe(2);
    expect(await runKit([join(dir, 'no-ip'), '', 'pr3'], log.io)).toBe(2);
    expect(existsSync(join(dir, 'no-ip'))).toBe(false);
  });

  it('accepts exactly the five modes', () => {
    expect(KIT_MODES).toEqual(['base', 'pr3', 'pr3=eku', 'pr3=email', 'pr3=uri']);
    for (const mode of KIT_MODES) {
      expect(parseKitArgs(['/o', '10.0.0.5', mode])).toEqual({
        out: '/o',
        lanIp: '10.0.0.5',
        mode
      });
    }
  });
});

describe('each mode changes exactly what it names', () => {
  it.each(KIT_MODES)('%s', async (mode) => {
    const ca = await buildKitCa({ workDir: dir, mode, now: Date.now() });
    const text = execFileSync(TEST_OPENSSL, ['x509', '-noout', '-text'], {
      input: ca.certPem
    }).toString();
    const has = (pattern: RegExp) => pattern.test(text);
    expect(has(/Extended Key Usage:/)).toBe(mode === 'pr3' || mode === 'pr3=eku');
    expect(has(/email:\.invalid/)).toBe(mode === 'pr3' || mode === 'pr3=email');
    expect(has(/URI:\.invalid/)).toBe(mode === 'pr3' || mode === 'pr3=uri');
    // the same scope in every mode
    for (const name of KIT_SCOPE.dns) expect(text).toContain(`DNS:${name}`);
    expect(text).toMatch(
      /Excluded:\s*\n\s*DNS:\.pipulse-check\s*\n\s*DNS:\.localhost\s*\n\s*DNS:\.io/
    );
  });

  it("base is today's CA", () => {
    expect(kitLimits('base')).toEqual(NO_PURPOSE_LIMITS);
    const base = caExtensions(KIT_SCOPE, true, kitLimits('base'));
    expect(base).toEqual(caExtensions(KIT_SCOPE, true, NO_PURPOSE_LIMITS));
    expect(base.join('\n')).not.toContain('extendedKeyUsage');
    expect(base.join('\n')).not.toContain('.invalid');
  });

  it('the isolated modes are base plus one line, never all but one', () => {
    expect(kitLimits('pr3=eku')).toEqual({ eku: true, email: false, uri: false });
    expect(kitLimits('pr3=email')).toEqual({ eku: false, email: true, uri: false });
    expect(kitLimits('pr3=uri')).toEqual({ eku: false, email: false, uri: true });
    expect(kitLimits('pr3')).toEqual({ eku: true, email: true, uri: true });
  });
});

describe('a full run', () => {
  it('writes the kit', async () => {
    const target = join(dir, 'full');
    const log = lines();
    expect(await runKit([target, '10.0.0.5', 'pr3'], log.io)).toBe(0);
    expect(log.out[0]).toBe('mode pr3');
    expect(log.out[1]).toMatch(/^CA SHA-256 /);
    expect(log.out[2]).toBe(`wrote ${target}`);
    for (const file of ['ca.crt', 'ca.key', 'serve.mjs'])
      expect(existsSync(join(target, file))).toBe(true);
    for (let port = 8441; port <= 8447; port++)
      expect(existsSync(join(target, `${port}.pem`))).toBe(true);
    expect(statSync(join(target, 'ca.key')).mode & 0o777).toBe(0o600);
  });
});
