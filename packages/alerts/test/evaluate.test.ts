import { describe, expect, it } from 'vitest';
import {
  EMPTY_WINDOW,
  evaluate,
  type CheckInput,
  type Rule,
  type WindowSummary
} from '../src/index.js';

const MIN = 60_000;
const NOW = 1_000_000_000;
const I = 10_000; // poll interval

const hot: Rule = {
  id: 'cpu_hot',
  metric: 'cpu_temperature',
  atLeast: 80,
  forMs: 2 * MIN,
  clearAfterMs: 2 * MIN,
  severity: 'critical',
  message: 'CPU running hot',
  source: 'built-in'
};
const bits: Rule = {
  id: 'throttled_now',
  metric: 'throttled',
  bitsSet: 0xf,
  forMs: MIN,
  clearAfterMs: MIN,
  severity: 'critical',
  message: 'Throttling now',
  source: 'built-in'
};
const since: Rule = {
  ...bits,
  id: 'throttled_before',
  bitsSet: 0xf0000,
  forMs: 0,
  clearAfterMs: 0
};
const silent: Rule = {
  id: 'not_collecting',
  metric: '*',
  noReadingFor: 'auto',
  forMs: 0,
  clearAfterMs: 0,
  severity: 'warning',
  message: 'No new readings',
  source: 'built-in'
};

/** Readings every poll across [NOW - span, NOW] with the given min/max. */
function covering(span: number, min: number, max: number, withBits = 0): WindowSummary {
  return { count: span / I + 1, oldest: NOW - span, newest: NOW, min, max, withBits, maxGap: I };
}

const input = (over: Partial<CheckInput>): CheckInput => ({
  now: NOW,
  since: NOW - 3_600_000,
  intervalMs: I,
  open: false,
  latest: { ts: NOW, value: 0 },
  window: EMPTY_WINDOW,
  ...over
});

describe('rules with no `for` or `clearAfter`', () => {
  const instant = { ...hot, forMs: 0, clearAfterMs: 0 };
  const high: Rule = instant;
  const { atLeast: _atLeast, ...rest } = instant;
  const low: Rule = { ...rest, atMost: 5 };

  it.each([
    ['at least, on the limit', high, 80, true],
    ['at least, above it', high, 81, true],
    ['at least, below it', high, 79, false],
    ['at most, on the limit', low, 5, true],
    ['at most, below it', low, 4, true],
    ['at most, above it', low, 6, false]
  ] as const)('decide on the newest reading: %s', (_name, rule, value, breached) => {
    const latest = { ts: NOW, value };
    expect(evaluate(rule, input({ latest }))).toEqual(
      breached ? { action: 'raise', value } : { action: 'none' }
    );
    expect(evaluate(rule, input({ latest, open: true }))).toEqual({
      action: breached ? 'none' : 'clear'
    });
  });

  it('believe a reading two polls old and nothing older, or nothing at all', () => {
    const aged = (age: number) => input({ latest: { ts: NOW - age, value: 90 } });
    expect(evaluate(high, aged(2 * I))).toEqual({ action: 'raise', value: 90 });
    expect(evaluate(high, aged(2 * I + 1))).toEqual({ action: 'none' });
    expect(evaluate(high, input({ latest: null, open: true }))).toEqual({ action: 'none' });
  });
});

