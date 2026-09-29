import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixture } from './helpers.js';

describe('fixtures', () => {
  it('chain as described: leaf ← intermediate ← root', () => {
    const leaf = new X509Certificate(fixture('leaf.crt'));
    const intermediate = new X509Certificate(fixture('intermediate.crt'));
    const root = new X509Certificate(fixture('root-ca.crt'));
    expect(leaf.checkIssued(intermediate)).toBe(true);
    expect(leaf.verify(intermediate.publicKey)).toBe(true);
    expect(intermediate.verify(root.publicKey)).toBe(true);
    expect(leaf.subjectAltName).toBe('DNS:localhost, DNS:pipulse.test, IP Address:127.0.0.1');
    expect(new X509Certificate(fixture('expired.crt')).validToDate.getUTCFullYear()).toBe(2021);
    expect(new X509Certificate(fixture('future.crt')).validFromDate.getUTCFullYear()).toBe(2120);
  });
});
