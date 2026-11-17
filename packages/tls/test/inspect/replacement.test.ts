import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CertificateRefused,
  inspectMaterial,
  type LoadedCertificate
} from '../../src/inspect/inspect.js';
import { checkReplacement } from '../../src/inspect/replacement.js';
import { fixture, tempDir } from '../helpers.js';

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

    // The clock states: `synced` (timesyncd's marker exists), `unsynced` (timesyncd runs, no
    // marker: the clock may be behind), `unknown` (no timesyncd at all: chrony, ntpd, Docker).
    const synced = (o: ReturnType<typeof options>) => {
      mkdirSync(o.timesyncDir);
      writeFileSync(join(o.timesyncDir, 'synchronized'), '');
    };
    const unsynced = (o: ReturnType<typeof options>) => mkdirSync(o.timesyncDir);

    it('with requireValid is accepted while timesyncd says the clock is not synced', () => {
      const o = options({ requireValid: true });
      unsynced(o);
      expect(() => checkReplacement(future, VALID, o)).not.toThrow();
    });

    it('with requireValid is refused while the clock is unknown, like a synced one', () => {
      const o = options({ requireValid: true });
      expect(() => checkReplacement(future, VALID, o)).toThrow(/not yet valid/);
    });

    it('without requireValid is accepted while timesyncd says the clock is not synced', () => {
      const o = options();
      unsynced(o);
      expect(() => checkReplacement(future, VALID, o)).not.toThrow();
    });

    it('without requireValid never replaces a valid certificate while the clock is unknown', () => {
      // No timesyncd (chrony, ntpd, Docker): "unknown" is no evidence the clock is behind.
      expect(() => checkReplacement(future, VALID, options())).toThrow(
        /^PIPULSE_TLS_CERT\/PIPULSE_TLS_KEY: the replacement certificate is not valid yet and the active one is/
      );
    });

    it('keeps the active certificate on an unknown clock trusted as synced', () => {
      expect(() => checkReplacement(future, VALID, options({ clockTrust: true }))).toThrow(
        /not valid yet/
      );
    });

    it('lets a replacement that is not valid yet replace an unusable active certificate on an unknown clock', () => {
      expect(() => checkReplacement(future, EXPIRED, options())).not.toThrow();
    });

    it('never replaces a currently valid certificate while the clock is synced', () => {
      const o = options();
      synced(o);
      expect(() => checkReplacement(future, VALID, o)).toThrow(
        /^PIPULSE_TLS_CERT\/PIPULSE_TLS_KEY: the replacement certificate is not valid yet and the active one is/
      );
    });

    it('may replace an active certificate that is itself not usable', () => {
      const o = options();
      mkdirSync(o.timesyncDir);
      writeFileSync(join(o.timesyncDir, 'synchronized'), '');
      expect(() => checkReplacement(future, EXPIRED, o)).not.toThrow();
    });
  });

  it('accepts a valid candidate', () => {
    expect(() => checkReplacement(VALID, VALID, options({ requireValid: true }))).not.toThrow();
  });

  describe('every refusal already names its setting', () => {
    // CertificateRefused.named tells the caller not to prefix the message again.
    const refusal = (run: () => void): CertificateRefused => {
      try {
        run();
      } catch (error) {
        if (error instanceof CertificateRefused) return error;
        throw error;
      }
      throw new Error('expected a refusal');
    };
    const future = { ...VALID, notBefore: Date.now() + 86_400_000, notAfter: Date.now() + 9e9 };

    it.each([
      [
        'an expired candidate over a valid certificate',
        () => checkReplacement(EXPIRED, VALID, options())
      ],
      [
        'a not-yet-valid candidate over a valid certificate',
        () => checkReplacement(future, VALID, options())
      ],
      [
        'an expired candidate with requireValid',
        () => checkReplacement(EXPIRED, EXPIRED, options({ requireValid: true }))
      ],
      [
        'a not-yet-valid candidate with requireValid',
        () => checkReplacement(future, VALID, options({ requireValid: true }))
      ]
    ])('%s', (_name, run) => {
      expect(refusal(run).named).toBe(true);
    });
  });
});
