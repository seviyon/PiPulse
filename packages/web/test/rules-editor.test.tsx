import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { RulesSection } from '../src/rules-editor.js';
import type { PluginInfo, RuleEntry } from '../src/types.js';
import type { Session } from '../src/api.js';

const plugins: PluginInfo[] = [
  { id: 'cpu_load', label: 'CPU load', unit: '%', intervalMs: 5000 },
  { id: 'cpu_temperature', label: 'CPU temperature', unit: '°C', intervalMs: 10_000 }
];
const hot = {
  id: 'cpu_hot',
  metric: 'cpu_temperature',
  atLeast: 80,
  forMs: 120_000,
  clearAfterMs: 120_000,
  severity: 'critical' as const,
  message: 'CPU running hot',
  source: 'built-in' as const
};
const entry = (over: Partial<RuleEntry>): RuleEntry => ({
  id: 'cpu_hot',
  kind: 'built-in',
  disabled: false,
  rule: hot,
  written: {
    id: 'cpu_hot',
    metric: 'cpu_temperature',
    atLeast: 80,
    for: '2min',
    clearAfter: '2min',
    severity: 'critical',
    message: 'CPU running hot'
  },
  overrides: null,
  problem: null,
  saved: false,
  ...over
});
const signedIn: Session = { editable: true, signedIn: true, protectReads: false };

