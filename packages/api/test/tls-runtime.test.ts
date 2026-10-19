import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RELEASE_DEFAULT,
  loadCertificate,
  processIdentity,
  readTlsConfig,
  statSignature,
  type CertificateProvider
} from '@pipulse/tls';
import { StartupError } from '../src/config.js';
import {
  certificateAlertContext,
  createRuntimeStatus,
  initialSignatureOf,
  loadServingCertificate,
  startCertificateReloader
} from '../src/tls-runtime.js';
import { fixture } from '../../tls/test/helpers.js';

// Pass-through wrappers, so a test can see what the options were and make the process identity
// available on any platform.
vi.mock('@pipulse/tls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pipulse/tls')>();
  return {
    ...actual,
    loadCertificate: vi.fn(actual.loadCertificate),
    processIdentity: vi.fn(actual.processIdentity)
  };
});

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

describe('what it asks loadCertificate for', () => {
  it('owner root and the service group for a generated certificate, the names it must cover', () => {
    loadServingCertificate(good());
    const [, options] = vi.mocked(loadCertificate).mock.calls.at(-1)!;
    expect(options).toEqual({
      names: [],
      generatedOwner: { uid: 0, gid: process.getgid!() }
    });
  });

  it('asks for the names PIPULSE_TLS_NAMES lists', () => {
    loadServingCertificate(
      operator(fixture('leaf.crt') + fixture('intermediate.crt'), fixture('leaf.key'), {
        PIPULSE_TLS_NAMES: 'localhost'
      })
    );
    expect(vi.mocked(loadCertificate).mock.calls.at(-1)![1]?.names).toEqual(['localhost']);
  });

  it('leaves the group out when the platform has no process.getgid', () => {
    const getgid = process.getgid;
    process.getgid = undefined as never;
    try {
      loadServingCertificate(good());
    } finally {
      process.getgid = getgid;
    }
    expect(vi.mocked(loadCertificate).mock.calls.at(-1)![1]?.generatedOwner).toEqual({ uid: 0 });
  });
});

describe('loadServingCertificate, what is and is not loaded', () => {
  it('loads nothing when HTTPS is off, even if a source is configured', () => {
    expect(loadServingCertificate({ ...good(), mode: 'http' })).toBeUndefined();
  });

  it('loads nothing when there is no source, even if HTTPS is on', () => {
    expect(loadServingCertificate({ ...good(), source: undefined } as never)).toBeUndefined();
  });

  it('prints no SEVERE line for a certificate that is valid, even with PIPULSE_TLS_REQUIRE_VALID_CERT', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tls = operator(fixture('leaf.crt') + fixture('intermediate.crt'), fixture('leaf.key'), {
      PIPULSE_TLS_REQUIRE_VALID_CERT: 'true'
    });
    expect(loadServingCertificate(tls)).toBeDefined();
    expect(err).not.toHaveBeenCalled();
  });

  it('an expired certificate is not excused by an unsynchronized clock', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tls = operator(
      fixture('under-expired.crt') + fixture('expired-intermediate.crt'),
      fixture('under-expired.key'),
      { PIPULSE_TLS_REQUIRE_VALID_CERT: 'true' }
    );
    rmSync(join(dir, 'timesync', 'synchronized'));
    expect(() => loadServingCertificate(tls)).toThrow(
      /is expired and PIPULSE_TLS_REQUIRE_VALID_CERT/
    );
  });

  it('warns without a name list for a reason that is not a missing name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadServingCertificate(operator(fixture('leaf.crt'), fixture('leaf.key')));
    const lines = warn.mock.calls.flat().map(String);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\[pipulse\] warning: the HTTPS certificate is [\w-]+ \([\w-]+\)$/);
    }
  });

  it('lists every missing name, separated by a comma and a space', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadServingCertificate(
      operator(fixture('leaf.crt') + fixture('intermediate.crt'), fixture('leaf.key'), {
        PIPULSE_TLS_NAMES: 'one.example,two.example'
      })
    );
    expect(warn.mock.calls.flat().join('\n')).toContain('(san-missing: one.example, two.example)');
  });
});

