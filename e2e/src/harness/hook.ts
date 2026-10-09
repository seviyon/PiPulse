import { pathToFileURL } from 'node:url';
import { SERVER_JS } from './paths.js';

const SERVER_URL = pathToFileURL(SERVER_JS).href;

/** The two packages whose imports are swapped, and the module that stands in for each. */
const FAKES: Readonly<Record<string, string>> = {
  '@pipulse/collector': new URL('./fake-collector.js', import.meta.url).href,
  '@pipulse/alerts': new URL('./fake-alerts.js', import.meta.url).href
};

interface ModuleApi {
  registerHooks?: (hooks: {
    resolve(
      specifier: string,
      context: { parentURL: string | undefined },
      nextResolve: (
        specifier: string,
        context?: { parentURL?: string | undefined }
      ) => { url: string }
    ): { url: string; format?: string; shortCircuit?: boolean };
  }) => unknown;
}

/**
 * Redirects '@pipulse/collector' and '@pipulse/alerts' to the fakes, only for imports made by
 * the real packages/api/dist/server.js. The fakes import the real packages themselves; their
 * importer is not the server, so those imports resolve normally and nothing loops.
 */
export function install(moduleApi: ModuleApi): void {
  if (typeof moduleApi.registerHooks !== 'function') {
    throw new Error('e2e harness needs Node >= 22.15 (module.registerHooks)');
  }
  moduleApi.registerHooks({
    resolve(specifier, context, nextResolve) {
      const fake = FAKES[specifier];
      if (fake !== undefined && context.parentURL === SERVER_URL) {
        return { url: fake, format: 'module', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  });
}
