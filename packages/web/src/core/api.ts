/** An API answer other than 2xx; `body` is the parsed JSON body when there is one. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown
  ) {
    super(`the PiPulse server answered ${status}`);
  }
}

/** Fires 'unauthorized' on any 401, so the app can ask for a sign-in. */
export const authEvents = new EventTarget();

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await (init ? fetch(path, init) : fetch(path));
  if (response.status === 401) authEvents.dispatchEvent(new Event('unauthorized'));
  return response;
}

async function parse<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new HttpError(response.status, body);
  return body as T;
}

export async function getJson<T>(path: string): Promise<T> {
  return parse<T>(await apiFetch(path));
}

export async function sendJson<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  return parse<T>(
    await apiFetch(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    })
  );
}

export interface Session {
  /** A password is configured, so signing in can enable editing. */
  editable: boolean;
  signedIn: boolean;
  /** Every read needs a session too. */
  protectReads: boolean;
}

export const NO_SESSION: Session = { editable: false, signedIn: false, protectReads: false };

/** The session state; an older server (no /api/session) reads as read-only. */
export async function loadSession(): Promise<Session> {
  try {
    return await getJson<Session>('/api/session');
  } catch {
    return NO_SESSION;
  }
}
