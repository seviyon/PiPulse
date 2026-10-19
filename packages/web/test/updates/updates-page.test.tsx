import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { UpdatesPage } from '../../src/updates/updates-page.js';
import {
  DOCKER_COMMAND,
  PIPULSE_APT_COMMAND,
  STALE_LISTS_MS,
  UPGRADE_COMMAND,
  waitingCount
} from '../../src/updates/updates.js';
import { parseRoute, routeHash } from '../../src/router.js';
import type { Session } from '../../src/core/api.js';
import type { UpdatesView } from '../../src/core/types.js';

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const signedIn: Session = { editable: true, signedIn: true, protectReads: false };
const readOnly: Session = { editable: false, signedIn: false, protectReads: false };

const ok = (over: Partial<Extract<UpdatesView, { state: 'ok' }>> = {}): UpdatesView => ({
  state: 'ok',
  checkedAt: NOW - 60_000,
  listsRefreshedAt: NOW - 3_600_000,
  pipulse: { source: 'apt', installed: '0.7.0', candidate: '0.7.0', available: false },
  os: { total: 0, packages: [], keptBack: [] },
  ...over
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
});

function show(
  view: UpdatesView | undefined,
  props: { session?: Session; onView?: (v: UpdatesView) => void; version?: string } = {}
) {
  return act(async () =>
    render(
      <UpdatesPage
        view={view}
        session={props.session ?? readOnly}
        version={'version' in props ? props.version : '0.7.0'}
        now={NOW}
        onView={props.onView ?? (() => undefined)}
      />,
      root
    )
  );
}
const text = () => root.textContent ?? '';

describe('waitingCount and the route', () => {
  it('counts the OS packages and a held-back PiPulse once, and nothing when not checked', () => {
    expect(waitingCount(undefined)).toBe(0);
    expect(waitingCount({ state: 'pending' })).toBe(0);
    expect(waitingCount(ok())).toBe(0);
    expect(waitingCount(ok({ os: { total: 3, packages: [], keptBack: [] } }))).toBe(3);
    // PiPulse is one of the three: not counted twice
    expect(
      waitingCount(
        ok({
          pipulse: { source: 'apt', installed: '1', candidate: '2', available: true },
          os: { total: 3, packages: [{ name: 'pipulse', from: '1', to: '2' }], keptBack: [] }
        })
      )
    ).toBe(3);
    // held back by apt: not in the list, but waiting
    expect(
      waitingCount(
        ok({ pipulse: { source: 'apt', installed: '1', candidate: '2', available: true } })
      )
    ).toBe(1);
  });

  it('routes #/updates', () => {
    expect(parseRoute('#/updates')).toEqual({ page: 'updates' });
    expect(routeHash({ page: 'updates' })).toBe('#/updates');
  });
});

