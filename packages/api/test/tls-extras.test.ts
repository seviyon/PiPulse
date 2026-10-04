import { X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type PiPulseDb } from '@pipulse/storage';
import {
  inspectMaterial,
  startReloader,
  type LoadedCertificate,
  type TlsConfig
} from '@pipulse/tls';
import { buildServer } from '../src/index.js';
import { readGeneratedExtras, tlsView } from '../src/tls-status.js';
import { fixture, tempDir } from '../../tls/test/helpers.js';

// root-ca is the CA being replaced, other-ca the new one (other-leaf is its leaf).
const OLD_CA = new X509Certificate(fixture('root-ca.crt')).fingerprint256;
const NEW_CA = new X509Certificate(fixture('other-ca.crt')).fingerprint256;
const asRoot = process.getuid?.() === 0;
let dir: string;
let db: PiPulseDb;
beforeEach(() => {
  dir = tempDir();
  db = openDb(':memory:');
});
afterEach(() => {
  for (const name of ['ca-meta.json', 'renew-status.json']) {
    try {
      chmodSync(join(dir, name), 0o644);
    } catch {
      // not there
    }
  }
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

/**
 * What loadCertificate gives for a leaf.pem against the ca.crt on disk: its
 * caFingerprint is the anchor the chain verifies against (Task 4), or none.
 */
const served = (
  caFile: 'root-ca.crt' | 'other-ca.crt',
  leaf: 'old' | 'new' = 'old'
): LoadedCertificate =>
  inspectMaterial({
    source: 'generated',
    keyPem: fixture(leaf === 'old' ? 'leaf.key' : 'other-leaf.key'),
    certPems:
      leaf === 'old'
        ? [fixture('leaf.crt'), fixture('intermediate.crt')]
        : [fixture('other-leaf.crt')],
    trust: { anchors: [fixture(caFile)], system: false },
    names: []
  });
const config = (): TlsConfig => ({
  mode: 'https',
  modeReason: 'state',
  stateMode: 'https',
  source: { kind: 'generated', bundlePath: join(dir, 'leaf.pem'), caPath: join(dir, 'ca.crt') },
  requireValid: false,
  names: [],
  clockTrust: true, // no timesyncd folder here: count the clock as synced
  dir,
  timesyncDir: join(dir, 'no-timesync'),
  warnings: []
});
const meta = (fingerprint: string, extra: object = {}) =>
  JSON.stringify({
    version: 1,
    fingerprint,
    subject: 'PiPulse CA io 0a1b2c',
    createdAt: 1,
    notAfter: 2,
    constraints: {
      dns: ['io', 'io.local', 'localhost'],
      excludedDns: [],
      subnets: ['192.168.1.0/24']
    },
    backups: [],
    ...extra
  });
const write = (name: string, content: string) => writeFileSync(join(dir, name), content);

/** The real server over these files, with a provider that switches to `next` on reload(). */
function serve(initial: LoadedCertificate, next = initial) {
  let signature = 'before';
  const provider = startReloader({
    initial,
    load: () => next,
    signature: () => signature,
    apply: () => {},
    timer: false
  });
  const app = buildServer(db, {
    tls: () =>
      tlsView(config(), provider, Date.now(), {
        extras: readGeneratedExtras(dir),
        inContainer: false
      })
  });
  return {
    async get() {
      const health = await app.inject('/api/health');
      const settings = await app.inject('/api/config');
      return {
        code: health.statusCode,
        health: health.json(),
        healthText: health.body,
        tls: settings.json().tls
      };
    },
    reload() {
      signature = 'after';
      provider.poll();
      provider.poll();
    },
    close: () => app.close()
  };
}

describe('readGeneratedExtras', () => {
  it('reads both files; a missing renew-status.json is expected, a missing ca-meta.json is not', () => {
    write('ca-meta.json', meta(OLD_CA));
    expect(readGeneratedExtras(dir)).toMatchObject({ meta: { fingerprint: OLD_CA }, problems: [] });
    rmSync(join(dir, 'ca-meta.json'));
    expect(readGeneratedExtras(dir).problems).toEqual([
      { file: 'ca-meta.json', message: 'missing' }
    ]);
  });
  it('reports a directory in the way by its code, never its path', () => {
    mkdirSync(join(dir, 'renew-status.json'));
    write('ca-meta.json', meta(OLD_CA));
    expect(readGeneratedExtras(dir).problems).toEqual([
      { file: 'renew-status.json', message: 'EISDIR' }
    ]);
  });
});

describe('the public responses', () => {
  it('healthy, no renewal yet: ok, quiet, with scope and coverage', async () => {
    write('ca-meta.json', meta(OLD_CA));
    const server = serve(served('root-ca.crt'));
    const { code, health, tls } = await server.get();
    expect(code).toBe(200);
    expect(health).toMatchObject({
      status: 'ok',
      certificate: { renewal: 'unknown', metadata: 'ok' }
    });
    expect(health.reasons).toBeUndefined();
    expect(tls).toMatchObject({
      ca: { state: 'ok', subject: 'PiPulse CA io 0a1b2c', backups: 0 },
      coverage: { dns: ['io', 'io.local', 'localhost'], ipSubnets: ['192.168.1.0/24'] },
      renewal: { state: 'unknown' },
      metadata: 'ok'
    });
    expect(tls.metadataProblems).toBeUndefined();
    await server.close();
  });

  it('an interrupted rotation (new metadata, old leaf, no reload yet): transitional, then ok once the new leaf is served', async () => {
    write('ca-meta.json', meta(NEW_CA)); // new-ca installed ca.crt and ca-meta.json; the reloader hasn't switched yet
    const server = serve(served('root-ca.crt'), served('other-ca.crt', 'new'));
    let now = await server.get();
    expect(now.tls.ca).toEqual({ state: 'transitional' });
    expect(now.tls.coverage).toBeUndefined();
    expect(now.tls.metadata).toBe('transitional');
    expect(now.health).toMatchObject({ status: 'ok', certificate: { metadata: 'transitional' } });
    server.reload();
    now = await server.get();
    expect(now.tls.ca).toMatchObject({ state: 'ok' });
    expect(now.tls.coverage).toBeDefined();
    expect(now.health.certificate.metadata).toBe('ok');
    await server.close();
  });

  it('a reload that publishes the new ca.crt with the old leaf never shows the new scope', async () => {
    write('ca-meta.json', meta(NEW_CA));
    // Same key and chain, new trust file: the reloader publishes it (6b-1), but the
    // old leaf doesn't verify against the new CA, so it has no CA fingerprint.
    const server = serve(served('root-ca.crt'), served('other-ca.crt', 'old'));
    server.reload();
    const { tls } = await server.get();
    expect(tls.ca).toEqual({ state: 'transitional' });
    expect(tls.coverage).toBeUndefined();
    await server.close();
  });

  it.skipIf(asRoot)(
    'an unreadable ca-meta.json: degraded with an enum only, details in config',
    async () => {
      write('ca-meta.json', meta(OLD_CA));
      chmodSync(join(dir, 'ca-meta.json'), 0o000);
      const server = serve(served('root-ca.crt'));
      const { code, health, healthText, tls } = await server.get();
      expect(code).toBe(200);
      expect(health).toMatchObject({ status: 'degraded', certificate: { metadata: 'unreadable' } });
      expect(health.reasons).toContain('generated-metadata-unreadable');
      expect(healthText).not.toContain(dir);
      expect(healthText).not.toContain('ca-meta.json');
      expect(tls.ca).toEqual({ state: 'unavailable' });
      expect(tls.metadataProblems).toEqual([{ file: 'ca-meta.json', message: 'EACCES' }]);
      await server.close();
    }
  );

  it('corrupt JSON in ca-meta.json', async () => {
    write('ca-meta.json', '{"version":1,');
    const server = serve(served('root-ca.crt'));
    const { health, healthText, tls } = await server.get();
    expect(health.status).toBe('degraded');
    expect(health.reasons).toContain('generated-metadata-unreadable');
    expect(healthText).not.toContain('not valid JSON');
    expect(tls.metadataProblems).toEqual([
      { file: 'ca-meta.json', message: 'ca-meta.json is not valid JSON' }
    ]);
    await server.close();
  });

  it('a renew-status.json with the wrong version', async () => {
    write('ca-meta.json', meta(OLD_CA));
    write(
      'renew-status.json',
      JSON.stringify({ version: 2, lastAttempt: 1, result: 'renewed', reason: '' })
    );
    const server = serve(served('root-ca.crt'));
    const { health, tls } = await server.get();
    expect(health).toMatchObject({
      status: 'degraded',
      certificate: { renewal: 'unknown', metadata: 'unreadable' }
    });
    expect(tls.metadataProblems).toEqual([
      { file: 'renew-status.json', message: 'renew-status.json is not valid' }
    ]);
    expect(tls.ca).toMatchObject({ state: 'ok' }); // the CA facts themselves are fine
    await server.close();
  });

  it('a failing renewal is degraded while the served certificate is fine', async () => {
    write('ca-meta.json', meta(OLD_CA));
    write(
      'renew-status.json',
      JSON.stringify({ version: 1, lastAttempt: 1, result: 'failed', reason: 'openssl req failed' })
    );
    const server = serve(served('root-ca.crt'));
    const { health, tls } = await server.get();
    expect(health).toMatchObject({
      status: 'degraded',
      certificate: { renewal: 'failing', metadata: 'ok' }
    });
    expect(health.reasons).toContain('renewal-failing');
    expect(tls.renewal).toMatchObject({ state: 'failing', reason: 'openssl req failed' });
    await server.close();
  });
});
