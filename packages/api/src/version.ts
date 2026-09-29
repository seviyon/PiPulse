import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * End of security support per Node major (nodejs/Release schedule). Renovate
 * can't know these dates: add a line here when bumping to a new Node major.
 */
export const NODE_SUPPORT_ENDS: Record<number, string> = {
  22: '2027-04-30',
  24: '2028-04-30',
  26: '2029-04-30'
};

/** The release version stamped into version.json at the app root; 'dev' in a checkout. */
export function readVersion(appRoot: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(appRoot, 'version.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : 'dev';
  } catch {
    return 'dev';
  }
}

export interface NodeSupport {
  version: string;
  line: number;
  /** YYYY-MM-DD, or null for a line not in NODE_SUPPORT_ENDS. */
  supportEnds: string | null;
  ended: boolean;
}

export function nodeSupport(nodeVersion = process.version, today = new Date()): NodeSupport {
  const version = nodeVersion.replace(/^v/, '');
  const line = Number(version.split('.')[0]);
  const supportEnds = NODE_SUPPORT_ENDS[line] ?? null;
  // Support runs through the whole last day, in local time.
  const ended =
    supportEnds !== null &&
    today.getTime() >= new Date(`${supportEnds}T00:00:00`).getTime() + 86_400_000;
  return { version, line, supportEnds, ended };
}
