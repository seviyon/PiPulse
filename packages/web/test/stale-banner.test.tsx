import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('uplot', () => ({
  default: class {
    setData() {}
    setSize() {}
    destroy() {}
  }
}));
const web = vi.hoisted(() => ({ value: 'dev' }));
vi.mock('../src/build.js', async (original) => ({
  ...(await original<typeof import('../src/build.js')>()),
  get WEB_VERSION() {
    return web.value;
  }
}));

import { render } from 'preact';
import { act } from 'preact/test-utils';
import { App } from '../src/app.js';

class FakeSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {}
  close() {}
}

const config = (version?: string) => ({
  device: { hostname: 'Io', platform: 'linux', arch: 'arm', memoryTotalMb: 971 },
  uptimeMs: 1000,
  plugins: [{ id: 'cpu_load', label: 'CPU load', unit: '%', intervalMs: 5000 }],
  rules: [],
  alerts: [],
  ...(version ? { version } : {})
});
let root: HTMLElement;
let serverVersion: string | undefined;
beforeEach(() => {
  web.value = 'dev';
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/config') return Response.json(config(serverVersion));
      if (url === '/api/session') return Response.json({ signedIn: false, canSignIn: false });
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
  vi.unstubAllGlobals();
});

const show = async () => {
  await act(async () => render(<App />, root));
  await vi.waitFor(() => expect(root.querySelector('h1')?.textContent).toBe('Io'));
};

describe('the page that no longer matches its server', () => {
  it('says so at the top of every page, with the fix', async () => {
    web.value = '0.7.0';
    serverVersion = '0.7.1';
    await show();
    const banner = root.querySelector('[role="status"].stale-dashboard');
    expect(banner?.textContent).toContain('dashboard 0.7.0');
    expect(banner?.textContent).toContain('server is 0.7.1');
    expect(banner?.textContent).toContain('Reload');
  });

  it('is silent when they match, and for a development build', async () => {
    web.value = '0.7.1';
    serverVersion = '0.7.1';
    await show();
    expect(root.querySelector('.stale-dashboard')).toBeNull();
  });

  it('is silent for dev', async () => {
    serverVersion = '0.7.1';
    await show();
    expect(root.querySelector('.stale-dashboard')).toBeNull();
  });
});
