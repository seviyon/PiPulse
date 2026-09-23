import { useState } from 'preact/hooks';

const MESSAGES: Record<number, string> = {
  401: 'Sign-in failed. Check the password and try again.',
  403: 'Editing is disabled on this PiPulse: no admin password is configured.',
  429: 'Too many attempts. Wait 15 minutes, then try again.'
};

/**
 * The password form. Posts with plain fetch, not apiFetch: a wrong password
 * answers 401, which must not count as "the session expired".
 */
export function SignIn({ heading, onSignedIn }: { heading?: string; onSignedIn(): void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password })
      });
      if (response.ok) {
        setPassword('');
        onSignedIn();
        return;
      }
      setError(MESSAGES[response.status] ?? `The PiPulse server answered ${response.status}.`);
    } catch {
      setError("Couldn't reach the PiPulse server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="sign-in" onSubmit={submit}>
      <h2>{heading ?? 'Sign in'}</h2>
      <label>
        Password
        <input
          type="password"
          autocomplete="current-password"
          value={password}
          onInput={(event) => setPassword(event.currentTarget.value)}
        />
      </label>
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || password === ''}>
        Sign in
      </button>
    </form>
  );
}
