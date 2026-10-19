import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectMaterial, type LoadedCertificate } from '../src/inspect/inspect.js';
import { RETRY_MS, startReloader } from '../src/inspect/reload.js';
import { fixture } from './helpers.js';

const MIN = 60_000;
const make = (crt: string, key: string, chain = [fixture('intermediate.crt')]) =>
  inspectMaterial({
    source: 'operator',
    keyPem: fixture(key),
    certPems: [fixture(crt), ...chain],
    trust: { anchors: [fixture('root-ca.crt')], system: false },
    names: []
  });
const A = make('leaf.crt', 'leaf.key');
const B = make('leaf2.crt', 'leaf2.key');
const B_INCOMPLETE = make('leaf2.crt', 'leaf2.key', []);

afterEach(() => vi.useRealTimers());

/** A reloader driven by hand: `mono` and `wall` move only when the test moves them. */
function drive(
  initial: LoadedCertificate,
  load: () => LoadedCertificate,
  opts: { wall?: number; mono?: number; accept?: () => void } = {}
) {
  let sig = 's0';
  let wall = opts.wall ?? 0;
  let mono = opts.mono ?? 0;
  const logs: string[] = [];
  const applied: LoadedCertificate[] = [];
  const loads = vi.fn(load);
  const provider = startReloader({
    initial,
    load: loads,
    signature: () => sig,
    apply: (c) => applied.push(c),
    ...(opts.accept ? { accept: opts.accept } : {}),
    now: () => wall,
    monotonic: () => mono,
    log: (m) => logs.push(m),
    timer: false
  });
  return {
    provider,
    loads,
    logs,
    applied,
    sign: (s: string) => (sig = s),
    at: (m: number) => (mono = m),
    wallAt: (w: number) => (wall = w),
    /** Two polls of a new signature: the second one makes the attempt. */
    change(s: string) {
      sig = s;
      provider.poll();
      provider.poll();
    }
  };
}

describe('mutation: initial state', () => {
  it('starts ok with no attempt and no error', () => {
    const r = drive(A, () => A);
    expect(r.provider.reload()).toEqual({ state: 'ok', lastAttempt: null, lastError: null });
  });

  it('records the wall time of an attempt', () => {
    const r = drive(A, () => B, { wall: 1234 });
    r.change('s1');
    expect(r.provider.reload().lastAttempt).toBe(1234);
  });
});

