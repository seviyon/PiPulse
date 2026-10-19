import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import {
  ANCHOR_FILE,
  ANCHOR_HOLD_MS,
  ANCHOR_TOLERANCE_MS,
  aheadText,
  judgeClock,
  readAnchor,
  writeAnchor,
  type Anchor
} from '../../src/ca/clock-anchor.js';
import { paths, readRenewStatus } from '../../src/ca/layout.js';
import { NOW, testContext, type TestContext } from '../cli-context.js';
import { tempDir } from '../helpers.js';

const MIN = 60_000;
const DAY = 86_400_000;
const anchor = (over: Partial<Anchor> = {}): Anchor => ({
  version: 1,
  bootId: 'boot-a',
  offsetMs: 1_000_000,
  ...over
});
const at = (offsetMs: number, uptimeMs = 3_600_000, bootId = 'boot-a') => ({
  bootId,
  offsetMs,
  uptimeMs
});

describe('judgeClock', () => {
  it('starts an anchor on a first run and after a reboot', () => {
    expect(judgeClock(undefined, at(5))).toEqual({
      ok: true,
      next: { version: 1, bootId: 'boot-a', offsetMs: 5 }
    });
    expect(judgeClock(anchor(), at(77, 0, 'boot-b'))).toEqual({
      ok: true,
      next: { version: 1, bootId: 'boot-b', offsetMs: 77 }
    });
  });

  it('a steady clock changes nothing and writes nothing', () => {
    expect(judgeClock(anchor(), at(1_000_000 + 30_000))).toEqual({ ok: true });
    expect(judgeClock(anchor(), at(1_000_000 - 30_000))).toEqual({ ok: true });
  });

  it('follows a slow drift or a step back, and writes it', () => {
    expect(judgeClock(anchor(), at(1_000_000 + 5 * MIN))).toEqual({
      ok: true,
      next: { version: 1, bootId: 'boot-a', offsetMs: 1_000_000 + 5 * MIN }
    });
    expect(judgeClock(anchor(), at(1_000_000 - 3 * DAY))).toMatchObject({ ok: true });
  });

  it('a forward step is doubted, and remembered with when it was first seen', () => {
    const verdict = judgeClock(anchor(), at(1_000_000 + 2 * DAY, 7_200_000));
    expect(verdict).toEqual({
      ok: false,
      aheadMs: 2 * DAY,
      heldMs: 0,
      next: {
        ...anchor(),
        candidate: { offsetMs: 1_000_000 + 2 * DAY, uptimeMs: 7_200_000 }
      }
    });
  });

  it('is still doubted until it has held long enough, and keeps the first sighting', () => {
    const first = { offsetMs: 1_000_000 + 2 * DAY, uptimeMs: 7_200_000 };
    const verdict = judgeClock(
      anchor({ candidate: first }),
      at(1_000_000 + 2 * DAY + 20_000, 7_200_000 + 10 * MIN)
    );
    expect(verdict).toEqual({ ok: false, aheadMs: 2 * DAY + 20_000, heldMs: 10 * MIN });
  });

  it('is believed once the same step has held for ANCHOR_HOLD_MS', () => {
    const first = { offsetMs: 1_000_000 + 2 * DAY, uptimeMs: 7_200_000 };
    const verdict = judgeClock(
      anchor({ candidate: first }),
      at(1_000_000 + 2 * DAY + 20_000, 7_200_000 + ANCHOR_HOLD_MS)
    );
    expect(verdict).toEqual({
      ok: true,
      next: { version: 1, bootId: 'boot-a', offsetMs: 1_000_000 + 2 * DAY + 20_000 }
    });
  });

  it('a different step restarts the doubt instead of inheriting the old one', () => {
    const first = { offsetMs: 1_000_000 + 2 * DAY, uptimeMs: 7_200_000 };
    const verdict = judgeClock(
      anchor({ candidate: first }),
      at(1_000_000 + 5 * DAY, 7_200_000 + 2 * 3_600_000)
    );
    expect(verdict).toMatchObject({
      ok: false,
      heldMs: 0,
      next: { candidate: { offsetMs: 1_000_000 + 5 * DAY, uptimeMs: 7_200_000 + 7_200_000 } }
    });
  });

  it('a clock that came back drops the doubt', () => {
    const first = { offsetMs: 1_000_000 + 2 * DAY, uptimeMs: 7_200_000 };
    expect(judgeClock(anchor({ candidate: first }), at(1_000_000 + 1000))).toEqual({
      ok: true,
      next: { version: 1, bootId: 'boot-a', offsetMs: 1_000_000 + 1000 }
    });
  });

  it('the tolerance is exactly ANCHOR_TOLERANCE_MS', () => {
    expect(judgeClock(anchor(), at(1_000_000 + ANCHOR_TOLERANCE_MS))).toMatchObject({ ok: true });
    expect(judgeClock(anchor(), at(1_000_000 + ANCHOR_TOLERANCE_MS + 1))).toMatchObject({
      ok: false
    });
  });
});

