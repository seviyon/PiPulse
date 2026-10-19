import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

const NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/**
 * The host's name. A container's own name can differ from the host's (Docker Desktop, Colima),
 * so the image mounts the host's /etc/hostname under PIPULSE_HOST_ROOT; PIPULSE_HOSTNAME
 * overrides both. Anything unreadable or not a plain name falls back to the process's own.
 */
export function hostName(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8')
): string {
  const explicit = env['PIPULSE_HOSTNAME']?.trim();
  if (explicit && NAME.test(explicit)) return explicit;
  const root = env['PIPULSE_HOST_ROOT']?.trim();
  if (root) {
    try {
      const name = read(`${root}/etc/hostname`).trim();
      if (NAME.test(name)) return name;
    } catch {
      // not mounted: use the process's own name
    }
  }
  return hostname();
}
