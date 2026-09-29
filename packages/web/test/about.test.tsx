import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { AboutSection } from '../src/about.js';

let root: HTMLElement;
let config: object;
beforeEach(() => {
  config = {
    version: '0.6.0',
    node: { version: '22.23.3', line: 22, supportEnds: '2027-04-30', ended: false }
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/config' ? Response.json(config) : new Response('', { status: 404 })
    )
  );
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

async function show() {
  await act(async () => render(<AboutSection />, root));
  await vi.waitFor(() => expect(root.textContent).not.toContain('Loading'));
}

describe('AboutSection', () => {
  it('shows the versions and when Node support ends', async () => {
    await show();
    expect(root.querySelector('h2')?.textContent).toBe('About');
    expect(root.textContent).toContain('PiPulse 0.6.0');
    expect(root.textContent).toContain('Node 22.23.3');
    expect(root.textContent).toContain('security fixes until 30 Apr 2027');
    expect(root.querySelector('svg')).toBeNull();
  });

  it('warns in words once support has ended', async () => {
    config = {
      ...config,
      node: { version: '22.23.3', line: 22, supportEnds: '2027-04-30', ended: true }
    };
    await show();
    expect(root.textContent).toContain('Node 22 no longer gets security fixes (since 30 Apr 2027)');
    expect(root.querySelector('svg')).not.toBeNull();
  });

  it('says nothing about support for an unknown line or an older server', async () => {
    config = { version: 'dev' };
    await show();
    expect(root.textContent).toContain('PiPulse dev');
    expect(root.textContent).not.toContain('security fixes');
  });
});