describe('initialSignatureOf, the details', () => {
  it('is undefined when HTTPS is off, even if a source is configured', () => {
    expect(initialSignatureOf({ ...good(), mode: 'http' })).toBeUndefined();
  });

  it('is undefined when there is no source, even if HTTPS is on', () => {
    expect(initialSignatureOf({ ...good(), source: undefined } as never)).toBeUndefined();
  });

  it('covers exactly the certificate and key of an operator certificate without a CA', () => {
    const tls = good();
    expect(initialSignatureOf(tls)).toBe(
      statSignature([join(dir, 'cert.pem'), join(dir, 'key.pem')])
    );
  });

  it('notices a change to the generated bundle, and to its CA', () => {
    const bundlePath = join(dir, 'leaf.pem');
    const caPath = join(dir, 'ca.crt');
    writeFileSync(bundlePath, 'a');
    writeFileSync(caPath, 'b');
    const tls = { ...good(), source: { kind: 'generated', bundlePath, caPath } } as never;
    expect(initialSignatureOf(tls)).toBe(statSignature([bundlePath, caPath]));
    const before = initialSignatureOf(tls);
    writeFileSync(bundlePath, 'aa');
    expect(initialSignatureOf(tls)).not.toBe(before);
  });
});

describe('the alert context', () => {
  it('is not synchronized for a generated certificate on a clock that is not, and not for a stale one', () => {
    const tls = good();
    const cert = { ...loadServingCertificate(tls)!, source: 'generated' as const };
    rmSync(join(dir, 'timesync', 'synchronized'));
    expect(certificateAlertContext(tls, () => stubProvider(cert))().certificate?.clockSynced).toBe(
      false
    );
  });
});

describe('createRuntimeStatus, the details', () => {
  const identity = () => ({ startTime: '12345', bootId: 'boot-1' });

  it("uses the process's identity when none is given", () => {
    vi.mocked(processIdentity).mockReturnValueOnce({ startTime: '777', bootId: 'b-7' });
    createRuntimeStatus({
      runtimeDir: dir,
      certificate: undefined,
      provider: () => undefined,
      warn: () => {}
    }).publish();
    expect(vi.mocked(processIdentity)).toHaveBeenLastCalledWith(process.pid);
    expect(JSON.parse(readFileSync(join(dir, 'tls-status.json'), 'utf8'))).toMatchObject({
      startTime: '777',
      bootId: 'b-7'
    });
  });

  it('reports no certificate when the provider has none to show', () => {
    const provider = { ...stubProvider(loadServingCertificate(good())!), current: () => undefined };
    createRuntimeStatus({
      runtimeDir: dir,
      certificate: undefined,
      provider: () => provider as never,
      warn: () => {},
      identity
    }).publish();
    expect(JSON.parse(readFileSync(join(dir, 'tls-status.json'), 'utf8')).certificate).toBeNull();
  });

  it('warns on the first failure, not only on the second', () => {
    mkdirSync(join(dir, 'tls-status.json'));
    const warn = vi.fn();
    const status = createRuntimeStatus({
      runtimeDir: dir,
      certificate: undefined,
      provider: () => undefined,
      warn,
      identity
    });
    status.publish();
    expect(warn).toHaveBeenCalledTimes(1);
    status.publish();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('the reloader, in the way it decides', () => {
  it('notices files that changed before it started, from the signature it was given', () => {
    const tls = good();
    const cert = loadServingCertificate(tls)!;
    const signature = initialSignatureOf(tls);
    writeFileSync(join(dir, 'cert.pem'), fixture('leaf2.crt') + fixture('intermediate.crt'));
    writeFileSync(join(dir, 'key.pem'), fixture('leaf2.key'), { mode: 0o600 });
    const apply = vi.fn();
    const provider = startCertificateReloader({
      tls,
      certificate: cert,
      initialSignature: signature,
      apply,
      log: () => {},
      onChange: () => {}
    });
    provider.poll();
    provider.poll();
    expect(apply).toHaveBeenCalledTimes(1);
    provider.stop();
  });

  it('does not reload files that did not change', () => {
    const tls = good();
    const apply = vi.fn();
    const provider = startCertificateReloader({
      tls,
      certificate: loadServingCertificate(tls)!,
      initialSignature: initialSignatureOf(tls),
      apply,
      log: () => {},
      onChange: () => {}
    });
    vi.mocked(loadCertificate).mockClear();
    provider.poll();
    provider.poll();
    expect(apply).not.toHaveBeenCalled();
    expect(loadCertificate).not.toHaveBeenCalled(); // the files' signature is unchanged: nothing is read
    provider.stop();
  });

  it('refuses a replacement that is expired while the certificate in use is not', () => {
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
    writeFileSync(
      join(dir, 'cert.pem'),
      fixture('under-expired.crt') + fixture('expired-intermediate.crt')
    );
    writeFileSync(join(dir, 'key.pem'), fixture('under-expired.key'), { mode: 0o600 });
    provider.poll();
    provider.poll();
    expect(apply).not.toHaveBeenCalled();
    expect(provider.current().fingerprint).toBe(cert.fingerprint);
    expect(log.mock.calls.flat().join('\n')).toMatch(/replacement certificate is expired/);
    provider.stop();
  });
});
