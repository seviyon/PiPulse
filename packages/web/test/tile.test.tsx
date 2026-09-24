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
      rules={[]}
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

describe('<Tile> for throttle flags', () => {
  it('shows the decoded state with no meter or sparkline', () => {
    const throttled = { id: 'throttled', label: 'Throttling', unit: 'flags', intervalMs: 10_000 };
    const now = 1_000_000;
    const series = [0, 5000].map((ago) => ({ ts: now - ago, metric: 'throttled', value: 0 }));
    render(
      <Tile
        plugin={throttled}
        latest={series[1]}
        series={series}
        now={now}
        waitingSince={now}
        rules={[]}
        windowMs={900_000}
      />,
      root
    );
    expect(root.textContent).toContain('None');
    expect(root.querySelector('[role="meter"]')).toBeNull();
    expect(root.querySelector('.spark')).toBeNull();
  });
});

describe('<Tile> meter', () => {
  it('uses the max it is given, e.g. memory against the device total', () => {
    const memory = { id: 'memory_used', label: 'Memory used', unit: 'MB', intervalMs: 5000 };
    const now = 1_000_000;
    render(
      <Tile
        plugin={memory}
        latest={{ ts: now, metric: 'memory_used', value: 246.57 }}
        series={[]}
        now={now}
        waitingSince={now}
        rules={[]}
        windowMs={900_000}
        max={971.52}
      />,
      root
    );
    expect(root.querySelector('[role="meter"]')?.getAttribute('aria-valuemax')).toBe('971.52');
    expect(root.textContent).toContain('25% of 972 MB');
  });

  it('does not express a temperature as a percentage of its meter maximum', () => {
    const temperature = {
      id: 'cpu_temperature',
      label: 'CPU temperature',
      unit: '°C',
      intervalMs: 10000
    };
    const now = 1_000_000;
    render(
      <Tile
        plugin={temperature}
        latest={{ ts: now, metric: 'cpu_temperature', value: 49.4 }}
        series={[]}
        now={now}
        waitingSince={now}
        rules={[]}
        windowMs={900_000}
        max={85}
      />,
      root
    );
    expect(root.querySelector('[role="meter"]')).not.toBeNull();
    expect(root.textContent).not.toContain('% of');
  });
});

describe('<Tile> alerts', () => {
  const temperature = {
    id: 'cpu_temperature',
    label: 'CPU temperature',
    unit: '°C',
    intervalMs: 10_000
  };
  const hot = {
    id: 'cpu_hot',
    metric: 'cpu_temperature',
    atLeast: 80,
    forMs: 120_000,
    clearAfterMs: 120_000,
    severity: 'critical' as const,
    message: 'CPU running hot',
    source: 'built-in' as const
  };

  it('colours from the rules and names the open alert with how long it has been open', () => {
    const now = 1_790_000_000_000;
    render(
      <Tile
        plugin={temperature}
        rules={[hot]}
        alert={{
          id: 1,
          ruleId: 'cpu_hot',
          metric: 'cpu_temperature',
          severity: 'critical',
          message: 'CPU running hot',
          value: 82,
          raisedAt: now - 12 * 60_000,
          clearedAt: null,
          clearedBy: null
        }}
        latest={{ ts: now, metric: 'cpu_temperature', value: 82 }}
        series={[]}
        now={now}
        waitingSince={now}
        windowMs={900_000}
      />,
      root
    );
    expect(root.querySelector('section')?.dataset['status']).toBe('critical');
    expect(root.textContent).toContain('CPU running hot');
    expect(root.textContent).toMatch(/Alert since .+ \(12 min\)/);
  });

  it('mutes an acknowledged alert but still names it, never by colour alone', () => {
    const now = 1_790_000_000_000;
    const MIN = 60_000;
    render(
      <Tile
        plugin={temperature}
        rules={[hot]}
        alert={{
          id: 1,
          ruleId: 'cpu_hot',
          metric: 'cpu_temperature',
          severity: 'critical',
          message: 'CPU running hot',
          value: 82,
          raisedAt: now - 12 * 60_000,
          clearedAt: null,
          clearedBy: null,
          acknowledgedAt: now - MIN
        }}
        latest={{ ts: now, metric: 'cpu_temperature', value: 82 }}
        series={[]}
        now={now}
        waitingSince={now}
        windowMs={900_000}
      />,
      root
    );
    const line = root.querySelector('.alert-line')!;
    expect(line.getAttribute('data-acknowledged')).toBe('true');
    expect(line.textContent).toContain('acknowledged');
  });
});
