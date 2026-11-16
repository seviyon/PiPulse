import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { NotificationsSection } from '../../src/settings/notifications.js';
import { formatDateTime } from '../../src/core/format.js';
import type { WebhookStatus } from '../../src/core/types.js';

const at = (hh: number, mm: number) => new Date(2026, 8, 24, hh, mm).getTime();

const webhooks: WebhookStatus[] = [
  {
    id: 'apprise',
    host: 'apprise.lan:8000',
    method: 'POST',
    events: ['raised', 'cleared'],
    minSeverity: 'warning',
    pending: 0,
    lastSuccessAt: at(10, 42),
    lastFailure: null
  },
  {
    id: 'ntfy',
    host: 'ntfy.sh',
    method: 'POST',
    events: ['raised'],
    minSeverity: 'critical',
    pending: 3,
    lastSuccessAt: at(9, 0),
    lastFailure: { at: at(10, 40), reason: 'timeout' }
  }
];

let root: HTMLElement;
let answer: () => Response;

beforeEach(() => {
  answer = () => Response.json(webhooks);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/notify' ? answer() : new Response('not found', { status: 404 })
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
  await act(async () => {
    render(<NotificationsSection />, root);
  });
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(root.textContent).not.toContain('Loading');
  });
}

const row = (id: string) =>
  [...root.querySelectorAll('.webhook-list li')].find((li) =>
    li.textContent?.includes(id)
  ) as HTMLElement;

describe('NotificationsSection', () => {
  it('lists each webhook with its host, filters and delivery status', async () => {
    await show();
    expect(root.querySelector('h2')?.textContent).toBe('Notifications');
    expect(root.textContent).toContain('PIPULSE_NOTIFY_FILE');

    const apprise = row('apprise');
    expect(apprise.textContent).toContain('apprise.lan:8000');
    expect(apprise.textContent).toContain('raised and cleared, warning and up');
    expect(apprise.textContent).toContain(`Last delivered ${formatDateTime(at(10, 42))}`);
    expect(apprise.textContent).not.toContain('Last failed');
    expect(apprise.textContent).not.toContain('waiting');
    expect(apprise.textContent).not.toContain('Failing');
    expect(apprise.querySelector('svg')).toBeNull();

    const ntfy = row('ntfy');
    expect(ntfy.textContent).toContain('ntfy.sh');
    expect(ntfy.textContent).toContain('raised only, critical only');
    expect(ntfy.textContent).toContain(`Last delivered ${formatDateTime(at(9, 0))}`);
    expect(ntfy.textContent).toContain(`Last failed ${formatDateTime(at(10, 40))}: timeout`);
    expect(ntfy.textContent).toContain('3 waiting');
    expect(ntfy.textContent).toContain('Failing');
    expect(ntfy.querySelector('svg')).not.toBeNull();
  });

  it('is not failing once a delivery succeeds after the last failure', async () => {
    answer = () => Response.json([{ ...webhooks[1], lastSuccessAt: at(10, 45), pending: 0 }]);
    await show();
    expect(row('ntfy').textContent).not.toContain('Failing');
    expect(row('ntfy').querySelector('svg')).toBeNull();
  });

  it('says when no webhooks are configured', async () => {
    answer = () => Response.json([]);
    await show();
    expect(root.textContent).toContain('No webhooks configured — set PIPULSE_NOTIFY_FILE.');
  });

  it('treats a non-array answer (an older server) as none configured', async () => {
    answer = () => Response.json({ error: 'not here' });
    await show();
    expect(root.textContent).toContain('No webhooks configured — set PIPULSE_NOTIFY_FILE.');
  });

  it('says when the status could not be loaded', async () => {
    answer = () => new Response('boom', { status: 500 });
    await show();
    expect(root.textContent).toContain(
      "Couldn't load the notification status from the PiPulse server."
    );
  });
});

describe('NotificationsSection, a webhook in trouble', () => {
  const troubled: WebhookStatus = {
    ...webhooks[1]!,
    needsAttention: { reason: 'HTTP 401' },
    degradedSince: at(8, 15),
    counts: { openedAndCleared: 3, cleared: 1, rejected: 2, abandoned: 1, dropped: 4 },
    lastSummaryAt: at(8, 50)
  };

  it('shows needs attention with its reason and a hint, with an icon and words', async () => {
    answer = () => Response.json([troubled]);
    await show();
    const ntfy = row('ntfy');
    expect(ntfy.textContent).toContain('Needs attention: HTTP 401. Check the URL and credentials.');
    expect(ntfy.querySelectorAll('svg').length).toBeGreaterThan(0);
  });

  it('shows how long delivery has been delayed, the counts that are not zero and the last summary', async () => {
    answer = () => Response.json([troubled]);
    await show();
    const text = row('ntfy').textContent!;
    expect(text).toContain(`Delivery delayed since ${formatDateTime(at(8, 15))}`);
    expect(text).toContain('3 opened and cleared, 1 cleared, 2 rejected, 1 abandoned, 4 dropped');
    expect(text).toContain(`Last summary ${formatDateTime(at(8, 50))}`);
  });

  it('leaves out counts that are zero, and the whole line when all are', async () => {
    answer = () =>
      Response.json([
        {
          ...troubled,
          counts: { openedAndCleared: 0, cleared: 0, rejected: 2, abandoned: 0, dropped: 0 }
        },
        {
          ...webhooks[0],
          counts: { openedAndCleared: 0, cleared: 0, rejected: 0, abandoned: 0, dropped: 0 }
        }
      ]);
    await show();
    expect(row('ntfy').textContent).toContain('2 rejected');
    expect(row('ntfy').textContent).not.toContain('opened and cleared');
    expect(row('apprise').textContent).not.toContain('Suppressed or lost');
  });

  it('still renders an answer from a server that has none of the new fields', async () => {
    await show();
    expect(row('apprise').textContent).not.toContain('Needs attention');
    expect(row('apprise').textContent).not.toContain('Delivery delayed');
  });
});
