/**
 * The version this dashboard bundle was built as. The release stamps it at build time
 * (PIPULSE_WEB_VERSION, see vite.config.ts); a development or test build says `dev`.
 */
declare const __PIPULSE_WEB_VERSION__: string | undefined;
export const WEB_VERSION: string =
  typeof __PIPULSE_WEB_VERSION__ === 'string' && __PIPULSE_WEB_VERSION__ !== ''
    ? __PIPULSE_WEB_VERSION__
    : 'dev';

/**
 * Whether the page in the browser is not the dashboard the server now ships (a cached page
 * from before an upgrade, or a server rolled back). Only two known, different versions
 * count: a development build or a server with no version says nothing.
 */
export function staleDashboard(web: string, server: string | undefined): boolean {
  return web !== '' && web !== 'dev' && server !== undefined && server !== 'dev' && web !== server;
}
