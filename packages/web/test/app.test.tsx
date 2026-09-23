import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('uplot', () => ({
  default: class {
    setData() {}
    setSize() {}
    destroy() {}
  }
}));

import { render } from 'preact';
import { act } from 'preact/test-utils';
import { App } from '../src/app.js';
import type { Config, LiveMessage, Sample } from '../src/types.js';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  close() {}
}

const config: Config = {
  device: {
    hostname: 'Io',
    platform: 'linux',
    arch: 'arm',
    model: 'Raspberry Pi 3 Model B Rev 1.2',
    os: 'Raspbian GNU/Linux 11 (bullseye)',
    kernel: '6.1.21-v7+',
    memoryTotalMb: 971.52
  },
  uptimeMs: 16 * 86_400_000 + 11 * 3_600_000 + 30 * 60_000,
  plugins: [
    { id: 'cpu_load', label: 'CPU load', unit: '%', intervalMs: 5000 },
    { id: 'cpu_temperature', label: 'CPU temperature', unit: '°C', intervalMs: 10000 },
    { id: 'network_rx', label: 'Network received', unit: 'B/s', intervalMs: 5000 },
    { id: 'load_1', label: 'Load (1 min)', unit: '', intervalMs: 30000 }
  ],
  rules: [
    {
      id: 'cpu_warm',
      metric: 'cpu_temperature',
      atLeast: 70,
      forMs: 600_000,
      clearAfterMs: 600_000,
      severity: 'warning',
      message: 'CPU running warm',
      source: 'built-in'
    },
    {
      id: 'cpu_hot',
      metric: 'cpu_temperature',
      atLeast: 80,
      forMs: 120_000,
      clearAfterMs: 120_000,
      severity: 'critical',
      message: 'CPU running hot',
      source: 'built-in'
    }
  ]
};

const NOW = 1_790_109_000_000;
let history: Record<string, Sample[]>;
/** What the fake server reports as its clock; tests skew it against the browser's NOW. */
let serverTime: number;
let root: HTMLElement;

/** Lets pending fetch() → response.json() → setState chains settle and Preact re-render. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Retries `assertion` until it passes. happy-dom's Response.json() goes
 * through its stream machinery, which takes an unpredictable number of ticks.
 */
async function eventually(assertion: () => void, timeout = 1000) {
  await vi.waitFor(
    async () => {
      await flush();
      assertion();
    },
    { timeout }
  );
}

async function send(message: LiveMessage) {
  await act(() => {
    FakeSocket.instances.at(-1)!.onmessage?.({ data: JSON.stringify(message) });
  });
}

