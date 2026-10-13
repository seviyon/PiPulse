import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { UpdatesPage } from '../src/updates-page.js';
import { UPGRADE_POLL_MS } from '../src/updates.js';
import type { Session } from '../src/api.js';
import type { UpdatesView, UpgradeView } from '../src/types.js';

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const signedIn: Session = { editable: true, signedIn: true, protectReads: false };
const readOnly: Session = { editable: false, signedIn: false, protectReads: false };

const upgrade = (over: Partial<Extract<UpgradeView, { available: true }>> = {}): UpgradeView => ({
  available: true,
  state: 'idle',
  step: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  rebootRequired: false,
  log: [],
  ...over
});
const withUpgrade = (u: UpgradeView): UpdatesView => ({
  state: 'ok',
  checkedAt: NOW - 60_000,
  listsRefreshedAt: NOW - 3_600_000,
  pipulse: { source: 'apt', installed: '0.7.0', candidate: '0.7.0', available: false },
  os: { total: 2, packages: [{ name: 'curl', from: '1', to: '2' }], keptBack: [] },
  upgrade: u
});

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function show(view: UpdatesView, session: Session, onView: (v: UpdatesView) => void = () => {}) {
  return act(async () =>
    render(
      <UpdatesPage view={view} session={session} version="0.7.0" now={NOW} onView={onView} />,
      root
    )
  );
}
const text = () => root.textContent ?? '';
const button = () =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('Install updates'))!;
const box = () => root.querySelector<HTMLInputElement>('input[type=text]')!;
const type = (value: string) =>
  act(async () => {
    box().value = value;
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('when the button is not offered', () => {
  it.each([
    ['off', 'PIPULSE_ALLOW_UPGRADE=true'],
    ['no-sign-in', 'needs a sign-in password'],
    ['not-installed', "doesn't have the upgrade helper"]
  ] as const)('says how to get it (%s)', async (reason, words) => {
    await show(withUpgrade({ available: false, reason }), signedIn);
    expect(text()).toContain(words);
    expect(button()).toBeUndefined();
  });

  it('says nothing in Docker', async () => {
    await show(withUpgrade({ available: false, reason: 'container' }), signedIn);
    expect(root.querySelector('#updates-install')).toBeNull();
  });

  it('an older server (no upgrade key) shows no section', async () => {
    const { upgrade: _drop, ...view } = withUpgrade(upgrade()) as Extract<
      UpdatesView,
      { state: 'ok' }
    >;
    await show(view, signedIn);
    expect(root.querySelector('#updates-install')).toBeNull();
  });
});

describe('asking', () => {
  it('warns what it does before anything is pressed', async () => {
    await show(withUpgrade(upgrade()), signedIn);
    expect(text()).toContain('as root');
    expect(text()).toContain('restart services');
    expect(text()).toContain('reboot');
  });

  it('a visitor who is not signed in is told to sign in, with no button', async () => {
    await show(withUpgrade(upgrade()), readOnly);
    expect(text()).toContain('Sign in (Settings) to install from here.');
    expect(button()).toBeUndefined();
  });

  it('stays disabled until the word is typed exactly', async () => {
    await show(withUpgrade(upgrade()), signedIn);
    expect(button().disabled).toBe(true);
    await type('upgrad');
    expect(button().disabled).toBe(true);
    await type('Upgrade');
    expect(button().disabled).toBe(true);
    await type(' upgrade ');
    expect(button().disabled).toBe(false);
  });

  it('posts the confirmation, then shows the requested state', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ upgrade: upgrade({ state: 'requested' }) }, { status: 202 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const seen: UpdatesView[] = [];
    await show(withUpgrade(upgrade()), signedIn, (v) => seen.push(v));
    await type('upgrade');
    await act(async () => button().click());
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/updates/upgrade',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ confirm: 'upgrade' }) })
    );
    expect(seen[0]).toMatchObject({ upgrade: { state: 'requested' } });
  });

  it('falls back to a plain sentence when the failure has no message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('');
      })
    );
    await show(withUpgrade(upgrade()), signedIn);
    await type('upgrade');
    await act(async () => button().click());
    await vi.waitFor(() => expect(text()).toContain('The request could not be sent.'));
  });

  it('says why when the server refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'an upgrade is already running' }, { status: 409 }))
    );
    await show(withUpgrade(upgrade()), signedIn);
    await type('upgrade');
    await act(async () => button().click());
    await vi.waitFor(() => expect(text()).toContain('answered 409'));
  });
});

