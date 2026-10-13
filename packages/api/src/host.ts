import { isIP } from 'node:net';
import { canonicalName } from '@pipulse/tls';

const LABELS = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The host name or address in a Host header, lower-case, without port, brackets or a trailing
 * dot; undefined when the header is missing or not a host.
 */
export function hostOf(header: string | undefined): string | undefined {
  const text = header?.trim().toLowerCase();
  if (!text) return undefined;
  let host: string;
  let rest: string;
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return undefined;
    host = text.slice(1, end);
    rest = text.slice(end + 1);
    if (isIP(host) !== 6) return undefined;
  } else {
    const colon = text.indexOf(':');
    host = colon < 0 ? text : text.slice(0, colon);
    rest = colon < 0 ? '' : text.slice(colon);
  }
  if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return undefined;
  host = host.replace(/\.$/, '');
  return isIP(host) !== 0 || LABELS.test(host) ? host : undefined;
}

/**
 * Whether a request for this Host may be served when PIPULSE_ALLOWED_HOSTS is set. An address
 * and `localhost` always are: DNS rebinding works through a name an attacker controls, and a
 * browser that was sent to an address sends that address. Any other name must be listed.
 */
export function isAllowedHost(header: string | undefined, allowed: string[]): boolean {
  const host = hostOf(header);
  if (host === undefined) return false;
  return isIP(host) !== 0 || host === 'localhost' || allowed.includes(host);
}

/**
 * PIPULSE_ALLOWED_HOSTS: comma-separated host names (no ports, schemes or wildcards). Empty or
 * unset means no check, as before; a bad entry throws one line. `auto` alone turns the check on
 * with no names of the operator's own: only `extra` (the host's own name and the certificate names
 * the operator declared) are served, besides addresses and `localhost`. `extra` joins a list that
 * is set, never an empty one.
 */
export function parseAllowedHosts(text: string | undefined, extra: string[] = []): string[] {
  const names: string[] = [];
  let auto = false;
  for (const raw of (text ?? '').split(',')) {
    const entry = raw.trim();
    if (entry === '' || isIP(entry) !== 0) continue; // an address is allowed anyway
    if (entry.toLowerCase() === 'auto') {
      auto = true;
      continue;
    }
    try {
      names.push(canonicalName(entry));
    } catch {
      throw new Error(
        `PIPULSE_ALLOWED_HOSTS: "${entry.slice(0, 64)}" is not a host name (no ports, schemes or wildcards)`
      );
    }
  }
  if (names.length === 0 && !auto) return [];
  for (const name of extra) {
    try {
      names.push(canonicalName(name));
    } catch {
      // not a usable name: leave it out
    }
  }
  return [...new Set(names)];
}
