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
import type { UpdatesView } from '../src/types.js';

class FakeSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {}
  close() {}
}

const config = {
  device: { hostname: 'Io', platform: 'linux', arch: 'arm', memoryTotalMb: 971 },
  uptimeMs: 1000,
  plugins: [{ id: 'cpu_load', label: 'CPU load', unit: '%', intervalMs: 5000 }],
  rules: [],
  alerts: [],
  version: '0.7.0'
};
const waiting: UpdatesView = {
  state: 'ok',
  checkedAt: Date.now(),
  listsRefreshedAt: Date.now(),
  pipulse: { source: 'apt', installed: '0.7.0', candidate: '0.7.0', available: false },
  os: {
    total: 3,
    packages: [
      { name: 'libssl3', from: '1', to: '2' },
      { name: 'openssl', from: '1', to: '2' },
      { name: 'curl', from: '1', to: '2' }
    ],
    keptBack: []
  }
};

let root: HTMLElement;
let updates: () => Response;
let updateCalls: number;
beforeEach(() => {
  updateCalls = 0;
  updates = () => Response.json(waiting);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/config') return Response.json(config);
      if (url === '/api/session')
        return Response.json({ editable: false, signedIn: false, protectReads: false });
      if (url === '/api/updates') {
        updateCalls++;
        return updates();
      }
      if (url.includes('/history')) return Response.json([]);
      return Response.json({});
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

const show = async () => {
  await act(async () => render(<App />, root));
  await vi.waitFor(() => expect(root.querySelector('h1')?.textContent).toBe('Io'));
};
const tab = () =>
  [...root.querySelectorAll('nav a')].find((a) => a.textContent?.startsWith('Updates'));

describe('the Updates tab', () => {
  it('sits between Alerts and Settings and shows how many updates are waiting', async () => {
    await show();
    const labels = [...root.querySelectorAll('nav a')].map((a) =>
      a.textContent?.replace(/\d+$/, '')
    );
    expect(labels).toEqual(['Now', 'History', 'Alerts', 'Updates', 'Settings']);
    await vi.waitFor(() => expect(tab()?.querySelector('.badge')?.textContent).toBe('3'));
    expect(tab()?.getAttribute('aria-label')).toBe('Updates, 3 waiting');
    expect(tab()?.getAttribute('href')).toBe('#/updates');
  });

  it('has no badge when nothing waits, or when the server is older and has no /api/updates', async () => {
    updates = () => Response.json({ ...waiting, os: { total: 0, packages: [], keptBack: [] } });
    await show();
    await vi.waitFor(() => expect(updateCalls).toBeGreaterThan(0));
    expect(tab()?.querySelector('.badge')).toBeNull();
    expect(tab()?.getAttribute('aria-label')).toBeNull();
  });

  it('an older server (404) leaves the tab without a badge and does not break the page', async () => {
    updates = () => new Response('not found', { status: 404 });
    await show();
    await vi.waitFor(() => expect(updateCalls).toBeGreaterThan(0));
    expect(tab()?.querySelector('.badge')).toBeNull();
  });

  it('opens the page at #/updates and marks the tab current', async () => {
    location.hash = '#/updates';
    await show();
    await vi.waitFor(() => expect(root.textContent).toContain('3 packages can be upgraded'));
    expect(tab()?.getAttribute('aria-current')).toBe('page');
  });

  it('reads again every ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await show();
    await vi.waitFor(() => expect(updateCalls).toBe(1));
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    await vi.waitFor(() => expect(updateCalls).toBe(2));
  });
});
