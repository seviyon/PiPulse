import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { AlertsPage } from '../src/alerts-page.js';
import type { Alert, Config } from '../src/types.js';

const NOW = 1_790_200_000_000;
const MIN = 60_000;
const config: Config = {
  device: { hostname: 'Io', platform: 'linux', arch: 'arm' },
  plugins: [{ id: 'cpu_temperature', label: 'CPU temperature', unit: '°C', intervalMs: 10_000 }],
  rules: [
    {
      id: 'cpu_hot',
      metric: 'cpu_temperature',
      atLeast: 80,
      forMs: 2 * MIN,
      clearAfterMs: 2 * MIN,
      severity: 'critical',
      message: 'CPU running hot',
      source: 'built-in'
    },
    {
      id: 'cpu_warm',
      metric: 'cpu_temperature',
      atLeast: 65,
      forMs: 5 * MIN,
      clearAfterMs: 5 * MIN,
      severity: 'warning',
      message: 'CPU running warm',
      source: 'file'
    }
  ]
};
const alert = (over: Partial<Alert>): Alert => ({
  id: 1,
  ruleId: 'cpu_hot',
  metric: 'cpu_temperature',
  severity: 'critical',
  message: 'CPU running hot',
  value: 82,
  raisedAt: NOW - 12 * MIN,
  clearedAt: null,
  clearedBy: null,
  ...over
});

let history: Alert[];
let root: HTMLElement;
beforeEach(() => {
  history = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(history))
  );
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(root.textContent).not.toContain('Loading');
  });
}
const section = (name: string) =>
  [...root.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === name)!;

describe('<AlertsPage>', () => {
  it('lists open alerts with severity in words, value, since and duration, and a History link', async () => {
    render(<AlertsPage config={config} open={[alert({})]} now={() => NOW} />, root);
    await settle();
    const open = section('Open').textContent ?? '';
    expect(open).toContain('Critical');
    expect(open).toContain('CPU running hot');
    expect(open).toContain('82 °C');
    expect(open).toContain('12 min');
    expect(section('Open').querySelector('a')?.getAttribute('href')).toBe('#/history?range=1h');
  });

  it('says so when nothing is open', async () => {
    render(<AlertsPage config={config} open={[]} now={() => NOW} />, root);
    await settle();
    expect(section('Open').textContent).toContain('No open alerts');
  });

  it('shows cleared alerts from the last 30 days, marking ones closed by a removed rule', async () => {
    history = [
      alert({ id: 2, clearedAt: NOW - 2 * MIN, clearedBy: 'condition' }),
      alert({
        id: 3,
        severity: 'warning',
        message: 'Old rule',
        clearedAt: NOW - MIN,
        clearedBy: 'rule_removed'
      }),
      alert({ id: 4 })
    ];
    render(<AlertsPage config={config} open={[alert({ id: 4 })]} now={() => NOW} />, root);
    await settle();
    const recent = section('Recent').textContent ?? '';
    expect(recent).toContain('(10 min)');
    expect(recent).toContain('rule removed');
    expect(section('Recent').querySelectorAll('li')).toHaveLength(2);
    const url = new URL(String(vi.mocked(fetch).mock.calls[0]![0]), 'http://io.lan');
    expect(url.pathname).toBe('/api/alerts');
    expect(url.searchParams.get('from')).toBe(String(NOW - 30 * 24 * 60 * MIN));
  });

  it('refetches the history when the open alerts change', async () => {
    render(<AlertsPage config={config} open={[alert({})]} now={() => NOW} />, root);
    await settle();
    render(<AlertsPage config={config} open={[]} now={() => NOW} />, root);
    await settle();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('lists the effective rules with their source and where to edit them', async () => {
    render(<AlertsPage config={config} open={[]} now={() => NOW} />, root);
    await settle();
    const rules = section('Rules').textContent ?? '';
    expect(rules).toContain('CPU temperature ≥ 80 °C for 2 min');
    expect(rules).toContain('built-in');
    expect(rules).toContain('file');
    expect(rules).toContain('PIPULSE_ALERTS_FILE');
  });

  it('explains a failed history load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 }))
    );
    render(<AlertsPage config={config} open={[]} now={() => NOW} />, root);
    await settle();
    expect(section('Recent').textContent).toContain("Couldn't load");
  });
});
