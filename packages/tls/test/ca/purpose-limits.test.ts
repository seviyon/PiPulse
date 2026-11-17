import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NO_PURPOSE_LIMITS,
  issueCa,
  type IssueScope,
  type PurposeLimits
} from '../../src/ca/issue.js';
import { tempDir } from '../helpers.js';
import { TEST_OPENSSL } from '../openssl.js';
import { signTestLeaf, verifyAgainst } from './purpose-leaf.js';

// Real `openssl verify` against real CAs from issueCa: the limits are enforced, not just written.
const NOW = Date.now();
const SCOPE: IssueScope = {
  dns: ['pipulse-check', 'pipulse-check.local', 'localhost'],
  excludedDns: ['.pipulse-check', '.localhost'],
  ip: [
    { address: '127.0.0.1', prefix: 32 },
    { address: '::1', prefix: 128 },
    { address: '192.168.77.0', prefix: 24 }
  ]
};
const PURPOSE = /error 26 at 1 depth lookup:\s*unsuitable certificate purpose/;
const LEAF_PURPOSE = /error 26 at 0 depth lookup:\s*unsuitable certificate purpose/;
const PERMITTED = /error 47 at 0 depth lookup:\s*permitted subtree violation/;
const EXCLUDED = /error 48 at 0 depth lookup:\s*excluded subtree violation/;
const FOUR = 'serverAuth, clientAuth, codeSigning, emailProtection';

let work: string;
type Made = { keyPath: string; certPath: string };
const cas: Record<string, Made> = {};
async function makeCa(name: string, limits?: PurposeLimits): Promise<void> {
  const dir = join(work, name);
  const made = await issueCa({
    openssl: TEST_OPENSSL,
    workDir: tempDir(),
    subject: `PiPulse CA ${name}`,
    scope: SCOPE,
    now: NOW,
    ...(limits ? { limits } : {})
  });
  // One folder per CA, so each CA's serial files and leaves stay apart.
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'ca.key');
  const certPath = join(dir, 'ca.crt');
  writeFileSync(keyPath, made.keyPem, { mode: 0o600 });
  writeFileSync(certPath, made.certPem);
  cas[name] = { keyPath, certPath };
}
let n = 0;
const leafFor = (ca: string, san: string, eku?: string) =>
  signTestLeaf({
    dir: join(work, ca),
    ca: cas[ca]!,
    name: `leaf${n++}`,
    san,
    ...(eku === undefined ? {} : { eku })
  });
const check = (ca: string, leaf: string, purpose?: 'sslserver' | 'sslclient' | 'smimesign') =>
  verifyAgainst(cas[ca]!.certPath, leaf, purpose);

