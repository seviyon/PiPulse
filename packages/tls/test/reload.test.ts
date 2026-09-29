import { copyFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { inspectMaterial, type LoadedCertificate, type Trust } from '../src/inspect.js';
import { startReloader } from '../src/reload.js';
import { statSignature } from '../src/files.js';
import { fixture, fixturePath, tempDir } from './helpers.js';

const root: Trust = { anchors: [fixture('root-ca.crt')], system: false };
const make = (crt: string, key: string, chain = [fixture('intermediate.crt')]): LoadedCertificate =>
  inspectMaterial({
    source: 'operator',
    keyPem: fixture(key),
    certPems: [fixture(crt), ...chain],
    trust: root,
    names: []
  });
const A = make('leaf.crt', 'leaf.key');
const B = make('leaf2.crt', 'leaf2.key');
const B_INCOMPLETE = make('leaf2.crt', 'leaf2.key', []);

function setup(initial = A) {
  let sig = 's0';
  let next: () => LoadedCertificate = () => initial;
  let t = 0;
  const applied: LoadedCertificate[] = [];
  const logs: string[] = [];
  const provider = startReloader({
    initial,
    load: () => next(),
    signature: () => sig,
    apply: (cert) => applied.push(cert),
    now: () => t,
    log: (m) => logs.push(m),
    timer: false
  });
  return {
    provider,
    applied,
    logs,
    change(s: string, load: () => LoadedCertificate) {
      sig = s;
      next = load;
    },
    advance(ms: number) {
      t += ms;
    }
  };
}

describe('startReloader', () => {
  it('activates a valid replacement after the change is stable for two polls', () => {
    const r = setup();
    r.change('s1', () => B);
    r.provider.poll();
    expect(r.applied).toEqual([]);
    r.provider.poll();
    expect(r.applied).toEqual([B]);
    expect(r.provider.current()).toBe(B);
    expect(r.provider.reload()).toMatchObject({ state: 'ok', lastError: null });
    expect(r.logs.some((m) => m.includes(`certificate reloaded (SHA-256 ${B.fingerprint})`))).toBe(
      true
    );
  });

  it('a key written a poll after its certificate never activates a mismatched pair', () => {
    const r = setup();
    r.change('cert-only', () => {
      throw new Error('the private key does not match the first certificate');
    });
    r.provider.poll();
    r.change('cert+key', () => B); // the key landed before the second poll
    r.provider.poll();
    expect(r.applied).toEqual([]);
    r.provider.poll();
    expect(r.applied).toEqual([B]);
  });

  it('keeps the active certificate when the replacement is refused, and reports failing', () => {
    const r = setup();
    r.change('s1', () => {
      throw new Error('PIPULSE_TLS_KEY: file not found');
    });
    r.provider.poll();
    r.provider.poll();
    expect(r.applied).toEqual([]);
    expect(r.provider.current()).toBe(A);
    expect(r.provider.reload()).toMatchObject({
      state: 'failing',
      lastError: 'PIPULSE_TLS_KEY: file not found'
    });
  });

  it('never replaces a valid certificate with a degraded one', () => {
    const r = setup();
    r.change('s1', () => B_INCOMPLETE);
    r.provider.poll();
    r.provider.poll();
    expect(r.applied).toEqual([]);
    expect(r.provider.reload().lastError).toBe(
      'the replacement is degraded-incomplete-chain and the active certificate is valid; kept the active one'
    );
  });

  it('lets a degraded certificate be replaced by an equal or better one', () => {
    const r = setup(B_INCOMPLETE);
    r.change('s1', () => A);
    r.provider.poll();
    r.provider.poll();
    expect(r.applied).toEqual([A]);
  });

  it('does nothing when the files changed but the certificate did not', () => {
    const r = setup();
    r.change('s1', () => A);
    r.provider.poll();
    r.provider.poll();
    expect(r.applied).toEqual([]);
    expect(r.provider.reload().state).toBe('ok');
  });

  it('tries each distinct change once and logs the same failure at most hourly', () => {
    const r = setup();
    const load = vi.fn(() => {
      throw new Error('bad');
    });
    r.change('s1', load);
    for (let i = 0; i < 5; i++) r.provider.poll();
    expect(load).toHaveBeenCalledTimes(1);
    r.change('s2', load);
    r.provider.poll();
    r.provider.poll();
    expect(load).toHaveBeenCalledTimes(2);
    expect(r.logs.filter((m) => m.includes('bad'))).toHaveLength(1);
    r.advance(60 * 60_000);
    r.change('s3', load);
    r.provider.poll();
    r.provider.poll();
    expect(r.logs.filter((m) => m.includes('bad'))).toHaveLength(2);
  });

  it('stops polling on stop() and never holds the process open', () => {
    vi.useFakeTimers();
    try {
      const signature = vi.fn(() => 's');
      const provider = startReloader({
        initial: A,
        load: () => A,
        signature,
        apply: () => {},
        pollMs: 1000
      });
      vi.advanceTimersByTime(3000);
      const calls = signature.mock.calls.length;
      provider.stop();
      vi.advanceTimersByTime(5000);
      expect(signature.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sees a certbot-style symlink retarget as a change', () => {
    const dir = tempDir();
    try {
      copyFileSync(fixturePath('leaf.crt'), join(dir, 'fullchain1.pem'));
      copyFileSync(fixturePath('leaf2.crt'), join(dir, 'fullchain2.pem'));
      const link = join(dir, 'fullchain.pem');
      symlinkSync('fullchain1.pem', link);
      const before = statSignature([link]);
      rmSync(link);
      symlinkSync('fullchain2.pem', link);
      expect(statSignature([link])).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('picks up a change that landed between the startup load and startReloader', () => {
    let sig = 'before-load';
    const preLoad = sig;
    const initial = A;
    sig = 'renewed'; // files changed after the caller's read, before startReloader
    const applied: LoadedCertificate[] = [];
    const provider = startReloader({
      initial,
      initialSignature: preLoad,
      load: () => B,
      signature: () => sig,
      apply: (cert) => applied.push(cert),
      timer: false
    });
    provider.poll();
    provider.poll();
    expect(applied).toEqual([B]);
    expect(provider.current()).toBe(B);
  });
});
