import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_DEFAULT, readTlsConfig, type CertificateProvider } from '@pipulse/tls';
import { StartupError } from '../src/config.js';
import {
  certificateAlertContext,
  createRuntimeStatus,
  initialSignatureOf,
  loadServingCertificate,
  startCertificateReloader
} from '../src/tls-runtime.js';
import { fixture } from '../../tls/test/helpers.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipulse-tlsrt-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** TLS settings for an operator certificate written under `dir`; the clock counts as synchronized. */
function operator(cert: string, key: string, extra: Record<string, string> = {}) {
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  const timesync = join(dir, 'timesync');
  writeFileSync(certPath, cert);
  writeFileSync(keyPath, key, { mode: 0o600 });
  mkdirSync(timesync, { recursive: true });
  writeFileSync(join(timesync, 'synchronized'), '');
  return readTlsConfig(
    {
      PIPULSE_TLS: 'on',
      PIPULSE_TLS_CERT: certPath,
      PIPULSE_TLS_KEY: keyPath,
      PIPULSE_TLS_TIMESYNC_DIR: timesync,
      PIPULSE_TLS_DIR: join(dir, 'tls'),
      ...extra
    },
    { releaseDefault: RELEASE_DEFAULT }
  );
}
const good = () => operator(fixture('leaf.crt') + fixture('intermediate.crt'), fixture('leaf.key'));
const expired = (extra: Record<string, string> = {}) =>
  operator(
    fixture('under-expired.crt') + fixture('expired-intermediate.crt'),
    fixture('under-expired.key'),
    extra
  );
const stubProvider = (
  cert: NonNullable<ReturnType<typeof loadServingCertificate>>
): CertificateProvider => ({
  current: () => cert,
  reload: () => ({ state: 'ok', lastAttempt: null, lastError: null }),
  poll: () => {},
  stop: () => {}
});

describe('loadServingCertificate', () => {
  it('loads an operator certificate and describes it', () => {
    const cert = loadServingCertificate(good());
    expect(cert?.source).toBe('operator');
    expect(cert?.fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  });

  it('refuses a key that does not match, with the line the process prints', () => {
    const tls = operator(fixture('leaf.crt') + fixture('intermediate.crt'), fixture('leaf2.key'));
    expect(() => loadServingCertificate(tls)).toThrow(StartupError);
    expect(() => loadServingCertificate(tls)).toThrow(
      /the private key does not match the first certificate$/
    );
  });

  it('starts, with a SEVERE line, for an expired chain', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadServingCertificate(expired())).toBeDefined();
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('[pipulse] SEVERE: the HTTPS certificate is expired')
    );
  });

  it('refuses an expired chain with PIPULSE_TLS_REQUIRE_VALID_CERT=true', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      loadServingCertificate(expired({ PIPULSE_TLS_REQUIRE_VALID_CERT: 'true' }))
    ).toThrow(/the HTTPS certificate is expired and PIPULSE_TLS_REQUIRE_VALID_CERT=true$/);
  });

  it('has nothing to load over plain HTTP', () => {
    const tls = readTlsConfig(
      { PIPULSE_TLS: 'off', PIPULSE_TLS_DIR: join(dir, 'tls') },
      { releaseDefault: RELEASE_DEFAULT }
    );
    expect(loadServingCertificate(tls)).toBeUndefined();
  });
});

