import { useEffect, useRef, useState } from 'preact/hooks';
import { sendJson, type Session } from '../core/api.js';
import { isUpdatesView } from '../core/guards.js';
import { formatAge, formatDateTime } from '../core/format.js';
import { StatusIcon } from '../core/status-icon.js';
import type { UpdatesReach, UpdatesView } from '../core/types.js';
import { routeHash } from '../router.js';
import {
  DOCKER_COMMAND,
  PIPULSE_APT_COMMAND,
  STALE_LISTS_MS,
  UPGRADE_COMMAND,
  waitingCount
} from './updates.js';

/** A command to run over SSH, selectable, with a button that copies it where the browser allows. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('yes');
    } catch {
      // Not a secure page (plain HTTP) or no permission: the text is selectable instead.
      setCopied('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied('no'), 4000);
  };
  return (
    <p class="command">
      <code>{text}</code>{' '}
      <button type="button" class="link-button" onClick={copy}>
        Copy
      </button>
      <span role="status" class="waiting">
        {copied === 'yes' && ' Copied.'}
        {copied === 'failed' && ' Select the command and copy it (Ctrl/Cmd+C).'}
      </span>
    </p>
  );
}

/** Whether the repositories answered, kept apart from whether updates are waiting. */
function Reach({ reach, now }: { reach: UpdatesReach; now: number }) {
  const last =
    reach.succeededAt === null
      ? 'every repository has not answered since PiPulse started'
      : `last time every repository answered: ${formatAge(now - reach.succeededAt)}`;
  const at = reach.attemptedAt === null ? '' : ` (tried ${formatDateTime(reach.attemptedAt)})`;
  if (reach.state === 'no-sources') return <p>No apt repositories are configured here.</p>;
  if (reach.state === 'ok')
    return (
      <p>
        All {reach.total} {reach.total === 1 ? 'repository' : 'repositories'} answered with signed
        metadata{at}.
      </p>
    );
  return (
    <p class="alert-severity">
      <StatusIcon level="warning" />
      {reach.state === 'partial'
        ? `Only ${reach.reached} of ${reach.total} repositories answered with signed metadata${at}; ${last}.`
        : reach.total === 0
          ? `The repositories could not be checked${at}; ${last}.`
          : `No repository answered with signed metadata${at}; ${last}.`}{' '}
      The update list above may be out of date. See <code>sudo apt-get update</code> for the reason.
    </p>
  );
}

function When({ view, now }: { view: Extract<UpdatesView, { state: 'ok' }>; now: number }) {
  const stale = view.listsRefreshedAt !== null && now - view.listsRefreshedAt > STALE_LISTS_MS;
  return (
    <section aria-labelledby="updates-when">
      <h2 id="updates-when">When</h2>
      <p>Checked {formatDateTime(view.checkedAt)}.</p>
      <Reach reach={view.reach} now={now} />
      {view.listsRefreshedAt === null ? (
        <p>When apt last refreshed the package lists is unknown.</p>
      ) : (
        <p>
          Apt last refreshed the package lists {formatAge(now - view.listsRefreshedAt)} (
          {formatDateTime(view.listsRefreshedAt)}). That says when it ran, not that it reached the
          repositories: if the Pi was offline, the lists may be older than this.
        </p>
      )}
      {stale && (
        <p class="alert-severity">
          <StatusIcon level="warning" />
          Apt has not refreshed the package lists for more than two days, so newer updates may not
          show here. Refresh them with <code>sudo apt-get update</code>.
        </p>
      )}
    </section>
  );
}

/**
 * Whether PiPulse and the operating system have updates waiting, as `apt-get upgrade` sees them.
 * Nothing here changes the system: the command to run is shown, and Check now only re-reads.
 */
