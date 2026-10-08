import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectMaterial, startReloader, type TlsConfig } from '@pipulse/tls';
import { healthBody, tlsView, writeTlsMarker } from '../src/tls-status.js';
import { fixture, tempDir } from '../../tls/test/helpers.js';

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

const cert = inspectMaterial({
  source: 'operator',
  keyPem: fixture('leaf.key'),
  certPems: [fixture('leaf.crt'), fixture('intermediate.crt')],
  trust: { anchors: [fixture('root-ca.crt')], system: false },
  names: []
});
const provider = startReloader({
  initial: cert,
  load: () => cert,
  signature: () => 's',
  apply: () => {},
  timer: false
});
const config: TlsConfig = {
  mode: 'https',
  modeReason: 'env',
  source: { kind: 'operator', certPath: '/c', keyPath: '/k' },
  requireValid: false,
  names: [],
  clockTrust: false,
  dir: '/x',
  timesyncDir: '/nonexistent',
  warnings: []
};

describe('the tls-installed marker', () => {
  it('is written next to the database', () => {
    expect(writeTlsMarker(dir)).toBeUndefined();
    expect(existsSync(join(dir, 'tls-installed'))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    'an existing marker the service cannot rewrite is left alone, with no problem',
    () => {
      const marker = join(dir, 'tls-installed');
      writeFileSync(marker, 'old\n');
      chmodSync(marker, 0o444);
      expect(writeTlsMarker(dir)).toBeUndefined();
      expect(readFileSync(marker, 'utf8')).toBe('old\n');
    }
  );

  it('shows no problem and no health reason when it was written', () => {
    const view = tlsView(config, provider, Date.now());
    expect(view).not.toHaveProperty('markerProblem');
    const body = healthBody({ ok: true, problems: [] }, view, false);
    expect(body.reasons ?? []).not.toContain('tls-marker-unwritten');
  });

  it.skipIf(process.getuid?.() === 0)(
    'a folder it can’t write is reported, and health is degraded with an enum only',
    () => {
      chmodSync(dir, 0o500);
      const problem = writeTlsMarker(dir);
      expect(problem).toBe('tls-installed could not be written (EACCES)');
      const view = tlsView(config, provider, Date.now(), { markerProblem: problem! });
      expect(view).toMatchObject({ markerProblem: problem });
      const body = healthBody({ ok: true, problems: [] }, view, false);
      expect(body.status).toBe('degraded');
      expect(body.reasons).toContain('tls-marker-unwritten');
      expect(JSON.stringify(body)).not.toContain(dir);
    }
  );

  it('a missing folder is reported with the error code, never the path', () => {
    const problem = writeTlsMarker(join(dir, 'missing'));
    expect(problem).toBe('tls-installed could not be written (ENOENT)');
  });
});