describe('what the helper reports', () => {
  it('requested: waiting, and the button is off', async () => {
    await show(withUpgrade(upgrade({ state: 'requested' })), signedIn);
    expect(text()).toContain('Waiting for the helper to start');
    await type('upgrade');
    expect(button().disabled).toBe(true);
  });

  it('running: the step, how long, and the log', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 }))
    );
    await show(
      withUpgrade(
        upgrade({
          state: 'running',
          step: 'upgrade',
          startedAt: NOW - 90_000,
          log: ['Unpacking curl', 'Setting up curl']
        })
      ),
      signedIn
    );
    expect(text()).toContain('installing the upgrades');
    expect(text()).toContain('started');
    expect(root.querySelector('pre')?.textContent).toBe('Unpacking curl\nSetting up curl');
    expect(root.querySelector('pre')?.getAttribute('aria-label')).toBe('Upgrade log');
  });

  it('running with no step yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 }))
    );
    await show(withUpgrade(upgrade({ state: 'running' })), signedIn);
    expect(text()).toContain('Running: starting');
  });

  it('done', async () => {
    await show(
      withUpgrade(upgrade({ state: 'done', step: 'upgrade', finishedAt: NOW - 1000, exitCode: 0 })),
      signedIn
    );
    expect(text()).toContain('the upgrade completed');
  });

  it('failed: the step, the code, an icon', async () => {
    await show(
      withUpgrade(
        upgrade({ state: 'failed', step: 'update', finishedAt: NOW - 1000, exitCode: 100 })
      ),
      signedIn
    );
    expect(text()).toContain('refreshing the package lists');
    expect(text()).toContain('exit code 100');
    expect(root.querySelector('[aria-labelledby=updates-install] svg')).not.toBeNull();
  });

  it('failed with nothing known about it', async () => {
    await show(withUpgrade(upgrade({ state: 'failed' })), signedIn);
    expect(text()).toContain('while running');
    expect(text()).not.toContain('exit code');
  });

  it('interrupted by a reboot: the repair command', async () => {
    await show(withUpgrade(upgrade({ state: 'interrupted' })), signedIn);
    expect(text()).toContain('sudo dpkg --configure -a');
  });

  it('a reboot is needed', async () => {
    await show(
      withUpgrade(upgrade({ state: 'done', rebootRequired: true, finishedAt: NOW })),
      signedIn
    );
    expect(text()).toContain('A reboot is needed');
  });
});

describe('polling while it runs', () => {
  it('asks again every few seconds, keeps going through a failed poll, and stops when done', async () => {
    vi.useFakeTimers();
    const running = withUpgrade(upgrade({ state: 'running', step: 'update' }));
    const finished = withUpgrade(upgrade({ state: 'done', finishedAt: NOW }));
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('the server is restarting'))
      .mockResolvedValue(Response.json(finished));
    vi.stubGlobal('fetch', fetchMock);
    const seen: UpdatesView[] = [];
    await show(running, signedIn, (v) => seen.push(v));
    await act(async () => void (await vi.advanceTimersByTimeAsync(UPGRADE_POLL_MS)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(0);
    await act(async () => void (await vi.advanceTimersByTimeAsync(UPGRADE_POLL_MS)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen[0]).toMatchObject({ upgrade: { state: 'done' } });
  });

  it('does not poll when nothing is running', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await show(withUpgrade(upgrade()), signedIn);
    await act(async () => void (await vi.advanceTimersByTimeAsync(UPGRADE_POLL_MS * 3)));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