export function UpdatesPage({
  view,
  session,
  version,
  now,
  onView
}: {
  view: UpdatesView | undefined;
  session: Session;
  /** The running PiPulse version (from /api/config). */
  version: string | undefined;
  now: number;
  onView: (view: UpdatesView) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const check = async () => {
    setChecking(true);
    setProblem(undefined);
    try {
      onView(await sendJson<UpdatesView>('POST', '/api/updates/check', isUpdatesView));
    } catch (error) {
      setProblem((error as Error).message || 'The check could not be run.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div class="updates-page">
      <h2>Updates</h2>
      {view === undefined && session.editable && !session.signedIn && (
        <p class="note">
          <a href={routeHash({ page: 'settings' })}>Sign in</a> to see what is waiting: the list of
          packages is shown only to a signed-in administrator.
        </p>
      )}
      {view === undefined && !(session.editable && !session.signedIn) && (
        <p class="waiting">Loading</p>
      )}
      {view?.state === 'unsupported' && view.reason === 'container' && (
        <>
          <p>
            PiPulse is running in Docker, so it can't see this host's packages. Update the PiPulse
            image with:
          </p>
          <Command text={DOCKER_COMMAND} />
          <p>The host's own updates are the host's to install.</p>
        </>
      )}
      {view?.state === 'unsupported' && view.reason === 'no-apt' && (
        <p>This system doesn't use apt, so PiPulse can't check for package updates.</p>
      )}
      {view?.state === 'pending' && (
        <p class="waiting">
          Not checked yet: the first check runs a couple of minutes after PiPulse starts.
        </p>
      )}
      {view?.state === 'failed' && (
        <p class="alert-severity">
          <StatusIcon level="warning" />
          The last check ({formatDateTime(view.checkedAt)}) failed: {view.problem}
        </p>
      )}
      {view?.state === 'ok' && (
        <>
          <section aria-labelledby="updates-pipulse">
            <h2 id="updates-pipulse">PiPulse</h2>
            {view.pipulse.source === 'apt' ? (
              view.pipulse.available ? (
                <>
                  <p>
                    <StatusIcon level="warning" />A newer PiPulse is available:{' '}
                    {view.pipulse.installed ?? 'installed'} → {view.pipulse.candidate ?? 'newer'}.
                    Install it with:
                  </p>
                  <Command text={PIPULSE_APT_COMMAND} />
                </>
              ) : (
                <p>PiPulse {version ?? view.pipulse.installed} is up to date.</p>
              )
            ) : (
              <p>
                PiPulse {version} was not installed from the apt repository, so it can't tell
                whether a newer one exists. Update it by running the installer again (see the
                install guide).
              </p>
            )}
          </section>
          <section aria-labelledby="updates-os">
            <h2 id="updates-os">System packages</h2>
            {view.os.total === 0 ? (
              <p>No package upgrades are waiting.</p>
            ) : (
              <>
                <p>
                  <StatusIcon level="warning" />
                  {view.os.total} {view.os.total === 1 ? 'package' : 'packages'} can be upgraded
                  {view.os.packages.length < view.os.total &&
                    ` (the first ${view.os.packages.length} are listed)`}
                  :
                </p>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Package</th>
                      <th scope="col">Installed</th>
                      <th scope="col">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.os.packages.map((p) => (
                      <tr key={p.name}>
                        <th scope="row">{p.name}</th>
                        <td>{p.from}</td>
                        <td>{p.to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p>Install them over SSH:</p>
                <Command text={UPGRADE_COMMAND} />
                <p class="waiting">
                  Upgrades can restart services (this Pi's DNS or web server, PiPulse itself) and
                  some need a reboot.
                </p>
              </>
            )}
            {view.os.keptBack.length > 0 && (
              <>
                <p>
                  {view.os.keptBack.length} kept back by apt: {view.os.keptBack.join(', ')}. These
                  need <code>sudo apt-get full-upgrade</code>, which may also install or remove
                  packages: read what it plans before you agree.
                </p>
              </>
            )}
          </section>
          <When view={view} now={now} />
        </>
      )}
      {view !== undefined && view.state !== 'unsupported' && (
        <p>
          {session.signedIn ? (
            <button type="button" onClick={check} disabled={checking}>
              {checking ? 'Checking…' : 'Check now'}
            </button>
          ) : (
            <span class="waiting">Sign in (Settings) to check now.</span>
          )}
          {problem && <span class="alert-severity"> {problem}</span>}
        </p>
      )}
      {view?.state === 'ok' &&
        waitingCount(view) === 0 &&
        view.os.keptBack.length === 0 &&
        view.pipulse.source === 'apt' && <p class="waiting">Everything is up to date.</p>}
    </div>
  );
}