describe('createRuntimeStatus', () => {
  const identity = () => ({ startTime: '12345', bootId: 'boot-1' });

  it('writes the status file of a plain HTTP server', () => {
    createRuntimeStatus({
      runtimeDir: dir,
      certificate: undefined,
      provider: () => undefined,
      warn: () => {},
      identity
    }).publish();
    const written = JSON.parse(readFileSync(join(dir, 'tls-status.json'), 'utf8'));
    expect(written).toMatchObject({
      version: 1,
      transport: 'http',
      certificate: null,
      pid: process.pid,
      startTime: '12345',
      bootId: 'boot-1'
    });
  });

  it('reports the certificate and its reload state for an HTTPS server', () => {
    const cert = loadServingCertificate(good())!;
    createRuntimeStatus({
      runtimeDir: dir,
      certificate: cert,
      provider: () => stubProvider(cert),
      warn: () => {},
      identity
    }).publish();
    const written = JSON.parse(readFileSync(join(dir, 'tls-status.json'), 'utf8'));
    expect(written.transport).toBe('https');
    expect(written.certificate).toMatchObject({
      source: 'operator',
      fingerprint: cert.fingerprint,
      notAfter: cert.notAfter,
      reload: { state: 'ok' }
    });
  });

  it('writes nothing, and does not throw, when the folder does not exist', () => {
    const missing = join(dir, 'absent');
    createRuntimeStatus({
      runtimeDir: missing,
      certificate: undefined,
      provider: () => undefined,
      warn: () => {},
      identity
    }).publish();
    expect(existsSync(missing)).toBe(false);
  });

  it('writes nothing without a process identity (off Linux)', () => {
    createRuntimeStatus({
      runtimeDir: dir,
      certificate: undefined,
      provider: () => undefined,
      warn: () => {},
      identity: () => undefined
    }).publish();
    expect(existsSync(join(dir, 'tls-status.json'))).toBe(false);
  });

  it('warns once, not on every publish, when the file cannot be written', () => {
    mkdirSync(join(dir, 'tls-status.json')); // a folder where the file goes: the rename fails, even as root
    const warn = vi.fn();
    const status = createRuntimeStatus({
      runtimeDir: dir,
      certificate: undefined,
      provider: () => undefined,
      warn,
      identity
    });
    status.publish();
    status.publish();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(`could not write ${dir}/tls-status.json`);
  });
});

describe('certificateAlertContext', () => {
  it('is empty without a provider', () => {
    expect(certificateAlertContext(good(), () => undefined)()).toEqual({});
  });

  it('carries the expiry and that the clock is synchronized', () => {
    const tls = good();
    const cert = loadServingCertificate(tls)!;
    expect(certificateAlertContext(tls, () => stubProvider(cert))()).toEqual({
      certificate: { notAfter: cert.notAfter, clockSynced: true }
    });
  });

  it('says the clock is not synchronized when it is not', () => {
    const tls = good();
    rmSync(join(dir, 'timesync', 'synchronized'));
    const cert = loadServingCertificate(tls)!;
    const context = certificateAlertContext(tls, () => stubProvider(cert))();
    expect(context.certificate?.clockSynced).toBe(false);
  });

  it("passes a generated certificate's start date to the clock check", () => {
    const tls = good();
    const cert = { ...loadServingCertificate(tls)!, source: 'generated' as const };
    const context = certificateAlertContext(tls, () => stubProvider(cert))();
    expect(context.certificate?.notAfter).toBe(cert.notAfter);
  });
});

describe('startCertificateReloader', () => {
  it('swaps in a replaced certificate through apply and tells onChange', () => {
    const tls = good();
    const cert = loadServingCertificate(tls)!;
    const apply = vi.fn();
    const onChange = vi.fn();
    const provider = startCertificateReloader({
      tls,
      certificate: cert,
      initialSignature: initialSignatureOf(tls),
      apply,
      log: () => {},
      onChange
    });
    writeFileSync(join(dir, 'cert.pem'), fixture('leaf2.crt') + fixture('intermediate.crt'));
    writeFileSync(join(dir, 'key.pem'), fixture('leaf2.key'), { mode: 0o600 });
    provider.poll();
    provider.poll(); // a change must look the same on two polls
    expect(apply).toHaveBeenCalledTimes(1);
    expect(provider.current().fingerprint).not.toBe(cert.fingerprint);
    expect(onChange).toHaveBeenCalled();
    provider.stop();
  });

  it('keeps the certificate it has when the replacement does not match its key', () => {
    const tls = good();
    const cert = loadServingCertificate(tls)!;
    const apply = vi.fn();
    const log = vi.fn();
    const provider = startCertificateReloader({
      tls,
      certificate: cert,
      initialSignature: initialSignatureOf(tls),
      apply,
      log,
      onChange: () => {}
    });
    writeFileSync(join(dir, 'key.pem'), fixture('leaf2.key'), { mode: 0o600 });
    provider.poll();
    provider.poll();
    expect(apply).not.toHaveBeenCalled();
    expect(provider.current().fingerprint).toBe(cert.fingerprint);
    expect(log).toHaveBeenCalled();
    provider.stop();
  });
});

