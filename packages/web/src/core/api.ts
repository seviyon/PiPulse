import { isSession, type Guard } from './guards.js';

/** The server answered 2xx but not with what this page expects (an older or newer server, a proxy's page). */
export class BadResponse extends Error {
  constructor(path: string) {
    super(`the PiPulse server's answer for ${path} was not what this page expects`);
  }
}

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

/**
 * One path segment for an id that came from the server or a file: a `/`, `?` or `#` in it must
 * stay inside the segment.
 */
export const segment = (id: string | number): string => encodeURIComponent(String(id));

/** The body of a 2xx answer, checked by `guard`; anything else is an HttpError or a BadResponse. */
export async function parse<T>(response: Response, guard: Guard<T>, path = 'it'): Promise<T> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new HttpError(response.status, body);
  if (!guard(body)) throw new BadResponse(path);
  return body;
}

export async function getJson<T>(path: string, guard: Guard<T>): Promise<T> {
  return parse<T>(await apiFetch(path), guard, path);
}

export async function sendJson<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  guard: Guard<T>,
  body?: unknown
): Promise<T> {
  return parse<T>(
    await apiFetch(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    }),
    guard,
    path
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
    return await getJson<Session>('/api/session', isSession);
  } catch {
    return NO_SESSION;
  }
}
