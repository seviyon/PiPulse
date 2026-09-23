import { useEffect, useState } from 'preact/hooks';

export const RANGES = [
  { id: '1h', label: '1 hour', ms: 3_600_000 },
  { id: '6h', label: '6 hours', ms: 6 * 3_600_000 },
  { id: '24h', label: '24 hours', ms: 24 * 3_600_000 },
  { id: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { id: '30d', label: '30 days', ms: 30 * 86_400_000 },
  { id: '1y', label: '1 year', ms: 365 * 86_400_000 }
] as const;

export type RangeId = (typeof RANGES)[number]['id'];

export type Route =
  { page: 'now' } | { page: 'history'; range: RangeId } | { page: 'alerts' } | { page: 'settings' };

const DEFAULT_RANGE: RangeId = '24h';

function isRange(value: string | null): value is RangeId {
  return RANGES.some((range) => range.id === value);
}

/**
 * Hash routes, so any view can be bookmarked and the API server needs no
 * page routes: "#/" is the live dashboard, "#/history?range=7d" history,
 * "#/alerts" the alerts page, "#/settings" settings.
 */
export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  if (path === '/alerts') return { page: 'alerts' };
  if (path === '/settings') return { page: 'settings' };
  if (path !== '/history') return { page: 'now' };
  const range = new URLSearchParams(query).get('range');
  return { page: 'history', range: isRange(range) ? range : DEFAULT_RANGE };
}

export function routeHash(route: Route): string {
  if (route.page === 'history') return `#/history?range=${route.range}`;
  if (route.page === 'settings') return '#/settings';
  return route.page === 'alerts' ? '#/alerts' : '#/';
}

/** The current route, updated on every hashchange (links, back/forward). */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', update);
    return () => removeEventListener('hashchange', update);
  }, []);
  return route;
}