let entries: RuleEntry[];
let answer: (url: string, init?: RequestInit) => Response;
let root: HTMLElement;
beforeEach(() => {
  entries = [entry({})];
  answer = () => Response.json({ rules: entries });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => answer(url, init))
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
const show = async (session = signedIn) => {
  render(
    <RulesSection plugins={plugins} rules={[]} session={session} onSignedOut={() => {}} />,
    root
  );
  await settle();
};
const button = (name: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === name)!;
const calls = () => vi.mocked(fetch).mock.calls.map(([url, init]) => [init?.method ?? 'GET', url]);
const input = (id: string, value: string) =>
  act(() => {
    const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

describe('<RulesSection>', () => {
  it('lists rules in words with their kind and any problem', async () => {
    entries = [
      entry({}),
      entry({ id: 'x', kind: 'added', rule: null, problem: 'unknown metric "gone"', saved: true })
    ];
    await show();
    expect(root.textContent).toContain('CPU running hot');
    expect(root.textContent).toContain('CPU temperature ≥ 80 °C for 2 min');
    expect(root.textContent).toContain('Built-in');
    expect(root.textContent).toContain('Not in force: unknown metric "gone"');
  });

  it('shows a row action failure above the list, not inside any form', async () => {
    await show();
    answer = (_url, init) =>
      init?.method ? new Response('{}', { status: 500 }) : Response.json({ rules: entries });
    await act(() => button('Disable').click());
    await settle();
    const alert = root.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('500');
    expect(alert?.closest('form')).toBeNull();
  });

  it('is read-only when signed out, pointing at sign-in', async () => {
    await show({ editable: true, signedIn: false, protectReads: false });
    expect(root.querySelectorAll('button')).toHaveLength(0);
    expect(root.textContent).toContain('Sign in');
  });

  it('disables and reverts with the right requests', async () => {
    await show();
    await act(() => button('Disable').click());
    await settle();
    expect(calls().at(-1)).toEqual(['PUT', '/api/alerts/rules/cpu_hot']);
    entries = [entry({ kind: 'edited', saved: true, overrides: hot })];
    render(null, root);
    await show();
    expect(button('Revert')).toBeDefined();
    await act(() => button('Revert').click());
    await settle();
    expect(calls().at(-1)).toEqual(['DELETE', '/api/alerts/rules/cpu_hot']);
  });

  it('adds a rule through the form and shows server errors under their fields, focusing the first', async () => {
    await show();
    await act(() => button('Add rule').click());
    await input('rule-id', 'test_busy');
    await input('rule-metric', 'cpu_load');
    await input('rule-value', '50');
    await input('rule-message', 'Busy');
    answer = (_url, init) =>
      init?.method === 'POST'
        ? Response.json({ errors: { for: 'longer than raw retention (2d)' } }, { status: 400 })
        : Response.json({ rules: entries });
    await act(() => button('Save rule').click());
    await settle();
    const error = root.querySelector('#rule-for-error');
    expect(error?.textContent).toContain('longer than raw retention');
    expect(document.activeElement?.id).toBe('rule-for');
    const [url, init] = vi.mocked(fetch).mock.calls.at(-1)!;
    expect(url).toBe('/api/alerts/rules');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(String(init!.body))).toMatchObject({
      id: 'test_busy',
      metric: 'cpu_load',
      atLeast: 50
    });
  });

  it('sends Add as POST and Edit as PUT', async () => {
    await show();
    await act(() => button('Add rule').click());
    await input('rule-id', 'new_rule');
    await input('rule-metric', 'cpu_load');
    await input('rule-value', '50');
    await input('rule-message', 'Busy');
    await act(() => button('Save rule').click());
    await settle();
    expect(calls().at(-1)).toEqual(['POST', '/api/alerts/rules']);

    render(null, root);
    await show();
    await act(() => button('Edit').click());
    await act(() => button('Save rule').click());
    await settle();
    expect(calls().at(-1)).toEqual(['PUT', '/api/alerts/rules/cpu_hot']);
  });

  it('refuses to add an id already in the list, without sending a request', async () => {
    entries = [entry({}), entry({ id: 'test_busy', kind: 'added', saved: true })];
    await show();
    await act(() => button('Add rule').click());
    await input('rule-id', 'test_busy');
    await input('rule-metric', 'cpu_load');
    await input('rule-value', '50');
    await input('rule-message', 'Busy');
    const before = vi.mocked(fetch).mock.calls.length;
    await act(() => button('Save rule').click());
    const error = root.querySelector('#rule-id-error');
    expect(error?.textContent).toContain('already exists');
    expect(document.activeElement?.id).toBe('rule-id');
    expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  });

  it('maps a 409 from the server onto the Id field', async () => {
    await show();
    await act(() => button('Add rule').click());
    await input('rule-id', 'test_busy');
    await input('rule-metric', 'cpu_load');
    await input('rule-value', '50');
    await input('rule-message', 'Busy');
    answer = (_url, init) =>
      init?.method === 'POST'
        ? Response.json(
            { errors: { id: 'a rule with this id already exists; edit it instead' } },
            { status: 409 }
          )
        : Response.json({ rules: entries });
    await act(() => button('Save rule').click());
    await settle();
    const error = root.querySelector('#rule-id-error');
    expect(error?.textContent).toContain('already exists');
    expect(document.activeElement?.id).toBe('rule-id');
  });

  it('shows Edit and Disable for an added rule that is not in force, prefilled from written', async () => {
    entries = [
      entry({
        id: 'ghost_metric',
        kind: 'added',
        rule: null,
        problem: 'unknown metric "gone"',
        saved: true,
        written: {
          id: 'ghost_metric',
          metric: 'gone',
          atLeast: 50,
          for: '1min',
          severity: 'warning',
          message: 'Busy'
        }
      })
    ];
    await show();
    expect(button('Edit')).toBeDefined();
    expect(button('Disable')).toBeDefined();
    expect(root.querySelectorAll('button').length).toBeGreaterThan(0);
    await act(() => button('Edit').click());
    expect(root.querySelector<HTMLInputElement>('#rule-value')!.value).toBe('50');
  });

  it('offers only Delete for an orphaned bare disable', async () => {
    entries = [
      entry({
        id: 'gone_rule',
        kind: 'added',
        rule: null,
        problem: 'no built-in or file rule "gone_rule" to disable',
        saved: true,
        written: { id: 'gone_rule', disabled: true }
      })
    ];
    await show();
    const buttons = [...root.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Delete');
    expect(buttons).not.toContain('Edit');
    expect(buttons).not.toContain('Disable');
    expect(buttons).not.toContain('Enable');
  });

  it('keeps a disabled rule disabled when it is edited', async () => {
    entries = [entry({ disabled: true, saved: true })];
    await show();
    await act(() => button('Edit').click());
    await input('rule-value', '75');
    await act(() => button('Save rule').click());
    await settle();
    const [url, init] = vi.mocked(fetch).mock.calls.find(([, i]) => i?.method === 'PUT')!;
    expect(url).toBe('/api/alerts/rules/cpu_hot');
    expect(JSON.parse(String(init!.body))).toMatchObject({ atLeast: 75, disabled: true });
  });

  it('sends an enabled rule without disabled when it is edited', async () => {
    await show();
    await act(() => button('Edit').click());
    await act(() => button('Save rule').click());
    await settle();
    const [, init] = vi.mocked(fetch).mock.calls.find(([, i]) => i?.method === 'PUT')!;
    expect(JSON.parse(String(init!.body))).not.toHaveProperty('disabled');
  });

  it("shows a refused Revert's reason above the list", async () => {
    entries = [entry({ kind: 'edited', saved: true, overrides: hot })];
    await show();
    answer = (_url, init) =>
      init?.method === 'DELETE'
        ? Response.json(
            {
              errors: {
                for: 'longer than raw retention (1h); raise it on the Settings page first'
              }
            },
            { status: 400 }
          )
        : Response.json({ rules: entries });
    await act(() => button('Revert').click());
    await settle();
    const alert = root.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      'longer than raw retention (1h); raise it on the Settings page first'
    );
    expect(alert?.closest('form')).toBeNull();
    expect(root.querySelector('.rule-form')).toBeNull();
  });

  it('closes the form when the rule being edited disappears', async () => {
    await show();
    await act(() => button('Edit').click());
    expect(root.querySelector('.rule-form')).not.toBeNull();
    // Another tab deleted it: the next reload no longer lists it.
    entries = [entry({ id: 'cpu_warm' })];
    render(
      <RulesSection plugins={plugins} rules={[]} session={signedIn} onSignedOut={() => {}} />,
      root
    );
    await settle();
    await vi.waitFor(() => expect(root.querySelector('.rule-form')).toBeNull());
    expect(button('Add rule')).toBeDefined();
  });

  it('offers "Every metric" only for a no-reading rule', async () => {
    await show();
    await act(() => button('Add rule').click());
    const options = () =>
      [...root.querySelectorAll('#rule-metric option')].map((o) => o.textContent);
    expect(options()).not.toContain('Every metric');
    await input('rule-condition', 'noReadingFor');
    expect(options()).toContain('Every metric');
    expect(root.querySelector('#rule-clearAfter')).toBeNull();
  });

  it('falls back to signed out on a 401', async () => {
    const onSignedOut = vi.fn();
    render(
      <RulesSection plugins={plugins} rules={[]} session={signedIn} onSignedOut={onSignedOut} />,
      root
    );
    await settle();
    answer = (_url, init) =>
      init?.method ? new Response('{}', { status: 401 }) : Response.json({ rules: entries });
    await act(() => button('Disable').click());
    await settle();
    expect(onSignedOut).toHaveBeenCalled();
  });
});
