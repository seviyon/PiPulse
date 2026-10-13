import type { UpdatesView } from './types.js';

/** What `apt-get upgrade` would do, as the command a person runs over SSH. */
export const UPGRADE_COMMAND = 'sudo apt-get update && sudo apt-get upgrade';
export const PIPULSE_APT_COMMAND =
  'sudo apt-get update && sudo apt-get install --only-upgrade pipulse';
export const DOCKER_COMMAND = 'docker compose pull && docker compose up -d';
export const UPGRADE_CONFIRM_WORD = 'upgrade';
export const UPGRADE_POLL_MS = 3000;
/** Lists older than this are said to be stale: apt-daily refreshes them every day. */
export const STALE_LISTS_MS = 2 * 86_400_000;

/** How many things are waiting: PiPulse's own update counts as one, plus the OS packages. */
export function waitingCount(view: UpdatesView | undefined): number {
  if (view?.state !== 'ok') return 0;
  return (
    view.os.total +
    (view.pipulse.available && !view.os.packages.some((p) => p.name === 'pipulse') ? 1 : 0)
  );
}
