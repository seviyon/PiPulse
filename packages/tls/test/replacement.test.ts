import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectMaterial, type LoadedCertificate } from '../src/inspect.js';
import { checkReplacement } from '../src/replacement.js';
import { fixture, tempDir } from './helpers.js';

const load = (crt: string, key: string): LoadedCertificate =>
  inspectMaterial({
    source: 'operator',
    keyPem: fixture(key),
    certPems: [fixture(crt), fixture('intermediate.crt')],
    trust: { anchors: [fixture('root-ca.crt')], system: false },
    names: []
  });
const VALID = load('leaf.crt', 'leaf.key');
const EXPIRED = load('expired.crt', 'expired.key');

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const options = (over: Partial<Parameters<typeof checkReplacement>[2]> = {}) => {
  dir = tempDir();
  return {
    requireValid: false,
    now: Date.now(),
    timesyncDir: join(dir, 'none'),
    clockTrust: false,
    ...over
  };
};

describe('checkReplacement', () => {
  it('names leaf.pem when a generated replacement is refused', () => {
    expect(() =>
      checkReplacement(
        { ...EXPIRED, source: 'generated' },
        { ...VALID, source: 'generated' },
        options()
      )
    ).toThrow(/^leaf\.pem: the replacement certificate is expired/);
  });

  it('refuses an expired candidate over a valid active one, even when not strict', () => {
    expect(() => checkReplacement(EXPIRED, VALID, options())).toThrow(
      /replacement certificate is expired/
    );
  });

  it('lets an expired candidate replace an expired active one when not strict', () => {
    expect(() => checkReplacement(EXPIRED, EXPIRED, options())).not.toThrow();
  });

  it('with requireValid refuses an expired candidate whatever is active', () => {
    expect(() => checkReplacement(EXPIRED, EXPIRED, options({ requireValid: true }))).toThrow(
      /^PIPULSE_TLS_REQUIRE_VALID_CERT: the replacement certificate is expired/
    );
  });

  describe('not yet valid', () => {
    const future = { ...VALID, notBefore: Date.now() + 86_400_000, notAfter: Date.now() + 9e9 };
    it('with requireValid is refused while the clock is synced', () => {
      const o = options({ requireValid: true });
      mkdirSync(o.timesyncDir);
      writeFileSync(join(o.timesyncDir, 'synchronized'), '');
      expect(() => checkReplacement(future, VALID, o)).toThrow(/not yet valid/);
    });

    it('with requireValid is accepted while the clock is not synced', () => {
      const o = options({ requireValid: true });
      mkdirSync(o.timesyncDir);
      expect(() => checkReplacement(future, VALID, o)).not.toThrow();
    });

    it('without requireValid is accepted', () => {
      expect(() => checkReplacement(future, VALID, options())).not.toThrow();
    });
  });

  it('accepts a valid candidate', () => {
    expect(() => checkReplacement(VALID, VALID, options({ requireValid: true }))).not.toThrow();
  });
});
