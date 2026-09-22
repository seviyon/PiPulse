import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    { id: 'network_rx', label: 'Network received', unit: 'B/s', intervalMs: 5000 }
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('<App>', () => {
  it('shows the device and one tile per plugin, with values from history', async () => {
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

  it('describes a hot CPU in words, not only in color', async () => {
    render(<App />, root);
    await eventually(() => expect(FakeSocket.instances).toHaveLength(1));
    await send({ type: 'sample', ts: NOW, metric: 'cpu_temperature', value: 82 });

    expect(tile('CPU temperature').textContent).toContain('Throttling likely');
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
