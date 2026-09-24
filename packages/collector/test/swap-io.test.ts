import { describe, expect, it } from 'vitest';
import { createSwapIoPlugin, swapPages } from '../src/index.js';

const vmstat = (pswpin: number, pswpout: number) =>
  `nr_free_pages 1234\npswpin ${pswpin}\npswpout ${pswpout}\npgfault 99\n`;

function plugin(texts: (string | null)[], times: number[]) {
  return createSwapIoPlugin({
    read: async () => texts.shift() ?? null,
    now: () => times.shift()!
  });
}

describe('swapPages', () => {
  it('adds pages swapped in and out since boot', () => {
    expect(swapPages(vmstat(100, 50))).toBe(150);
  });
  it('is null when a counter is missing', () => {
    expect(swapPages('pswpin 5\n')).toBeNull();
  });
});

describe('swap_io', () => {
  it('reports pages/s between two polls, null on the first', async () => {
    const p = plugin([vmstat(100, 0), vmstat(300, 300)], [0, 10_000]);
    expect(await p.collect()).toBeNull();
    expect(await p.collect()).toBe(50);
  });

  it('is null after a counter goes backwards, then measures from there', async () => {
    const p = plugin([vmstat(500, 0), vmstat(10, 0), vmstat(30, 0)], [0, 10_000, 20_000]);
    await p.collect();
    expect(await p.collect()).toBeNull();
    expect(await p.collect()).toBe(2);
  });

  it('is null where /proc/vmstat is missing', async () => {
    const p = plugin([null, null], [0, 10_000]);
    expect(await p.collect()).toBeNull();
    expect(await p.collect()).toBeNull();
  });
});
