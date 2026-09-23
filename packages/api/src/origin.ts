/**
 * Accepts non-browser clients (no Origin header), same-host pages, and
 * explicitly allowed origins; rejects every other cross-site page.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowed: string[]
): boolean {
  if (origin === undefined) return true;
  if (allowed.includes(origin)) return true;
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    // e.g. the literal "null" origin sent by sandboxed iframes and file:// pages
    return false;
  }
}
