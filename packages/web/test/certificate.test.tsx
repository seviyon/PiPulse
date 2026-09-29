import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { CertificateSection } from '../src/certificate.js';
import type { Session } from '../src/api.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2027, 0, 1);
const https = {
  mode: 'https',
  source: 'operator',
  validity: 'valid',
  notBefore: NOW - 10 * DAY,
  notAfter: NOW + 80 * DAY,
  fingerprint: 'AB:CD',
  sans: { dns: ['io.lan'], ip: ['192.168.1.20'] },
  class: 'valid',
  reasons: [],
  missingNames: [],
  certificateAgeMs: 10 * DAY,
  clock: 'synced',
  clockSynced: true,
  reload: { state: 'ok', lastAttempt: null, lastError: null }
};

let root: HTMLElement;
let config: object;
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/config' ? Response.json(config) : new Response('', { status: 404 })
    )
  );
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

const session = (editable: boolean): Session => ({
  editable,
  signedIn: false,
  protectReads: false
});
async function show(tls: object | undefined, editable = false) {
  config = { serverTime: NOW, ...(tls ? { tls } : {}) };
  // Unmount first: the section loads /api/config once per mount.
  await act(async () => render(null, root));
  await act(async () => render(<CertificateSection session={session(editable)} />, root));
  await vi.waitFor(() => expect(root.textContent).not.toContain('Loading'));
}

describe('CertificateSection', () => {
  it('shows the served certificate', async () => {
    await show(https);
    expect(root.querySelector('h2')?.textContent).toBe('Certificate');
    expect(root.textContent).toContain('Your certificate (PIPULSE_TLS_CERT)');
    expect(root.textContent).toContain('Valid');
    expect(root.textContent).toContain('80 days left');
    expect(root.textContent).toContain('io.lan, 192.168.1.20');
    expect(root.textContent).toContain('AB:CD');
    expect(root.textContent).toContain('Complete and trusted');
    expect(root.querySelector('svg')).toBeNull();
  });

  it('flags an expired certificate with an icon and words', async () => {
    await show({ ...https, validity: 'expired', notAfter: NOW - DAY });
    expect(root.textContent).toContain('Expired');
    expect(root.textContent).not.toContain('days left');
    expect(root.querySelector('svg')).not.toBeNull();
  });

  it('names a degraded chain and the names it misses', async () => {
    await show({
      ...https,
      class: 'degraded-san',
      reasons: ['san-missing'],
      missingNames: ['io.local']
    });
    expect(root.textContent).toContain('Missing a configured name: io.local');
  });

  it('reports a replacement that was not loaded', async () => {
    await show({
      ...https,
      reload: {
        state: 'failing',
        lastAttempt: NOW,
        lastError:
          'PIPULSE_TLS_CERT/PIPULSE_TLS_KEY: the private key does not match the first certificate'
      }
    });
    expect(root.textContent).toContain(
      'A replacement certificate was not loaded: PIPULSE_TLS_CERT/PIPULSE_TLS_KEY: the private key does not match the first certificate'
    );
    expect(root.textContent).toContain('The current one is still in use.');
  });

  it('warns that HTTP is unencrypted, more strongly with sign-in on', async () => {
    await show({ mode: 'http', reason: 'default' });
    expect(root.textContent).toContain('HTTPS is off: pages cross the network unencrypted.');
    await show({ mode: 'http', reason: 'default' }, true);
    expect(root.textContent).toContain(
      'HTTPS is off: pages, the password and the session cookie cross the network unencrypted.'
    );
  });

  it('says what turned HTTPS off, and treats an older server as HTTP', async () => {
    await show({ mode: 'http', reason: 'env' });
    expect(root.textContent).toContain('Turned off by PIPULSE_TLS=off.');
    await show({ mode: 'http', reason: 'state', stateMode: 'legacy-http' });
    expect(root.textContent).toContain('HTTPS is ready: run sudo pipulse tls enable on the Pi.');
    await show(undefined);
    expect(root.textContent).toContain('HTTPS is off');
  });
});