describe('the stored anchor', () => {
  let dir: string;
  let ctx: TestContext;
  beforeEach(() => {
    dir = tempDir();
    ctx = testContext(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips, and a missing, damaged or foreign file is no anchor', () => {
    expect(readAnchor(ctx.layout)).toBeUndefined();
    const stored = anchor({ candidate: { offsetMs: 9, uptimeMs: 8 } });
    writeAnchor(ctx.layout, stored);
    expect(readAnchor(ctx.layout)).toEqual(stored);
    const file = join(dir, ANCHOR_FILE);
    for (const text of [
      'not json',
      'null',
      '[]',
      '{"version":2,"bootId":"x","offsetMs":1}',
      '{"version":1,"bootId":5,"offsetMs":1}',
      '{"version":1,"bootId":"x","offsetMs":"1"}',
      '{"version":1,"bootId":"x","offsetMs":1,"candidate":"yes"}',
      '{"version":1,"bootId":"x","offsetMs":1,"candidate":null}',
      '{"version":1,"bootId":"x","offsetMs":1,"candidate":{"offsetMs":1}}'
    ]) {
      writeFileSync(file, text);
      expect(readAnchor(ctx.layout)).toBeUndefined();
    }
  });
});

describe('aheadText', () => {
  it('speaks in minutes, hours, then days', () => {
    expect(aheadText(15 * MIN)).toBe('15 min');
    expect(aheadText(5 * 3_600_000)).toBe('5 h');
    expect(aheadText(3 * DAY)).toBe('3 d');
  });
});

describe('renew and a clock that stepped ahead', () => {
  let dir: string;
  let ctx: TestContext;
  let uptime = 3_600_000;
  const withClock = (extra: Partial<Parameters<typeof testContext>[1]> = {}) =>
    testContext(dir, { uptime: () => uptime, bootId: () => 'boot-1', ...extra });
  const status = () => readRenewStatus(paths(ctx.layout).renewStatus);
  const leaf = () => readFileSync(paths(ctx.layout).leafCrt, 'utf8');
  beforeEach(async () => {
    dir = tempDir();
    uptime = 3_600_000;
    ctx = testContext(dir);
    expect(await main(['init'], ctx)).toBe(0);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a steady clock leaves renewal as it was, and starts an anchor', async () => {
    const run = withClock();
    expect(await main(['renew'], run)).toBe(0);
    expect(status()?.result).toBe('not-due');
    expect(readAnchor(run.layout)).toMatchObject({ bootId: 'boot-1' });
  });

  it('does not issue on a clock that just stepped days ahead, then does once it has held', async () => {
    // an anchor from an hour ago, when the wall clock read NOW
    expect(await main(['renew'], withClock())).toBe(0);
    const before = leaf();
    // the clock jumps 70 days ahead: the leaf (valid ~90 days) is now due, but the step is not believed yet
    const later = withClock();
    uptime += 3_600_000;
    later.setNow(NOW + 70 * DAY);
    expect(await main(['renew'], later)).toBe(0);
    expect(status()?.result).toBe('waiting-clock');
    expect(status()?.reason).toMatch(/stepped ahead by 70 d/);
    expect(later.lines.join('\n')).toContain('waiting: the clock stepped ahead');
    expect(leaf()).toBe(before);
    expect(readAnchor(later.layout)?.candidate).toBeDefined();
    // not long enough yet
    uptime += 10 * MIN;
    const soon = withClock();
    soon.setNow(NOW + 70 * DAY + 10 * MIN);
    expect(await main(['renew'], soon)).toBe(0);
    expect(status()?.result).toBe('waiting-clock');
    expect(leaf()).toBe(before);
    // it held for the hour: believed, and the due renewal goes ahead
    uptime += 50 * MIN;
    const held = withClock();
    held.setNow(NOW + 70 * DAY + 60 * MIN);
    expect(await main(['renew'], held)).toBe(0);
    expect(status()?.result).toBe('renewed');
    expect(leaf()).not.toBe(before);
    expect(readAnchor(held.layout)?.candidate).toBeUndefined();
  });

  it('--force issues anyway (an operator is present)', async () => {
    expect(await main(['renew'], withClock())).toBe(0);
    const before = leaf();
    const later = withClock();
    later.setNow(NOW + 70 * DAY);
    uptime += 3_600_000;
    expect(await main(['renew', '--force'], later)).toBe(0);
    expect(status()?.result).toBe('renewed');
    expect(leaf()).not.toBe(before);
  });

  it('a clock that stepped ahead but nothing is due changes nothing visible', async () => {
    expect(await main(['renew'], withClock())).toBe(0);
    const later = withClock();
    later.setNow(NOW + 2 * DAY);
    uptime += 3_600_000;
    expect(await main(['renew'], later)).toBe(0);
    expect(status()?.result).toBe('not-due');
  });

  it('a new boot starts afresh, so a clock set right after boot is not doubted', async () => {
    expect(await main(['renew'], withClock())).toBe(0);
    const later = testContext(dir, { uptime: () => 5 * MIN, bootId: () => 'boot-2' });
    later.setNow(NOW + 70 * DAY);
    expect(await main(['renew'], later)).toBe(0);
    expect(status()?.result).toBe('renewed');
  });

  it('is off without the boot clock (other callers keep the old behaviour)', async () => {
    const plain = testContext(dir);
    plain.setNow(NOW + 70 * DAY);
    expect(await main(['renew'], plain)).toBe(0);
    expect(status()?.result).toBe('renewed');
    expect(existsSync(join(dir, ANCHOR_FILE))).toBe(false);
  });

  it('only warns when the anchor cannot be written, and still renews', async () => {
    const run = withClock();
    rmSync(join(dir, ANCHOR_FILE), { force: true });
    // a directory where the file goes: the atomic rename fails
    mkdirSync(join(dir, ANCHOR_FILE));
    expect(await main(['renew'], run)).toBe(0);
    expect(run.errors.join('\n')).toContain('warning: could not write clock-anchor.json');
  });
});