beforeAll(async () => {
  work = tempDir();
  await makeCa('limited');
  await makeCa('base', NO_PURPOSE_LIMITS);
  await makeCa('emailOnly', { eku: false, email: true, uri: false });
  await makeCa('uriOnly', { eku: false, email: false, uri: true });
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("the CA's EKU is enforced, not just the leaf's", () => {
  describe.each([
    ['no EKU extension', undefined],
    ['all four purposes', FOUR]
  ])('a leaf with %s', (_label, eku) => {
    it('passes sslserver', () => {
      expect(check('limited', leafFor('limited', 'DNS:pipulse-check', eku), 'sslserver').ok).toBe(
        true
      );
    });
    it.each(['sslclient', 'smimesign'] as const)('fails %s at the CA', (purpose) => {
      const r = check('limited', leafFor('limited', 'DNS:pipulse-check', eku), purpose);
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(PURPOSE);
      expect(r.output).not.toMatch(/unable to get (local )?issuer/);
    });
    it('a base CA passes all three (control: the CA is what blocks)', () => {
      const leaf = leafFor('base', 'DNS:pipulse-check', eku);
      for (const purpose of ['sslserver', 'sslclient', 'smimesign'] as const) {
        expect(check('base', leaf, purpose).ok).toBe(true);
      }
    });
  });

  it('a clientAuth-only leaf fails sslserver at the leaf', () => {
    const r = check('limited', leafFor('limited', 'DNS:pipulse-check', 'clientAuth'), 'sslserver');
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(LEAF_PURPOSE);
  });
});

describe('email names are confined to .invalid', () => {
  it('a permitted email verifies', () => {
    expect(check('limited', leafFor('limited', 'DNS:pipulse-check, email:x@host.invalid')).ok).toBe(
      true
    );
  });
  it('a prohibited email fails with a permitted-subtree violation', () => {
    const r = check('limited', leafFor('limited', 'DNS:pipulse-check, email:x@example.com'));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(PERMITTED);
  });
  it('the same prohibited email verifies against a CA without limits (control)', () => {
    expect(check('base', leafFor('base', 'DNS:pipulse-check, email:x@example.com')).ok).toBe(true);
  });
});

describe('URI names are confined to .invalid', () => {
  it('a permitted URI verifies', () => {
    expect(
      check('limited', leafFor('limited', 'DNS:pipulse-check, URI:https://host.invalid/')).ok
    ).toBe(true);
  });
  it('a prohibited URI fails with a permitted-subtree violation', () => {
    const r = check('limited', leafFor('limited', 'DNS:pipulse-check, URI:https://example.com/'));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(PERMITTED);
  });
  it('the same prohibited URI verifies against a CA without limits (control)', () => {
    expect(check('base', leafFor('base', 'DNS:pipulse-check, URI:https://example.com/')).ok).toBe(
      true
    );
  });
});

describe('the email and URI limits are independent', () => {
  const email = (ca: string) => leafFor(ca, 'DNS:pipulse-check, email:x@example.com');
  const uri = (ca: string) => leafFor(ca, 'DNS:pipulse-check, URI:https://example.com/');
  const okEmail = (ca: string) => leafFor(ca, 'DNS:pipulse-check, email:x@host.invalid');
  const okUri = (ca: string) => leafFor(ca, 'DNS:pipulse-check, URI:https://host.invalid/');

  it('a CA with only the email limit rejects the email and accepts the URI', () => {
    const r = check('emailOnly', email('emailOnly'));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(PERMITTED);
    expect(check('emailOnly', uri('emailOnly')).ok).toBe(true);
    expect(check('emailOnly', okEmail('emailOnly')).ok).toBe(true);
    expect(check('emailOnly', okUri('emailOnly')).ok).toBe(true);
  });
  it('a CA with only the URI limit rejects the URI and accepts the email', () => {
    const r = check('uriOnly', uri('uriOnly'));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(PERMITTED);
    expect(check('uriOnly', email('uriOnly')).ok).toBe(true);
    expect(check('uriOnly', okEmail('uriOnly')).ok).toBe(true);
    expect(check('uriOnly', okUri('uriOnly')).ok).toBe(true);
  });
  it.each(['emailOnly', 'uriOnly'])('%s has no EKU, so every purpose still verifies', (ca) => {
    const leaf = leafFor(ca, 'DNS:pipulse-check');
    for (const purpose of ['sslserver', 'sslclient', 'smimesign'] as const) {
      expect(check(ca, leaf, purpose).ok).toBe(true);
    }
  });
});

describe('DNS and IP limits are unchanged', () => {
  describe.each(['limited', 'base'])('against the %s CA', (ca) => {
    it('permitted names verify', () => {
      expect(check(ca, leafFor(ca, 'DNS:pipulse-check.local, DNS:pipulse-check')).ok).toBe(true);
      expect(check(ca, leafFor(ca, 'DNS:pipulse-check, IP:192.168.77.5')).ok).toBe(true);
    });
    it.each(['DNS:other-check.lan', 'IP:10.0.0.1'])('%s breaks the permitted subtree', (san) => {
      const r = check(ca, leafFor(ca, `DNS:pipulse-check, ${san}`));
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(PERMITTED);
    });
    it('a name below the host breaks the excluded subtree', () => {
      const r = check(ca, leafFor(ca, 'DNS:pipulse-check, DNS:x.pipulse-check'));
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(EXCLUDED);
    });
  });
});
