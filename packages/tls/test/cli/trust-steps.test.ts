import { describe, expect, it } from 'vitest';
import { TRUST_STEPS } from '../../src/cli/cmd-export.js';

describe('the steps for trusting the CA on a device', () => {
  const text = TRUST_STEPS.join('\n');

  it('trust it for web use only on macOS, where the command allows a policy', () => {
    const line = TRUST_STEPS.find((l) => l.includes('security add-trusted-cert'))!;
    expect(line).toContain(' -p ssl ');
    expect(line).toContain('-r trustRoot');
  });

  it('says where the system trusts it for every purpose, and to prefer a web-only choice', () => {
    expect(text).toContain('Windows and Debian/Ubuntu trust a CA for every purpose');
    expect(text).toContain('TLS (web) use only');
  });

  it('still ends with the fingerprint check', () => {
    expect(TRUST_STEPS.at(-1)).toContain('-fingerprint -sha256');
  });
});