function tile(label: string): HTMLElement {
  const heading = [...root.querySelectorAll('h2')].find((h) => h.textContent === label);
  if (!heading) throw new Error(`no tile titled "${label}"`);
  return heading.closest('section')!;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  FakeSocket.instances = [];
  serverTime = NOW;
  history = {
    cpu_load: [
      { ts: NOW - 10_000, metric: 'cpu_load', value: 1.2 },
      { ts: NOW - 5000, metric: 'cpu_load', value: 1.6080402010050252 }
    ],
    cpu_temperature: [{ ts: NOW - 8000, metric: 'cpu_temperature', value: 48.7 }],
    network_rx: []
  };
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url, 'http://io.lan:8889').pathname;
      if (path === '/api/config') return Response.json({ ...config, serverTime });
      const metric = /\/api\/metrics\/(\w+)\/history/.exec(path)?.[1];
      if (metric) return Response.json(history[metric] ?? []);
      return new Response('not found', { status: 404 });
    })
  );
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  render(null, root);
  root.remove();
  location.hash = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('<App>', () => {
  it('shows the device and one tile per live plugin (not history-only ones), with values from history', async () => {
    render(<App />, root);
    await eventually(() => expect(tile('CPU load').textContent).toContain('1.6%'));

    expect(root.querySelector('h1')?.textContent).toBe('Io');
    const facts = root.querySelector('.facts')?.textContent ?? '';
    expect(facts).toContain('Raspberry Pi 3 Model B Rev 1.2');
    expect(facts).toContain('Raspbian GNU/Linux 11 (bullseye)');
    expect(facts).toContain('6.1.21-v7+');
    expect(facts).toContain('16 days 11 h');
    expect([...root.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
      'CPU load',
      'CPU temperature',
      'Network received'
    ]);
    expect(tile('CPU load').textContent).toContain('1.6%');
    expect(tile('CPU temperature').textContent).toContain('48.7°C');
    expect(tile('Network received').textContent).toContain('Waiting for the first reading');
  });

  it('connects to /api/live on the same host and updates tiles as samples arrive', async () => {
    render(<App />, root);
    await eventually(() => expect(FakeSocket.instances).toHaveLength(1));

    const socket = FakeSocket.instances.at(-1)!;
    expect(socket.url).toBe('ws://io.lan:8889/api/live');
    await act(() => socket.onopen?.());
    expect(root.textContent).toContain('Live');

    await send({ type: 'sample', ts: NOW, metric: 'network_rx', value: 1536 });
    expect(tile('Network received').textContent).toContain('1.5kB/s');
  });

  it('loads history once on first connect and again after a reconnect', async () => {
    const historyCalls = () =>
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/cpu_load/history'))
        .length;
    render(<App />, root);
    await eventually(() => expect(FakeSocket.instances).toHaveLength(1));
    await act(() => FakeSocket.instances.at(-1)!.onopen?.());
    await flush();
    expect(historyCalls()).toBe(1);

    await act(() => FakeSocket.instances.at(-1)!.onclose?.());
    await eventually(() => expect(FakeSocket.instances).toHaveLength(2), 2000);
    await act(() => FakeSocket.instances.at(-1)!.onopen?.());
    await eventually(() => expect(historyCalls()).toBe(2));
  });

  it('describes a hot CPU in words, not only in color', async () => {
    render(<App />, root);
    await eventually(() => expect(FakeSocket.instances).toHaveLength(1));
    await send({ type: 'sample', ts: NOW, metric: 'cpu_temperature', value: 82 });

    expect(tile('CPU temperature').textContent).toContain('CPU running hot');
  });

  it('says it is reconnecting when the live feed drops', async () => {
    render(<App />, root);
    await eventually(() => expect(FakeSocket.instances).toHaveLength(1));
    await act(() => FakeSocket.instances.at(-1)!.onclose?.());

    expect(root.textContent).toContain('Reconnecting');
  });

  it('explains what to check when the server cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    render(<App />, root);
    await eventually(() => expect(root.textContent).toContain("Can't reach"));

    expect(root.textContent).toContain("Can't reach the PiPulse server at io.lan:8889");
  });

  it('keeps retrying /api/config and shows the dashboard once the server is back', async () => {
    const working = vi.mocked(fetch).getMockImplementation()!;
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/config' && calls++ === 0) throw new TypeError('Failed to fetch');
        return working(url);
      })
    );
    render(<App />, root);
    await eventually(() => expect(root.textContent).toContain('Trying again in 1 s'));

    // The first retry fires after 1 s of real time.
    await eventually(() => expect(root.querySelector('h1')?.textContent).toBe('Io'), 3000);
    expect(root.textContent).not.toContain("Can't reach");
  });

  it('links the live dashboard and the history, marking the current page', async () => {
    render(<App />, root);
    await eventually(() => expect(root.querySelector('nav[aria-label="Pages"]')).not.toBeNull());

    const links = [...root.querySelectorAll('nav[aria-label="Pages"] a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Now', '#/'],
      ['History', '#/history?range=24h'],
      ['Alerts', '#/alerts']
    ]);
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
  });

  it('switches to the history page when the hash changes, keeping the device header', async () => {
    render(<App />, root);
    await eventually(() => expect(tile('CPU load')).toBeDefined());

    await act(() => {
      location.hash = '#/history?range=7d';
      dispatchEvent(new HashChangeEvent('hashchange'));
    });

    await eventually(() =>
      expect(
        root.querySelector('nav[aria-label="Time range"] [aria-current="true"]')?.textContent
      ).toBe('7 days')
    );
    expect(root.querySelector('h1')?.textContent).toBe('Io');
    expect(root.querySelector('.tiles')).toBeNull();
    expect(root.querySelector('nav[aria-label="Pages"] a[aria-current="page"]')?.textContent).toBe(
      'History'
    );
  });
});

describe('<App> alerts', () => {
  const MINUTE = 60_000;

  const openAlert = (id: number, severity: 'warning' | 'critical', ruleId: string) => ({
    id,
    ruleId,
    metric: 'cpu_temperature',
    severity,
    message: ruleId,
    value: 82,
    raisedAt: NOW - 5 * MINUTE,
    clearedAt: null,
    clearedBy: null
  });

  it('shows the worst open alert on its tile and keeps the warning when the critical clears', async () => {
    render(<App />, root);
    await eventually(() => expect(FakeSocket.instances).toHaveLength(1));
    const warm = openAlert(1, 'warning', 'cpu_warm');
    const hot = openAlert(2, 'critical', 'cpu_hot');
    await send({ type: 'snapshot', samples: [], alerts: [warm, hot] });
    expect(tile('CPU temperature').textContent).toContain('Alert since');
    expect(
      tile('CPU temperature').querySelector('.alert-line')?.getAttribute('data-severity')
    ).toBe('critical');

    await send({
      type: 'alert',
      event: 'cleared',
      alert: { ...hot, clearedAt: NOW, clearedBy: 'condition' }
    });
    expect(
      tile('CPU temperature').querySelector('.alert-line')?.getAttribute('data-severity')
    ).toBe('warning');
  });

  it('replaces the open alerts with each reconnect snapshot, dropping ones cleared while away', async () => {
    render(<App />, root);
    await eventually(() => expect(FakeSocket.instances).toHaveLength(1));
    await send({ type: 'snapshot', samples: [], alerts: [openAlert(1, 'critical', 'cpu_hot')] });
    await send({ type: 'snapshot', samples: [], alerts: [] });
    expect(tile('CPU temperature').querySelector('.alert-line')).toBeNull();
  });

  it('badges the Alerts link with the open count and severity in words', async () => {
    render(<App />, root);
    await eventually(() => expect(FakeSocket.instances).toHaveLength(1));
    const link = () =>
      [...root.querySelectorAll('nav[aria-label="Pages"] a')].find(
        (a) => a.getAttribute('href') === '#/alerts'
      )!;
    expect(link().getAttribute('aria-label')).toBeNull();

    await send({ type: 'snapshot', samples: [], alerts: [openAlert(1, 'critical', 'cpu_hot')] });
    expect(link().textContent).toContain('1');
    expect(link().getAttribute('aria-label')).toBe('Alerts, 1 open, critical');
  });

  it('names the severity in the badge for a warning-only alert too', async () => {
    render(<App />, root);
    await eventually(() => expect(FakeSocket.instances).toHaveLength(1));
    const link = () =>
      [...root.querySelectorAll('nav[aria-label="Pages"] a')].find(
        (a) => a.getAttribute('href') === '#/alerts'
      )!;

    await send({ type: 'snapshot', samples: [], alerts: [openAlert(1, 'warning', 'cpu_warm')] });
    expect(link().textContent).toContain('1');
    expect(link().getAttribute('aria-label')).toBe('Alerts, 1 open, warning');
  });
});

