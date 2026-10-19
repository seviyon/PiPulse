import { describe, expect, it } from 'vitest';
import { createRuleSource } from '@pipulse/alerts';
import { builtinPlugins } from '@pipulse/collector';
import { openDb } from '@pipulse/storage';
import * as api from '../src/index.js';

// What the package exports (types are erased), as of the refactor's base commit.
const EXPORTS = [
  'buildServer',
  'createFeed',
  'createLiveFeed',
  'healthBody',
  'longestLookBack',
  'rawRetentionProblem',
  'readGeneratedExtras',
  'tlsView'
];

// `printRoutes` with every optional module on, as sorted lines, so the order routes are
// registered in does not matter (the order of hooks and plugins does, and other tests cover it).
const FULL_ROUTES = [
  '* (HEAD, GET)',
  '/api/alerts (GET, HEAD)',
  '/api/config (GET, HEAD)',
  '/api/health (GET, HEAD)',
  '/api/live (GET, HEAD)',
  '/api/login (POST)',
  '/api/logout (POST)',
  '/api/metrics/:id/history (GET, HEAD)',
  '/api/metrics/:id/series (GET, HEAD)',
  '/api/metrics/latest (GET, HEAD)',
  '/api/notify (GET, HEAD)',
  '/api/session (GET, HEAD)',
  '/api/settings (GET, HEAD, PUT)',
  '/api/updates (GET, HEAD)',
  '/health (GET, HEAD)',
  '/check (POST)',
  '/:id (PUT, DELETE)',
  '/:id/acknowledge (POST)',
  '/preview (POST)',
  '/rules (GET, HEAD, POST)'
];

const MINIMAL_ROUTES = [
  '/api/alerts (GET, HEAD)',
  '/api/config (GET, HEAD)',
  '/api/health (GET, HEAD)',
  '/api/login (POST)',
  '/api/logout (POST)',
  '/api/metrics/:id/history (GET, HEAD)',
  '/api/metrics/:id/series (GET, HEAD)',
  '/api/metrics/latest (GET, HEAD)',
  '/api/notify (GET, HEAD)',
  '/api/session (GET, HEAD)',
  '/api/updates (GET, HEAD)',
  '/health (GET, HEAD)',
  '/check (POST)',
  '/:id/acknowledge (POST)'
];

/** The route lines of `printRoutes`, without the tree drawing, sorted. */
function routeLines(tree: string): string[] {
  return tree
    .split('\n')
    .map((line) => line.replace(/^[│├└─\s]+/u, '').trim())
    .filter((line) => line !== '')
    .sort();
}

describe('the api package surface', () => {
  it('exports exactly these names', () => {
    expect(Object.keys(api).sort()).toEqual(EXPORTS);
  });

  it('registers exactly these routes when every optional module is on', async () => {
    const db = openDb(':memory:');
    const rules = createRuleSource(db, {
      cores: 4,
      metrics: builtinPlugins.map(({ id, intervalMs }) => ({ id, intervalMs })),
      rawRetention: () => ({ ms: 172_800_000, text: '2d' }),
      onProblem: () => {}
    });
    const app = api.buildServer(db, {
      live: api.createLiveFeed(),
      alertFeed: api.createFeed(),
      alertRules: { source: rules, recheck: () => {} },
      settings: { getRetention: () => ({}) as never, metrics: [], rawAtLeast: () => 0 },
      notify: { status: () => [] },
      webRoot: '/tmp',
      auth: { protectReads: false }
    });
    await app.ready();
    expect(routeLines(app.printRoutes({ commonPrefix: false }))).toEqual([...FULL_ROUTES].sort());
    await app.close();
    db.close();
  });

  it('registers exactly these routes with no options', async () => {
    const db = openDb(':memory:');
    const app = api.buildServer(db);
    await app.ready();
    expect(routeLines(app.printRoutes({ commonPrefix: false }))).toEqual(
      [...MINIMAL_ROUTES].sort()
    );
    await app.close();
    db.close();
  });
});