describe('UpdatesPage states, in words', () => {
  it('loading', async () => {
    await show(undefined);
    expect(text()).toContain('Loading');
  });

  it('in Docker it says so and shows the image command, with nothing to check', async () => {
    await show({ state: 'unsupported', reason: 'container' });
    expect(text()).toContain('running in Docker');
    expect(text()).toContain(DOCKER_COMMAND);
    expect(root.querySelector('button.link-button')?.textContent).toBe('Copy');
    expect(text()).not.toContain('Check now');
  });

  it('without apt it says so', async () => {
    await show({ state: 'unsupported', reason: 'no-apt' });
    expect(text()).toContain("doesn't use apt");
  });

  it('before the first check it says when it will happen', async () => {
    await show({ state: 'pending' });
    expect(text()).toContain('Not checked yet');
    expect(text()).toContain('Sign in (Settings) to check now.');
  });

  it('a failed check shows the one line and when', async () => {
    await show({ state: 'failed', checkedAt: NOW - 5000, problem: 'E: Could not open …' });
    expect(text()).toContain('The last check');
    expect(text()).toContain('failed: E: Could not open …');
    expect(root.querySelector('svg')).not.toBeNull();
  });

  it('everything up to date', async () => {
    await show(ok());
    expect(text()).toContain('PiPulse 0.7.0 is up to date.');
    expect(text()).toContain('No package upgrades are waiting.');
    expect(text()).toContain('Everything is up to date.');
  });

  it('a newer PiPulse, with the exact command', async () => {
    await show(
      ok({
        pipulse: { source: 'apt', installed: '0.7.0', candidate: '0.7.1', available: true },
        os: { total: 1, packages: [{ name: 'pipulse', from: '0.7.0', to: '0.7.1' }], keptBack: [] }
      })
    );
    expect(text()).toContain('A newer PiPulse is available: 0.7.0 → 0.7.1');
    expect(text()).toContain(PIPULSE_APT_COMMAND);
    expect(text()).not.toContain('Everything is up to date.');
  });

  it('still says a newer PiPulse is available when apt listed it but gave no versions', async () => {
    await show(
      ok({ pipulse: { source: 'apt', installed: null, candidate: null, available: true } })
    );
    expect(text()).toContain('A newer PiPulse is available: installed → newer.');
  });

  it('says PiPulse is up to date by the installed version when the page has no version', async () => {
    await show(ok(), { version: undefined });
    expect(text()).toContain('PiPulse 0.7.0 is up to date.');
  });

  it('a tarball install says it cannot tell, and how to update', async () => {
    await show(
      ok({ pipulse: { source: 'other', installed: null, candidate: null, available: false } }),
      { version: '0.7.0' }
    );
    expect(text()).toContain('PiPulse 0.7.0 was not installed from the apt repository');
    expect(text()).toContain('installer again');
  });

  it('lists the packages in a table with the command and the warning about restarts', async () => {
    await show(
      ok({
        os: {
          total: 2,
          packages: [
            { name: 'libssl3', from: '1', to: '2' },
            { name: 'openssl', from: '1', to: '2' }
          ],
          keptBack: []
        }
      })
    );
    expect(text()).toContain('2 packages can be upgraded:');
    const rows = [...root.querySelectorAll('tbody tr')].map((r) => r.textContent);
    expect(rows).toEqual(['libssl312', 'openssl12']);
    expect(text()).toContain(UPGRADE_COMMAND);
    expect(text()).toContain('restart services');
  });

  it('says one package in the singular, and when only the first are listed', async () => {
    await show(
      ok({ os: { total: 1, packages: [{ name: 'a', from: '1', to: '2' }], keptBack: [] } })
    );
    expect(text()).toContain('1 package can be upgraded:');
    await show(
      ok({ os: { total: 400, packages: [{ name: 'a', from: '1', to: '2' }], keptBack: [] } })
    );
    expect(text()).toContain('400 packages can be upgraded (the first 1 are listed):');
  });

  it('names what apt keeps back, and what that needs', async () => {
    await show(ok({ os: { total: 0, packages: [], keptBack: ['raspi-firmware', 'libcamera0'] } }));
    expect(text()).toContain('2 kept back by apt: raspi-firmware, libcamera0');
    expect(text()).toContain('apt-get full-upgrade');
    // with packages kept back it is not "everything": the page must not say both
    expect(text()).not.toContain('Everything is up to date.');
  });

  it('says everything is up to date only when nothing is waiting and nothing is kept back', async () => {
    await show(ok());
    expect(text()).toContain('Everything is up to date.');
    await show(ok({ os: { total: 0, packages: [], keptBack: ['held'] } }));
    expect(text()).not.toContain('Everything is up to date.');
    // a tarball install is not apt's to judge: nothing waiting there says nothing about PiPulse
    await show(
      ok({ pipulse: { source: 'other', installed: null, candidate: null, available: false } })
    );
    expect(text()).not.toContain('Everything is up to date.');
    // kept-back packages (a deliberate `apt-mark hold` shows up there) never raise the badge
    expect(waitingCount(ok({ os: { total: 0, packages: [], keptBack: ['held'] } }))).toBe(0);
  });

  it('when: checked twice, and a stale-lists warning with the command', async () => {
    await show(ok());
    expect(text()).toContain('Apt last refreshed the package lists 1 h ago (');
    expect(text()).not.toContain('ago ago');
    // it says when apt ran, and that this is not proof of a successful fetch
    expect(text()).toContain('not that it reached the repositories');
    expect(text()).not.toContain('for more than two days');
    await show(ok({ listsRefreshedAt: NOW - STALE_LISTS_MS - 1 }));
    expect(text()).toContain('for more than two days');
    expect(text()).toContain('sudo apt-get update');
    await show(ok({ listsRefreshedAt: null }));
    expect(text()).toContain('last refreshed the package lists is unknown');
  });
});

describe('Copy', () => {
  it('copies the command and says so, then goes quiet', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await show({ state: 'unsupported', reason: 'container' });
    await act(async () => {
      root.querySelector<HTMLButtonElement>('button.link-button')!.click();
    });
    expect(writeText).toHaveBeenCalledWith(DOCKER_COMMAND);
    expect(text()).toContain('Copied.');
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(text()).not.toContain('Copied.');
    vi.useRealTimers();
  });

  it('says to select the text when the page may not use the clipboard (plain HTTP)', async () => {
    vi.stubGlobal('navigator', {});
    await show({ state: 'unsupported', reason: 'container' });
    await act(async () => {
      root.querySelector<HTMLButtonElement>('button.link-button')!.click();
    });
    expect(text()).toContain('Select the command and copy it');
  });
});

describe('Check now, when the failure has no message', () => {
  it('falls back to a plain sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('');
      })
    );
    await show(ok(), { session: signedIn });
    const button = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Check now')!;
    await act(async () => button.click());
    await vi.waitFor(() => expect(text()).toContain('The check could not be run.'));
  });
});

describe('Check now', () => {
  it('is for a signed-in visitor: it posts, shows the new view, and is disabled meanwhile', async () => {
    let resolve!: (body: UpdatesView) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((r) => (resolve = (body) => r(Response.json(body))))
    );
    vi.stubGlobal('fetch', fetchMock);
    const seen: UpdatesView[] = [];
    await show(ok(), { session: signedIn, onView: (v) => seen.push(v) });
    const button = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Check now')!;
    await act(async () => button.click());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/updates/check',
      expect.objectContaining({ method: 'POST' })
    );
    expect(text()).toContain('Checking…');
    expect(root.querySelector('button[disabled]')).not.toBeNull();
    await act(async () => resolve(ok({ os: { total: 5, packages: [], keptBack: [] } })));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ state: 'ok', os: { total: 5 } });
  });

  it('says why it failed instead of staying silent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 }))
    );
    await show(ok(), { session: signedIn });
    const button = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Check now')!;
    await act(async () => button.click());
    await vi.waitFor(() => expect(root.querySelector('.alert-severity')).not.toBeNull());
    expect(text()).not.toContain('Checking…');
  });
});