describe('<App> with the Pi and the browser clocks disagreeing', () => {
  const MINUTE = 60_000;

  it('shows uptime from the reported duration, whatever the Pi clock says', async () => {
    // A Pi that booted before NTP synced: its clock is a week behind.
    serverTime = NOW - 7 * 24 * 60 * MINUTE;
    render(<App />, root);
    await eventually(() => expect(root.querySelector('.facts')).not.toBeNull());

    expect(root.querySelector('.facts')?.textContent).toContain('16 days 11 h');
  });

  it('does not flag fresh readings as stale when the Pi clock is behind', async () => {
    serverTime = NOW - 5 * MINUTE;
    history = { cpu_load: [{ ts: serverTime - 1000, metric: 'cpu_load', value: 1.2 }] };
    render(<App />, root);
    await eventually(() => expect(tile('CPU load').textContent).toContain('1.2%'));

    expect(tile('CPU load').dataset['stale']).toBeUndefined();
    expect(tile('CPU load').textContent).not.toContain('No update since');
  });

  it('asks for history on the Pi clock', async () => {
    serverTime = NOW - 5 * MINUTE;
    render(<App />, root);
    await eventually(() => expect(FakeSocket.instances).toHaveLength(1));

    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(urls).toContain(`/api/metrics/cpu_load/history?from=${serverTime - 15 * MINUTE}`);
  });

  it('skips sparkline history for history-only metrics, which have no tile', async () => {
    render(<App />, root);
    await eventually(() => expect(FakeSocket.instances).toHaveLength(1));

    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('/cpu_load/history'))).toBe(true);
    expect(urls.some((url) => url.includes('/load_1/'))).toBe(false);
  });

  it('follows the clock of pushed samples', async () => {
    render(<App />, root);
    await eventually(() => expect(FakeSocket.instances).toHaveLength(1));

    // The Pi's clock turns out to be 5 min behind: a fresh sample must not read as stale.
    await send({ type: 'sample', ts: NOW - 5 * MINUTE, metric: 'network_rx', value: 1536 });

    expect(tile('Network received').dataset['stale']).toBeUndefined();
  });

  it('still flags a stale reading when the Pi clock is ahead', async () => {
    serverTime = NOW + 5 * MINUTE;
    // 1 min old on the Pi's clock, but "4 min in the future" on the browser's.
    history = { cpu_load: [{ ts: serverTime - MINUTE, metric: 'cpu_load', value: 1.2 }] };
    render(<App />, root);
    await eventually(() => expect(tile('CPU load').textContent).toContain('1.2%'));

    expect(tile('CPU load').dataset['stale']).toBe('true');
    expect(tile('CPU load').textContent).toContain('No update since 1 min ago');
  });
});

describe('read protection', () => {
  it('shows only the sign-in form when /api/config needs a session, then the dashboard', async () => {
    let signedIn = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url, 'http://io.lan:8889').pathname;
        if (path === '/api/session') {
          return Response.json({ editable: true, signedIn, protectReads: true });
        }
        if (path === '/api/login' && init?.method === 'POST') {
          signedIn = true;
          return Response.json({ signedIn: true });
        }
        if (!signedIn) return Response.json({ error: 'sign in required' }, { status: 401 });
        if (path === '/api/config') return Response.json({ ...config, serverTime });
        return Response.json([]);
      })
    );
    render(<App />, root);
    await eventually(() => expect(root.querySelector('input[type=password]')).not.toBeNull());
    expect(root.querySelector('nav')).toBeNull();

    const input = root.querySelector('input[type=password]') as HTMLInputElement;
    await act(() => {
      input.value = 'secret';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => {
      root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    });
    await eventually(() => expect(root.querySelector('h1')?.textContent).toBe('Io'));
    expect(root.textContent).toContain('Sign out');
  });
});