describe('loadServingCertificate, the other branches', () => {
  const future = (extra: Record<string, string> = {}) =>
    operator(fixture('future.crt') + fixture('intermediate.crt'), fixture('future.key'), extra);

  it('refuses a certificate that is not valid yet when the clock is synchronized', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      loadServingCertificate(future({ PIPULSE_TLS_REQUIRE_VALID_CERT: 'true' }))
    ).toThrow(/the HTTPS certificate is not-yet-valid and PIPULSE_TLS_REQUIRE_VALID_CERT=true$/);
  });

  it('starts with a certificate that is not valid yet when the clock may be wrong', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tls = future({ PIPULSE_TLS_REQUIRE_VALID_CERT: 'true' });
    rmSync(join(dir, 'timesync', 'synchronized'));
    expect(loadServingCertificate(tls)).toBeDefined();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('is not-yet-valid'));
  });

  it('names the missing names of a certificate that does not cover them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tls = operator(fixture('leaf.crt') + fixture('intermediate.crt'), fixture('leaf.key'), {
      PIPULSE_TLS_NAMES: 'not-in-the-certificate.example'
    });
    expect(loadServingCertificate(tls)).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /the HTTPS certificate is \w[\w-]* \(san-missing: not-in-the-certificate\.example\)/
      )
    );
  });

  it('loads without a group id to check (a platform with no process.getgid)', () => {
    const getgid = process.getgid;
    process.getgid = undefined as never;
    try {
      expect(loadServingCertificate(good())).toBeDefined();
    } finally {
      process.getgid = getgid;
    }
  });
});

describe('initialSignatureOf', () => {
  it('is undefined for plain HTTP', () => {
    const tls = readTlsConfig(
      { PIPULSE_TLS: 'off', PIPULSE_TLS_DIR: join(dir, 'tls') },
      { releaseDefault: RELEASE_DEFAULT }
    );
    expect(initialSignatureOf(tls)).toBeUndefined();
  });

  it('changes when the certificate, the key or the CA file changes', () => {
    const ca = join(dir, 'ca.pem');
    writeFileSync(ca, fixture('intermediate.crt'));
    const tls = operator(fixture('leaf.crt'), fixture('leaf.key'), { PIPULSE_TLS_CA: ca });
    const before = initialSignatureOf(tls);
    expect(before).toBeDefined();
    writeFileSync(ca, fixture('intermediate.crt') + '\n');
    expect(initialSignatureOf(tls)).not.toBe(before);
  });

  it('covers the bundle and the CA of a generated certificate', () => {
    const bundlePath = join(dir, 'leaf.pem');
    const caPath = join(dir, 'ca.crt');
    writeFileSync(bundlePath, 'a');
    writeFileSync(caPath, 'b');
    const tls = { ...good(), source: { kind: 'generated', bundlePath, caPath } } as never;
    const before = initialSignatureOf(tls);
    writeFileSync(caPath, 'bb');
    expect(initialSignatureOf(tls)).not.toBe(before);
  });
});

describe('startCertificateReloader, the other branches', () => {
  it('needs a certificate source', () => {
    const tls = good();
    const cert = loadServingCertificate(tls)!;
    expect(() =>
      startCertificateReloader({
        tls: { ...tls, source: undefined } as never,
        certificate: cert,
        initialSignature: undefined,
        apply: () => {},
        log: () => {},
        onChange: () => {}
      })
    ).toThrow('startCertificateReloader needs a certificate source');
  });

  it('starts without an initial signature', () => {
    const tls = good();
    const cert = loadServingCertificate(tls)!;
    const provider = startCertificateReloader({
      tls,
      certificate: cert,
      initialSignature: undefined,
      apply: () => {},
      log: () => {},
      onChange: () => {}
    });
    expect(provider.current().fingerprint).toBe(cert.fingerprint);
    provider.stop();
  });
});

describe('createRuntimeStatus by default', () => {
  it("takes the process's own identity, and never throws", () => {
    expect(() =>
      createRuntimeStatus({
        runtimeDir: dir,
        certificate: undefined,
        provider: () => undefined,
        warn: () => {}
      }).publish()
    ).not.toThrow();
  });
});
