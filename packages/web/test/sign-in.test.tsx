import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SignIn } from '../src/sign-in.js';

let root: HTMLElement;
let answer: Response;
beforeEach(() => {
  answer = Response.json({ signedIn: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => answer)
  );
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

async function submit(password: string) {
  const input = root.querySelector('input[type=password]') as HTMLInputElement;
  await act(() => {
    input.value = password;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Retries `assertion`, letting fetch → response → setState chains settle between tries. */
async function eventually(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assertion();
  });
}

describe('SignIn', () => {
  it('posts the password unchanged and reports success', async () => {
    const onSignedIn = vi.fn();
    render(<SignIn onSignedIn={onSignedIn} />, root);
    await submit(' pass word ');
    await eventually(() => expect(onSignedIn).toHaveBeenCalledOnce());
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/login');
    expect(JSON.parse(String(init!.body))).toEqual({ password: ' pass word ' });
  });

  it.each([
    [401, /Sign-in failed/],
    [429, /Too many attempts/],
    [403, /no admin password/]
  ])('explains a %i', async (status, message) => {
    answer = new Response('{}', { status });
    render(<SignIn onSignedIn={() => {}} />, root);
    await submit('x');
    await eventually(() =>
      expect(root.querySelector('[role=alert]')?.textContent).toMatch(message)
    );
  });
});
