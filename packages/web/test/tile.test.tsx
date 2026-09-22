import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { Tile } from '../src/tile.js';

const plugin = { id: 'cpu_temperature', label: 'CPU temperature', unit: '°C', intervalMs: 10_000 };
const root = document.createElement('div');

afterEach(() => render(null, root));

function renderWaiting(waitedMs: number) {
  render(
    <Tile
      plugin={plugin}
      latest={undefined}
      series={[]}
      now={1_000_000 + waitedMs}
      waitingSince={1_000_000}
      windowMs={900_000}
    />,
    root
  );
  return root.textContent;
}

describe('<Tile> without a reading', () => {
  it('waits quietly for the first few polls', () => {
    expect(renderWaiting(20_000)).toContain('Waiting for the first reading');
  });

  it('says the sensor may be missing once three polls pass with nothing', () => {
    expect(renderWaiting(31_000)).toContain(
      'No readings yet. This device may not have this sensor.'
    );
  });
});
