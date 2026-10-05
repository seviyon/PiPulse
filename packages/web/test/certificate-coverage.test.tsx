import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { CertificateSection, REFRESH_MS, warningExpected } from '../src/certificate.js';
import { compactIp, formatDateYear } from '../src/format.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2027, 0, 1);
const generated = (extra: object = {}) => ({
  mode: 'https',
  source: 'generated',
  validity: 'valid',
  notBefore: NOW - DAY,
  notAfter: NOW + 89 * DAY,
  fingerprint: 'AB:CD',
  caFingerprint: 'CA:FE',
  sans: { dns: ['io', 'io.local', 'localhost'], ip: ['127.0.0.1', '0:0:0:0:0:0:0:1'] },
  class: 'valid',
  reasons: [],
  missingNames: [],
  certificateAgeMs: DAY,
  clock: 'synced',
  clockSynced: true,
  reload: { state: 'ok', lastAttempt: null, lastError: null },
  inContainer: false,
  ca: {
    state: 'ok',
    subject: 'PiPulse CA io 0a1b2c',
    createdAt: NOW - DAY,
    notAfter: NOW + 3650 * DAY,
    constraints: { dns: ['io', 'io.local', 'localhost'], excludedDns: [], subnets: [] },
    backups: 0
  },
  metadata: 'ok',
  coverage: { dns: ['io', 'io.local', 'localhost'], ipSubnets: [] },
  renewal: {
    state: 'ok',
    lastAttempt: NOW - 3_600_000,
    result: 'not-due',
    reason: 'valid until 2027-03-31'
  },
  ...extra
});

let root: HTMLElement;
let configs: object[];
let fetches = 0;
beforeEach(() => {
  fetches = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const config = configs[Math.min(fetches, configs.length - 1)];
      fetches++;
      return Response.json({ serverTime: NOW, ...config });
    })
  );
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const session = { editable: false, signedIn: false, protectReads: false };
async function show(...tls: object[]) {
  configs = tls.map((t) => ({ tls: t }));
  await act(async () => render(<CertificateSection session={session} />, root));
  await vi.waitFor(() => expect(root.textContent).not.toContain('Loading'));
}

describe('helpers', () => {
  it('shows the year and compacts IPv6', () => {
    expect(formatDateYear(NOW)).toMatch(/2027/);
    expect(compactIp('0:0:0:0:0:0:0:1')).toBe('::1');
    expect(compactIp('192.168.1.35')).toBe('192.168.1.35');
  });
  it('expects a warning for a host the certificate does not name', () => {
    const sans = { dns: ['io', 'io.local'], ip: ['127.0.0.1', '::1'] };
    expect(warningExpected('io.local', sans)).toBe(false);
    expect(warningExpected('IO', sans)).toBe(false);
    expect(warningExpected('192.168.1.35', sans)).toBe(true);
    expect(warningExpected('[::1]', sans)).toBe(false);
  });
});

describe('CertificateSection (generated)', () => {
  it('shows the CA fingerprint with the out-of-band note, coverage lines and renewal', async () => {
    await show(generated());
    const text = root.textContent!;
    expect(text).toContain('CA SHA-256: CA:FE');
    expect(text).toContain('sudo pipulse tls status');
    expect(text).toContain('DNS access: covered (io, io.local, localhost)');
    expect(text).toContain('IP access: not covered');
    expect(text).toMatch(/Certificate warning expected here: (yes|no)/);
    expect(text).toContain('How to change scope: sudo pipulse tls new-ca --subnet <cidr>');
    expect(text).toContain('::1');
    expect(text).not.toContain('0:0:0:0:0:0:0:1');
    expect(text).toMatch(/Valid until .*2027/);
    expect(text).toMatch(/Renewal: checked .*not due/);
  });

  it('shows a failing renewal and the Docker scope command in a container', async () => {
    await show(
      generated({
        inContainer: true,
        renewal: {
          state: 'failing',
          lastAttempt: NOW,
          result: 'failed',
          reason: 'openssl req failed'
        }
      })
    );
    expect(root.textContent).toContain('Renewal failing: openssl req failed');
    expect(root.textContent).toContain(
      'docker compose run --rm pipulse-tls pipulse tls new-ca --subnet <cidr> --yes'
    );
  });

  it('says so while the CA is being replaced, without showing the new scope', async () => {
    const tls: Record<string, unknown> = generated({
      ca: { state: 'transitional' },
      metadata: 'transitional'
    });
    delete tls['coverage'];
    await show(tls);
    expect(root.textContent).toContain(
      'The CA is being replaced; the served certificate has not switched yet'
    );
    expect(root.textContent).not.toContain('DNS access:');
  });

  it('shows unreadable CA details by file and reason', async () => {
    const tls: Record<string, unknown> = generated({
      ca: { state: 'unavailable' },
      metadata: 'unreadable',
      metadataProblems: [{ file: 'ca-meta.json', message: 'EACCES' }]
    });
    delete tls['coverage'];
    await show(tls);
    expect(root.textContent).toContain('CA details unavailable: ca-meta.json: EACCES');
  });

  it('refreshes by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await show(generated(), generated({ fingerprint: 'EF:01' }));
    expect(root.textContent).toContain('AB:CD');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    await vi.waitFor(() => expect(root.textContent).toContain('EF:01'));
  });

  it('gives the Docker enable steps for legacy-http in a container', async () => {
    await show({ mode: 'http', reason: 'state', stateMode: 'legacy-http', inContainer: true });
    expect(root.textContent).toContain(
      'docker compose run --rm pipulse-tls pipulse tls enable --yes'
    );
  });
});
