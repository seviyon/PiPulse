import { useEffect, useRef, useState } from 'preact/hooks';
import { getJson, sendJson, type Session } from './api.js';
import { formatAge, formatDateTime } from './format.js';
import { StatusIcon } from './tile.js';
import type { UpdatesView, UpgradeView } from './types.js';
import {
  DOCKER_COMMAND,
  PIPULSE_APT_COMMAND,
  STALE_LISTS_MS,
  UPGRADE_COMMAND,
  UPGRADE_CONFIRM_WORD,
  UPGRADE_POLL_MS,
  waitingCount
} from './updates.js';

/** A command to run over SSH, selectable, with a button that copies it where the browser allows. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const timer = useRef<ReturnType<typeof setTimeout>>();
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

function When({ view, now }: { view: Extract<UpdatesView, { state: 'ok' }>; now: number }) {
  const stale = view.listsRefreshedAt !== null && now - view.listsRefreshedAt > STALE_LISTS_MS;
  return (
    <section aria-labelledby="updates-when">
      <h2 id="updates-when">When</h2>
      <p>Checked {formatDateTime(view.checkedAt)}.</p>
      {view.listsRefreshedAt === null ? (
        <p>When the package lists were last refreshed is unknown.</p>
      ) : (
        <p>
          Package lists refreshed {formatAge(now - view.listsRefreshedAt)} (
          {formatDateTime(view.listsRefreshedAt)}).
        </p>
      )}
      {stale && (
        <p class="alert-severity">
          <StatusIcon level="warning" />
          The package lists are more than two days old, so newer updates may not show here. Refresh
          them with <code>sudo apt-get update</code>.
        </p>
      )}
    </section>
  );
}

const STEP_WORDS = { update: 'refreshing the package lists', upgrade: 'installing the upgrades' };

/**
 * The opt-in "install from here" button. A root helper does the work after the operator turned
 * it on in pipulse.env; this only asks, and shows what the helper reports. PiPulse itself may be
 * restarted by the upgrade, so a failed poll is expected and simply tried again.
 */
function InstallUpdates({
  upgrade,
  session,
  now,
  onView
}: {
  upgrade: UpgradeView;
  session: Session;
  now: number;
  onView: (patch: (view: UpdatesView) => UpdatesView) => void;
}) {
  const [typed, setTyped] = useState('');
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const busy = upgrade.available && (upgrade.state === 'requested' || upgrade.state === 'running');
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => {
      getJson<UpdatesView>('/api/updates').then(
        (view) => onView(() => view),
        () => undefined
      );
    }, UPGRADE_POLL_MS);
    return () => clearInterval(timer);
  }, [busy]);

  if (!upgrade.available) {
    if (upgrade.reason === 'container') return null;
    return (
      <p class="waiting">
        {upgrade.reason === 'off' &&
          'Installing from this page is off. To allow it, set PIPULSE_ALLOW_UPGRADE=true in /etc/pipulse/pipulse.env (it also needs a sign-in password) and restart PiPulse.'}
        {upgrade.reason === 'no-sign-in' &&
          'Installing from this page needs a sign-in password: set one first (see Settings).'}
        {upgrade.reason === 'not-installed' &&
          "This install doesn't have the upgrade helper: update PiPulse, then try again."}
      </p>
    );
  }

  const ask = async () => {
    setAsking(true);
    setProblem(undefined);
    try {
      const res = await sendJson<{ upgrade: UpgradeView }>('POST', '/api/updates/upgrade', {
        confirm: UPGRADE_CONFIRM_WORD
      });
      onView((view) => ({ ...view, upgrade: res.upgrade }));
      setTyped('');
    } catch (error) {
      setProblem((error as Error).message || 'The request could not be sent.');
    } finally {
      setAsking(false);
    }
  };

  return (
    <section aria-labelledby="updates-install">
      <h2 id="updates-install">Install from here</h2>
      <p class="waiting">
        This runs <code>apt-get update</code> and then <code>apt-get upgrade</code> as root. It can
        restart services (PiPulse itself, Pi-hole), so this page may go quiet for a while, and some
        upgrades need a reboot. Nothing is removed. If you would rather watch it happen, use the
        command above over SSH.
      </p>
      {session.signedIn ? (
        <p>
          <label>
            Type <code>{UPGRADE_CONFIRM_WORD}</code> to confirm{' '}
            <input
              type="text"
              value={typed}
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
            />
          </label>{' '}
          <button
            type="button"
            onClick={ask}
            disabled={typed.trim() !== UPGRADE_CONFIRM_WORD || asking || busy}
          >
            {asking ? 'Asking…' : 'Install updates'}
          </button>
          {problem && <span class="alert-severity"> {problem}</span>}
        </p>
      ) : (
        <p class="waiting">Sign in (Settings) to install from here.</p>
      )}
      <div role="status">
        {upgrade.state === 'requested' && <p>Asked. Waiting for the helper to start…</p>}
        {upgrade.state === 'running' && (
          <p>
            <StatusIcon level="warning" />
            Running: {upgrade.step ? STEP_WORDS[upgrade.step] : 'starting'}
            {upgrade.startedAt !== null && ` (started ${formatAge(now - upgrade.startedAt)})`}.
          </p>
        )}
        {upgrade.state === 'done' && (
          <p>
            Finished {upgrade.finishedAt !== null && formatDateTime(upgrade.finishedAt)}: the
            upgrade completed.
          </p>
        )}
        {upgrade.state === 'failed' && (
          <p class="alert-severity">
            <StatusIcon level="critical" />
            Failed {upgrade.finishedAt !== null && formatDateTime(upgrade.finishedAt)} while{' '}
            {upgrade.step ? STEP_WORDS[upgrade.step] : 'running'}
            {upgrade.exitCode !== null && ` (exit code ${upgrade.exitCode})`}. The log below says
            why.
          </p>
        )}
        {upgrade.state === 'interrupted' && (
          <p class="alert-severity">
            <StatusIcon level="warning" />
            The last upgrade was cut short by a restart. Run <code>
              sudo dpkg --configure -a
            </code>{' '}
            over SSH to finish anything half-installed.
          </p>
        )}
        {upgrade.rebootRequired && (
          <p>
            <StatusIcon level="warning" />A reboot is needed to finish the upgrade.
          </p>
        )}
      </div>
      {upgrade.log.length > 0 && (
        <pre class="upgrade-log" tabindex={0} aria-label="Upgrade log">
          {upgrade.log.join('\n')}
        </pre>
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
      onView(await sendJson<UpdatesView>('POST', '/api/updates/check'));
    } catch (error) {
      setProblem((error as Error).message || 'The check could not be run.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div class="updates-page">
      <h2>Updates</h2>
      {view === undefined && <p class="waiting">Loading</p>}
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
      {view?.upgrade && view.state !== 'unsupported' && (
        <InstallUpdates
          upgrade={view.upgrade}
          session={session}
          now={now}
          onView={(patch) => onView(patch(view))}
        />
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
      {view?.state === 'ok' && waitingCount(view) === 0 && view.pipulse.source === 'apt' && (
        <p class="waiting">Everything is up to date.</p>
      )}
    </div>
  );
}
