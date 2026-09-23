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

/**
 * Waits for `fetch` to have been called `n` times, flushing Preact's
 * deferred effects (via `act`) on every poll. Unlike `settle()`, this
 * doesn't look at the DOM, so it's the right wait for a refetch that
 * deliberately keeps stale content on screen instead of blanking to
 * "Loading".
 */
async function waitForFetchCalls(n: number) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(n);
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
      })
    ];
    render(<AlertsPage config={config} open={[alert({ id: 4 })]} now={() => NOW} />, root);
    await settle();
    const recent = section('Recent').textContent ?? '';
    expect(recent).toContain('(10 min)');
    expect(recent).toContain('rule removed');
    expect(section('Recent').querySelectorAll('li')).toHaveLength(2);
    const url = new URL(String(vi.mocked(fetch).mock.calls[0]![0]), 'http://io.lan');
    expect(url.pathname).toBe('/api/alerts');
    expect(url.searchParams.get('state')).toBe('cleared');
    expect(url.searchParams.get('from')).toBe(String(NOW - 30 * 24 * 60 * MIN));
    expect(recent).not.toContain('newest');
  });

  it('says the Recent list is cut short when the server returns a full page', async () => {
    const url = () => new URL(String(vi.mocked(fetch).mock.calls[0]![0]), 'http://io.lan');
    render(<AlertsPage config={config} open={[]} now={() => NOW} />, root);
    await settle();
    const limit = Number(url().searchParams.get('limit'));
    render(null, root);
    vi.mocked(fetch).mockClear();
    history = Array.from({ length: limit }, (_, i) =>
      alert({
        id: i + 1,
        raisedAt: NOW - (i + 2) * MIN,
        clearedAt: NOW - (i + 1) * MIN,
        clearedBy: 'condition'
      })
    );
    render(<AlertsPage config={config} open={[]} now={() => NOW} />, root);
    await settle();
    expect(section('Recent').textContent).toContain(`Showing the newest ${limit}`);
  });

  it('refetches the history when the open alerts change', async () => {
    render(<AlertsPage config={config} open={[alert({})]} now={() => NOW} />, root);
    await settle();
    render(<AlertsPage config={config} open={[]} now={() => NOW} />, root);
    await waitForFetchCalls(2);
  });

  it('keeps the Recent list on screen (no flicker back to "Loading") while a refetch triggered by an open-set change is in flight', async () => {
    const firstAlerts = [
      alert({ id: 5, message: 'Stale entry', clearedAt: NOW - MIN, clearedBy: 'condition' })
    ];
    let resolveSecond!: (response: Response) => void;
    const secondResponse = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? Response.json(firstAlerts) : secondResponse;
      })
    );

    render(<AlertsPage config={config} open={[alert({})]} now={() => NOW} />, root);
    await settle();
    expect(section('Recent').textContent).toContain('Stale entry');

    // Change the open set: this triggers a refetch (fetch call #2), which we
    // deliberately leave unresolved to inspect the screen mid-flight.
    render(<AlertsPage config={config} open={[]} now={() => NOW} />, root);
    await waitForFetchCalls(2);

    expect(root.textContent).not.toContain('Loading');
    expect(section('Recent').textContent).toContain('Stale entry');

    await act(async () => {
      resolveSecond(Response.json([]));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
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