describe('mutation: retry interval', () => {
  it('is ten minutes', () => {
    expect(RETRY_MS).toBe(10 * MIN);
  });

  it('retries a refused change exactly RETRY_MS after the last attempt, not before', () => {
    const r = drive(A, () => {
      throw new Error('bad');
    });
    r.at(5 * MIN); // the attempt happens five minutes after start
    r.change('s1');
    expect(r.loads).toHaveBeenCalledTimes(1);
    r.at(6 * MIN);
    r.provider.poll();
    expect(r.loads).toHaveBeenCalledTimes(1);
    r.at(5 * MIN + RETRY_MS - 1);
    r.provider.poll();
    expect(r.loads).toHaveBeenCalledTimes(1);
    r.at(5 * MIN + RETRY_MS);
    r.provider.poll();
    expect(r.loads).toHaveBeenCalledTimes(2);
  });

  it('uses performance.now when neither clock is given', () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date'] });
    let sig = 's0';
    const load = vi.fn((): LoadedCertificate => {
      throw new Error('bad');
    });
    const provider = startReloader({
      initial: A,
      load,
      signature: () => sig,
      apply: () => {},
      timer: false
    });
    sig = 's1';
    provider.poll();
    provider.poll();
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RETRY_MS);
    provider.poll();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('mutation: log throttling', () => {
  it('logs the same failure again only after an hour, however often it is retried', () => {
    const r = drive(A, () => {
      throw new Error('bad');
    });
    r.change('s1');
    for (let m = 10; m < 60; m += 10) {
      r.at(m * MIN);
      r.provider.poll();
    }
    expect(r.loads).toHaveBeenCalledTimes(6);
    expect(r.logs.filter((l) => l.includes('bad'))).toHaveLength(1);
    r.at(60 * MIN - 1);
    r.provider.poll();
    expect(r.logs.filter((l) => l.includes('bad'))).toHaveLength(1);
    r.at(60 * MIN);
    r.provider.poll();
    expect(r.logs.filter((l) => l.includes('bad'))).toHaveLength(2);
  });

  it('logs a different failure at once', () => {
    let message = 'first';
    const r = drive(A, () => {
      throw new Error(message);
    });
    r.change('s1');
    message = 'second';
    r.change('s2');
    expect(r.logs).toEqual([
      'HTTPS certificate not reloaded: first',
      'HTTPS certificate not reloaded: second'
    ]);
  });

  it('measures the hour from the first log, not from the sum of both times', () => {
    const r = drive(A, () => {
      throw new Error('bad');
    });
    r.at(45 * MIN);
    r.change('s1');
    r.at(50 * MIN);
    r.change('s2');
    expect(r.logs.filter((l) => l.includes('bad'))).toHaveLength(1);
  });
});

describe('mutation: replacing an expired certificate', () => {
  const T = 1_000_000;
  const expired = { ...A, notBefore: 0, notAfter: T };
  const replacement = (over: Partial<LoadedCertificate>): LoadedCertificate => ({
    ...B_INCOMPLETE,
    notBefore: T - 10,
    notAfter: T + 10_000,
    ...over
  });
  const tryReplace = (candidate: LoadedCertificate, wall = T) => {
    const r = drive(expired, () => candidate, { wall });
    r.change('s1');
    return r;
  };

  it('replaces the moment the active certificate expires (notAfter itself is expired)', () => {
    const r = tryReplace(replacement({}));
    expect(r.applied).toHaveLength(1);
    // one millisecond earlier it is still in date, so a worse chain is refused
    const early = tryReplace(replacement({}), T - 1);
    expect(early.applied).toEqual([]);
    expect(early.provider.reload().state).toBe('failing');
  });

  it('replaces from the moment the candidate becomes valid, not before', () => {
    expect(tryReplace(replacement({ notBefore: T })).applied).toHaveLength(1);
    const notYet = tryReplace(replacement({ notBefore: T + 1 }));
    expect(notYet.applied).toEqual([]);
    expect(notYet.provider.reload().state).toBe('failing');
  });

  it('does not replace with a candidate that expires at that very moment', () => {
    expect(tryReplace(replacement({ notAfter: T + 1 })).applied).toHaveLength(1);
    const gone = tryReplace(replacement({ notAfter: T }));
    expect(gone.applied).toEqual([]);
    expect(gone.provider.reload().state).toBe('failing');
  });
});

describe('mutation: the poll timer', () => {
  const start = (extra: { timer?: boolean; pollMs?: number }) => {
    vi.useFakeTimers();
    const signature = vi.fn(() => 's');
    const provider = startReloader({
      initial: A,
      load: () => A,
      signature,
      apply: () => {},
      ...extra
    });
    return { provider, signature, base: signature.mock.calls.length };
  };

  it('polls every 60 s by default, and not before', () => {
    const t = start({});
    vi.advanceTimersByTime(59_999);
    expect(t.signature.mock.calls.length).toBe(t.base);
    vi.advanceTimersByTime(1);
    expect(t.signature.mock.calls.length).toBe(t.base + 1);
    vi.advanceTimersByTime(60_000);
    expect(t.signature.mock.calls.length).toBe(t.base + 2);
    t.provider.stop();
  });

  it('polls at the interval it is given', () => {
    const t = start({ pollMs: 1000 });
    vi.advanceTimersByTime(3000);
    expect(t.signature.mock.calls.length).toBe(t.base + 3);
    t.provider.stop();
  });

  it('starts a timer when timer is true, and none when it is false', () => {
    const on = start({ timer: true, pollMs: 1000 });
    vi.advanceTimersByTime(2000);
    expect(on.signature.mock.calls.length).toBe(on.base + 2);
    on.provider.stop();
    const off = start({ timer: false, pollMs: 1000 });
    vi.advanceTimersByTime(5000);
    expect(off.signature.mock.calls.length).toBe(off.base);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() ends the timer', () => {
    const t = start({ pollMs: 1000 });
    expect(vi.getTimerCount()).toBe(1);
    t.provider.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
