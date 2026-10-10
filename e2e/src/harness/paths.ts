import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// e2e/src/harness (compiled: e2e/dist/harness) → three levels up is the repository root.
const here = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = realpathSync(resolve(here, '..', '..', '..'));
export const E2E_ROOT = join(REPO_ROOT, 'e2e');

// Built by the root `npm run build`; the harness never builds them.
export const SERVER_JS = join(REPO_ROOT, 'packages', 'api', 'dist', 'server.js');
export const WEB_DIST = join(REPO_ROOT, 'packages', 'web', 'dist');

export const TLS_FIXTURES = join(REPO_ROOT, 'packages', 'tls', 'test', 'fixtures');