describe('threshold rules', () => {
  it('raise once every reading over `for` is at or past the threshold', () => {
    expect(
      evaluate(hot, input({ latest: { ts: NOW, value: 82 }, window: covering(2 * MIN, 80, 85) }))
    ).toEqual({ action: 'raise', value: 82 });
  });

  it('do not raise while any reading in the window is below it', () => {
    expect(evaluate(hot, input({ window: covering(2 * MIN, 79.9, 85) }))).toEqual({
      action: 'none'
    });
  });

  it('decide nothing until readings cover the whole window (just started)', () => {
    const young = { count: 3, oldest: NOW - 20_000, newest: NOW, min: 90, max: 90, withBits: 0 };
    expect(evaluate(hot, input({ window: young }))).toEqual({ action: 'none' });
  });

  it('decide nothing when the newest reading is stale (collection stopped)', () => {
    const stale = {
      count: 10,
      oldest: NOW - 2 * MIN,
      newest: NOW - 60_000,
      min: 90,
      max: 90,
      withBits: 0
    };
    expect(evaluate(hot, input({ window: stale }))).toEqual({ action: 'none' });
  });

  it('clear once no reading over `clearAfter` is at or past the threshold', () => {
    expect(evaluate(hot, input({ open: true, window: covering(2 * MIN, 60, 79) }))).toEqual({
      action: 'clear'
    });
  });

  it('stay open while a single reading in the clear window still breaches (no flapping)', () => {
    expect(evaluate(hot, input({ open: true, window: covering(2 * MIN, 60, 80) }))).toEqual({
      action: 'none'
    });
  });

  it('never clear across a collection gap', () => {
    expect(evaluate(hot, input({ open: true, window: EMPTY_WINDOW }))).toEqual({ action: 'none' });
  });

  it('decide nothing across a gap in the middle of the window', () => {
    const gappy = { ...covering(2 * MIN, 60, 70), maxGap: 4 * I };
    expect(evaluate(hot, input({ open: true, window: gappy }))).toEqual({ action: 'none' });
    expect(evaluate(hot, input({ window: { ...gappy, min: 80, max: 85 } }))).toEqual({
      action: 'none'
    });
  });

  it('tolerate a couple of missed polls in a row', () => {
    const skipped = { ...covering(2 * MIN, 60, 70), maxGap: 3 * I };
    expect(evaluate(hot, input({ open: true, window: skipped }))).toEqual({ action: 'clear' });
  });

  it('handle atMost symmetrically', () => {
    const low: Rule = {
      id: 'cold',
      metric: 'cpu_temperature',
      atMost: 5,
      forMs: 2 * MIN,
      clearAfterMs: 2 * MIN,
      severity: 'warning',
      message: 'Cold',
      source: 'file'
    };
    expect(evaluate(low, input({ window: covering(2 * MIN, 1, 5) }))).toMatchObject({
      action: 'raise'
    });
    expect(evaluate(low, input({ open: true, window: covering(2 * MIN, 6, 9) }))).toEqual({
      action: 'clear'
    });
  });
});

describe('bit rules', () => {
  it('raise when every reading has one of the bits, clear when none has', () => {
    expect(evaluate(bits, input({ window: covering(MIN, 0, 5, 7) }))).toMatchObject({
      action: 'raise'
    });
    expect(evaluate(bits, input({ window: covering(MIN, 0, 5, 6) }))).toEqual({ action: 'none' });
    expect(evaluate(bits, input({ open: true, window: covering(MIN, 0, 0, 0) }))).toEqual({
      action: 'clear'
    });
  });

  it('with a zero window, let the newest current reading decide: since-boot bits clear only after a reboot', () => {
    expect(evaluate(since, input({ latest: { ts: NOW, value: 0x50000 } }))).toMatchObject({
      action: 'raise'
    });
    expect(evaluate(since, input({ open: true, latest: { ts: NOW, value: 0x50000 } }))).toEqual({
      action: 'none'
    });
    expect(evaluate(since, input({ open: true, latest: { ts: NOW, value: 0 } }))).toEqual({
      action: 'clear'
    });
    expect(evaluate(since, input({ latest: { ts: NOW - MIN, value: 0x50000 } }))).toEqual({
      action: 'none'
    });
  });
});

describe('silence rules', () => {
  it('raise after 5 polls (at least 2 minutes) without a reading, counted from the later of reading and start', () => {
    const latest = { ts: NOW - 3 * MIN, value: 1 };
    expect(evaluate(silent, input({ latest }))).toEqual({ action: 'raise', value: null });
    expect(evaluate(silent, input({ latest, since: NOW - MIN }))).toEqual({ action: 'none' });
    expect(evaluate(silent, input({ latest: { ts: NOW - 90_000, value: 1 } }))).toEqual({
      action: 'none'
    });
  });

  it('use five poll intervals when that is longer than 2 minutes', () => {
    const latest = { ts: NOW - 4 * MIN, value: 1 };
    expect(evaluate(silent, input({ intervalMs: MIN, latest }))).toEqual({ action: 'none' });
    expect(
      evaluate(silent, input({ intervalMs: MIN, latest: { ts: NOW - 6 * MIN, value: 1 } }))
    ).toMatchObject({ action: 'raise' });
  });

  it('ignore a metric this host never collected', () => {
    expect(evaluate(silent, input({ latest: null }))).toEqual({ action: 'none' });
  });

  it('clear as soon as a reading arrives', () => {
    expect(evaluate(silent, input({ open: true, latest: { ts: NOW - 5_000, value: 1 } }))).toEqual({
      action: 'clear'
    });
  });
});
