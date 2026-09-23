import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SettingsPage } from '../src/settings-page.js';
import type { Session } from '../src/api.js';

const DAY = 86_400_000;
const settings = {
  retention: {
    raw: {
      text: '2d',
      ms: 2 * DAY,
      source: 'default',
      variable: 'PIPULSE_RETENTION_RAW',
      locked: false
    },
    '1m': {
      text: '14d',
      ms: 14 * DAY,
      source: 'default',
      variable: 'PIPULSE_RETENTION_1M',
      locked: false
    },
    '1h': {
      text: '1y',
      ms: 365 * DAY,
      source: 'default',
      variable: 'PIPULSE_RETENTION_1H',
      locked: false
    },
    '1d': {
      text: 'forever',
      ms: null,
      source: 'env',
      variable: 'PIPULSE_RETENTION_1D',
      locked: true
    }
  },
  storage: {
    fileBytes: 35_000_000,
    freeBytes: 1_000_000,
    diskFreeBytes: 2_000_000_000,
    levels: {
      raw: { rows: 380_000, oldest: Date.UTC(2026, 8, 20) },
      '1m': { rows: 222_000, oldest: Date.UTC(2026, 8, 8) },
      '1h': { rows: 96_000, oldest: Date.UTC(2025, 8, 22) },
      '1d': { rows: 4000, oldest: Date.UTC(2025, 1, 1) }
    }
  }
};
const preview = {
  deletions: {
    raw: { deletesRows: 190_000, from: Date.UTC(2026, 8, 20), to: Date.UTC(2026, 8, 21) },
    '1m': { deletesRows: 0, from: null, to: null },
    '1h': { deletesRows: 0, from: null, to: null },
    '1d': { deletesRows: 0, from: null, to: null }
  },
  estimatedBytes: 25_000_000
};

let root: HTMLElement;
let putStatus: number;
let previewAnswer: typeof preview;
const calls: { method: string; path: string; body?: unknown }[] = [];

beforeEach(() => {
  putStatus = 200;
  previewAnswer = preview;
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url, body });
      if (url === '/api/settings' && method === 'GET') return Response.json(settings);
      if (url === '/api/settings/preview') return Response.json(previewAnswer);
      if (url === '/api/settings' && method === 'PUT') {
        const answers: Record<number, unknown> = {
          200: settings,
          401: { error: 'sign in required' },
          403: { error: 'editing is disabled: no admin password configured' },
          409: { error: 'this change deletes data; confirm it first', ...preview }
        };
        return Response.json(answers[putStatus], { status: putStatus });
      }
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
});

async function settle() {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(root.textContent).not.toContain('Loading');
  });
}

const signedIn: Session = { editable: true, signedIn: true, protectReads: false };
const input = (name: string) => root.querySelector(`input[name="${name}"]`) as HTMLInputElement;
const button = (text: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

async function type(name: string, value: string) {
  await act(() => {
    input(name).value = value;
    input(name).dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(text: string) {
  await act(async () => {
    button(text).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
}

describe('SettingsPage', () => {
  it('in read-only mode shows values and how to enable editing, with no inputs enabled', async () => {
    render(
      <SettingsPage
        session={{ editable: false, signedIn: false, protectReads: false }}
        onSessionChange={() => {}}
      />,
      root
    );
    await settle();
    expect(root.textContent).toContain('PIPULSE_ADMIN_PASSWORD_HASH_FILE');
    expect(input('raw').disabled).toBe(true);
    expect(root.textContent).toContain('35 MB');
  });

  it('asks a signed-out operator to sign in', async () => {
    render(
      <SettingsPage
        session={{ editable: true, signedIn: false, protectReads: false }}
        onSessionChange={() => {}}
      />,
      root
    );
    await settle();
    expect(root.querySelector('input[type=password]')).not.toBeNull();
    expect(input('raw').disabled).toBe(true);
  });

  it('locks a level set by the environment, naming the variable', async () => {
    render(<SettingsPage session={signedIn} onSessionChange={() => {}} />, root);
    await settle();
    expect(input('1d').disabled).toBe(true);
    expect(root.textContent).toContain('set by PIPULSE_RETENTION_1D');
    expect(input('raw').disabled).toBe(false);
  });

  it('previews a deletion and enables Save only once it is confirmed', async () => {
    render(<SettingsPage session={signedIn} onSessionChange={() => {}} />, root);
    await settle();
    await type('raw', '1d');
    await click('Review changes');
    expect(root.textContent).toMatch(/Deletes ~190,000 raw readings/);
    expect(root.textContent).toContain('25 MB');
    expect(button('Save').disabled).toBe(true);
    const confirm = root.querySelector('input[type=checkbox]') as HTMLInputElement;
    await act(() => confirm.click());
    expect(button('Save').disabled).toBe(false);
    await click('Save');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      retention: { raw: '1d', '1m': '14d', '1h': '1y', '1d': 'forever' },
      confirmDeletion: true
    });
    expect(root.textContent).toContain('Saved');
  });

  it('shows the fresh preview when the server says the change now deletes data', async () => {
    putStatus = 409;
    previewAnswer = {
      ...preview,
      deletions: { ...preview.deletions, raw: { deletesRows: 0, from: null, to: null } }
    };
    render(<SettingsPage session={signedIn} onSessionChange={() => {}} />, root);
    await settle();
    // Lengthening previews no deletion, so Save goes without confirmation…
    await type('raw', '7d');
    await click('Review changes');
    expect(root.querySelector('input[type=checkbox]')).toBeNull();
    await click('Save');
    // …and the server's 409 brings up its preview and the confirmation instead.
    expect(root.textContent).toMatch(/Deletes ~190,000 raw readings/);
    expect(root.querySelector('input[type=checkbox]')).not.toBeNull();
    expect(root.textContent).not.toContain("Couldn't reach");
  });

  it('explains a refused save instead of blaming the network', async () => {
    putStatus = 403;
    previewAnswer = {
      ...preview,
      deletions: { ...preview.deletions, raw: { deletesRows: 0, from: null, to: null } }
    };
    render(<SettingsPage session={signedIn} onSessionChange={() => {}} />, root);
    await settle();
    await type('raw', '7d');
    await click('Review changes');
    await click('Save');
    expect(root.textContent).toMatch(/refused the change/);
    expect(root.textContent).not.toContain("Couldn't reach");
  });

  it('falls back to the sign-in form when the session is gone (server restarted)', async () => {
    const onSessionChange = vi.fn();
    putStatus = 401;
    render(<SettingsPage session={signedIn} onSessionChange={onSessionChange} />, root);
    await settle();
    await type('raw', '1d');
    await click('Review changes');
    await act(() => (root.querySelector('input[type=checkbox]') as HTMLInputElement).click());
    await click('Save');
    expect(onSessionChange).toHaveBeenCalledWith({ ...signedIn, signedIn: false });
  });
});
