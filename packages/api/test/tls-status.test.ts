import { describe, expect, it } from 'vitest';
import { inspectMaterial, startReloader, type TlsConfig } from '@pipulse/tls';
import { healthBody, tlsView, type TlsView } from '../src/tls-status.js';
import { fixture } from '../../tls/test/helpers.js';

const ok = { ok: true, problems: [] };
const cert = (
  crt = 'leaf.crt',
  key = 'leaf.key',
  chain = ['intermediate.crt'],
  source: 'operator' | 'generated' = 'operator'
) =>
  inspectMaterial({
    source,
    keyPem: fixture(key),
    certPems: [fixture(crt), ...chain.map(fixture)],
    trust: { anchors: [fixture('root-ca.crt')], system: false },
    names: []
  });
const provider = (c = cert()) =>
  startReloader({ initial: c, load: () => c, signature: () => 's', apply: () => {}, timer: false });
const config = (extra: Partial<TlsConfig> = {}): TlsConfig => ({
  mode: 'https',
  modeReason: 'env',
  source: { kind: 'operator', certPath: '/c', keyPath: '/k' },
  requireValid: false,
  names: [],
  clockTrust: false,
  dir: '/etc/pipulse/tls',
  timesyncDir: '/nonexistent-timesync',
  ...extra
});
const NOW = Date.UTC(2027, 0, 1);

describe('tlsView', () => {
  it('describes HTTP mode by what decided it', () => {
    expect(
      tlsView(
        config({ mode: 'http', modeReason: 'state', stateMode: 'legacy-http' }),
        undefined,
        NOW
      )
    ).toEqual({
      mode: 'http',
      reason: 'state',
      stateMode: 'legacy-http',
      inContainer: false
    });
  });

  it('describes the served certificate', () => {
    const view = tlsView(config(), provider(), NOW);
    expect(view).toMatchObject({
      mode: 'https',
      source: 'operator',
      validity: 'valid',
      class: 'valid',
      clock: 'unknown',
      reload: { state: 'ok' }
    });
  });
});

describe('healthBody', () => {
  const https = (patch: Partial<Extract<TlsView, { mode: 'https' }>> = {}): TlsView => ({
    ...(tlsView(config(), provider(), NOW) as Extract<TlsView, { mode: 'https' }>),
    ...patch
  });

  it('is ok for a valid certificate, with enums only', () => {
    expect(healthBody(ok, https(), true)).toEqual({
      status: 'ok',
      monitoring: 'ok',
      transport: 'https',
      certificate: {
        source: 'operator',
        validity: 'valid',
        clockSynced: 'unknown',
        class: 'valid',
        reload: 'ok'
      }
    });
  });

  it.each([
    ['expired', { validity: 'expired' as const }, ['expired']],
    ['not yet valid', { validity: 'not-yet-valid' as const }, ['not-yet-valid']],
    [
      'a degraded class',
      { class: 'degraded-incomplete-chain' as const, reasons: ['incomplete-chain'] },
      ['incomplete-chain']
    ],
    [
      'a failing reload',
      { reload: { state: 'failing' as const, lastAttempt: 1, lastError: 'x' } },
      ['reload-failing']
    ],
    [
      'an expired certificate with no valid reload',
      {
        validity: 'expired' as const,
        reload: { state: 'failing' as const, lastAttempt: 1, lastError: 'x' }
      },
      ['expired', 'no-valid-reload']
    ],
    [
      'an unsynced clock with a generated source',
      { source: 'generated' as const, clock: 'unsynced' as const, clockSynced: false },
      ['clock-unsynced']
    ]
  ])('is degraded (200) for %s', (_name, patch, reasons) => {
    const body = healthBody(ok, https(patch), false);
    expect(body.status).toBe('degraded');
    expect(body.monitoring).toBe('ok');
    expect(body.reasons).toEqual(reasons);
  });

  it('reports the reload state as ok, failing or no-valid-reload', () => {
    const failing = { state: 'failing' as const, lastAttempt: 1, lastError: 'x' };
    expect(healthBody(ok, https(), false).certificate?.reload).toBe('ok');
    expect(healthBody(ok, https({ reload: failing }), false).certificate?.reload).toBe('failing');
    expect(
      healthBody(ok, https({ reload: failing, validity: 'expired' }), false).certificate?.reload
    ).toBe('no-valid-reload');
  });

  it('ignores the clock for an operator certificate', () => {
    expect(healthBody(ok, https({ clock: 'unsynced', clockSynced: false }), false).status).toBe(
      'ok'
    );
  });

  it('fails only for monitoring, never for the certificate alone', () => {
    expect(healthBody(ok, https({ validity: 'expired' }), false).status).toBe('degraded');
    expect(
      healthBody(
        { ok: false, problems: ['database unavailable'] },
        https({ validity: 'expired' }),
        false
      )
    ).toMatchObject({
      status: 'failing',
      monitoring: 'failing',
      problems: ['database unavailable'],
      reasons: ['expired']
    });
  });
});
