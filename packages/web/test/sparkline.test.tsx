import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'preact/test-utils';
import { render } from 'preact';
import { Sparkline } from '../src/sparkline.js';

const END = 1_800_000_000_000;
const WINDOW = 900_000;
const root = document.createElement('div');
afterEach(() => render(null, root));

const series = [
  { ts: END - WINDOW, value: 40 },
  { ts: END - WINDOW / 2, value: 55 },
  { ts: END, value: 70 }
];
const show = (data = series) =>
  render(
    <Sparkline series={data} unit="°C" label="CPU temperature" end={END} windowMs={WINDOW} />,
    root
  );

/** A pointer event at `fraction` across the 300 px wide sparkline. */
async function point(type: string, fraction: number) {
  const spark = root.querySelector('.spark') as HTMLElement;
  spark.getBoundingClientRect = () => ({ left: 0, width: 300 }) as DOMRect;
  await act(() => {
    spark.dispatchEvent(
      Object.assign(new Event(type, { bubbles: true }), { clientX: fraction * 300 })
    );
  });
}
const tip = () => root.querySelector('.tip') as HTMLElement | null;

describe('<Sparkline>', () => {
  it('draws nothing for fewer than two readings', () => {
    show([series[0]!]);
    expect(root.innerHTML).toBe('');
  });

  it('describes the range for a screen reader', () => {
    show();
    expect(root.querySelector('[role=img]')?.getAttribute('aria-label')).toMatch(
      /CPU temperature over the last 15 minutes: low 40.* °C, high 70.* °C/
    );
  });

  it('shows the nearest reading under the pointer and forgets it on leave', async () => {
    show();
    expect(tip()).toBeNull();
    await point('pointermove', 0.52);
    expect(tip()?.textContent).toContain('55');
    expect(root.querySelector('.cursor')).not.toBeNull();
    await point('pointerleave', 0);
    expect(tip()).toBeNull();
  });

  it('also reads on touch (pointerdown)', async () => {
    show();
    await point('pointerdown', 1);
    expect(tip()?.textContent).toContain('70');
  });

  it('keeps the readout inside the tile near either edge', async () => {
    show();
    await point('pointermove', 0);
    expect(tip()?.style.transform).toBe('translateX(-10%)');
    await point('pointermove', 0.5);
    expect(tip()?.style.transform).toBe('translateX(-50%)');
    await point('pointermove', 1);
    expect(tip()?.style.transform).toBe('translateX(-90%)');
  });
});
