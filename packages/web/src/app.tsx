import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { connectLive, FIRST_RETRY_MS, MAX_RETRY_MS, type ConnectionStatus } from './live.js';
import { applyHistory, applySample, applySnapshot, emptyState, type LiveState } from './store.js';
import { AlertsPage } from './alerts-page.js';
import { SettingsPage } from './settings-page.js';
import {
  authEvents,
  getJson,
  HttpError,
  loadSession,
  NO_SESSION,
  sendJson,
  type Session
} from './api.js';
import { SignIn } from './sign-in.js';
import { applyAlertEvent, worstAlert } from './alerts.js';
import { formatUptime } from './format.js';
import { meterMax } from './status.js';
import { HistoryPage } from './history-page.js';
import { historyOnly } from './history.js';
import { routeHash, useRoute } from './router.js';
import { StatusIcon, Tile } from './tile.js';
import type { Alert, Config, DeviceInfo, Sample } from './types.js';

/** Node's process.platform values, as people say them. */
const platformNames: Record<string, string> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
  freebsd: 'FreeBSD'
};

/** How much recent history each tile's sparkline shows. */
const WINDOW_MS = 15 * 60 * 1000;

function liveUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/api/live`;
}

/** Re-renders every `ms` so "updated 12 s ago"-style text and staleness stay current. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * The quiet facts under the hostname: board, OS, kernel and uptime when the
 * server knows them, otherwise just platform and architecture.
 */
function DeviceFacts({ device, uptimeMs }: { device: DeviceInfo; uptimeMs: number | undefined }) {
  const system =
    device.os ?? `${platformNames[device.platform] ?? device.platform} on ${device.arch}`;
  const facts: [string, string][] = [];
  if (device.model) facts.push(['Model', device.model]);
  facts.push(['System', system]);
  if (device.kernel) facts.push(['Kernel', device.kernel]);
  if (uptimeMs !== undefined) facts.push(['Up', formatUptime(uptimeMs)]);
  return (
    <dl class="facts">
      {facts.map(([term, detail]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{detail}</dd>
        </div>
      ))}
    </dl>
  );
}

function ConnectionLine({
  status,
  retryInMs,
  beat
}: {
  status: ConnectionStatus;
  retryInMs: number | undefined;
  beat: number;
}) {
  const text =
    status === 'live'
      ? 'Live'
      : status === 'connecting'
        ? 'Connecting'
        : `Reconnecting${retryInMs ? ` in ${Math.round(retryInMs / 1000)} s` : ''}`;
  return (
    <p class="connection" data-status={status} role="status">
      {/* Re-keyed per sample so its ring animation replays once per reading. */}
      <span class="pulse" key={beat} data-beat={beat > 0 || undefined} aria-hidden="true" />
      <strong>{text}</strong>
    </p>
  );
}

export function App() {
  const [config, setConfig] = useState<Config>();
  const [session, setSession] = useState<Session>(NO_SESSION);
  /** Reads need a sign-in and there is no session: show only the form. */
  const [needSignIn, setNeedSignIn] = useState(false);
  /** Bumped after signing in, to load the config again. */
  const [loadKey, setLoadKey] = useState(0);
  /** Set while /api/config is failing: how long until the next attempt. */
  const [unreachable, setUnreachable] = useState<{ retryInMs: number }>();
  const [data, setData] = useState<LiveState>(emptyState);
  const [openAlerts, setOpenAlerts] = useState<Alert[]>([]);
  const [connection, setConnection] = useState<{ status: ConnectionStatus; retryInMs?: number }>({
    status: 'connecting'
  });
  const [beat, setBeat] = useState(0);
  /**
   * Server clock minus browser clock. Sample timestamps come from the Pi's
   * clock, which can disagree with the viewer's by minutes (no RTC, NTP not
   * yet synced), so staleness, the sparkline axis and history windows are
   * all measured in server time: Date.now() + offset.
   */
  const clockOffset = useRef(0);
  /**
   * Uptime as reported with /api/config, and when (performance.now(), which
   * is monotonic) it arrived; current uptime is that plus the time since.
   * Neither the Pi's nor the viewer's wall clock is involved, so a clock
   * correction on either side can't skew it.
   */
  const uptimeAnchor = useRef<{ uptimeMs: number; at: number }>();
  const now = useNow(1000) + clockOffset.current;
  const route = useRoute();
  /** Server time when the config arrived; tiles still empty well after it point at a missing sensor. */
  const waitingSince = useRef(0);

  // Keep retrying: the page may load while the Pi is rebooting or the server
  // restarting, and a monitoring page is often left open unattended.
  useEffect(() => {
    let retryMs = FIRST_RETRY_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const attempt = () => {
      getJson<Config>('/api/config').then(
        (loaded) => {
          if (cancelled) return;
          if (typeof loaded.serverTime === 'number') {
            clockOffset.current = loaded.serverTime - Date.now();
          }
          if (typeof loaded.uptimeMs === 'number') {
            uptimeAnchor.current = { uptimeMs: loaded.uptimeMs, at: performance.now() };
          }
          waitingSince.current = Date.now() + clockOffset.current;
          setUnreachable(undefined);
          setConfig(loaded);
        },
        (error: unknown) => {
          if (cancelled) return;
          if (error instanceof HttpError && error.status === 401) {
            setNeedSignIn(true);
            return;
          }
          setUnreachable({ retryInMs: retryMs });
          timer = setTimeout(attempt, retryMs);
          retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
        }
      );
    };
    attempt();
    void loadSession().then((loaded) => {
      if (!cancelled) setSession(loaded);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadKey]);

  // Any 401 (an expired session, a restarted server): re-check, and if reads
  // are protected, go back to the sign-in form.
  useEffect(() => {
    const onUnauthorized = () => {
      void loadSession().then((loaded) => {
        setSession(loaded);
        if (loaded.protectReads && !loaded.signedIn) setNeedSignIn(true);
      });
    };
    authEvents.addEventListener('unauthorized', onUnauthorized);
    return () => authEvents.removeEventListener('unauthorized', onUnauthorized);
  }, []);

  const loadHistory = useCallback((plugins: Config['plugins']) => {
    const from = Date.now() + clockOffset.current - WINDOW_MS;
    // History-only metrics have no tile, so no sparkline to fill.
    for (const plugin of plugins.filter((p) => !historyOnly.has(p.id))) {
      getJson<Sample[]>(`/api/metrics/${plugin.id}/history?from=${from}`).then(
        (samples) => setData((state) => applyHistory(state, plugin.id, samples)),
        // A tile without history still fills in from the live feed.
        () => undefined
      );
    }
  }, []);

  useEffect(() => {
    if (config) document.title = `${config.device.hostname} – PiPulse`;
  }, [config]);

  useEffect(() => {
    if (!config) return;
    // Loaded up front, not on the first 'live', so tiles fill even when the
    // WebSocket can't connect (e.g. a proxy that doesn't pass upgrades).
    loadHistory(config.plugins);
    let connectedBefore = false;
    return connectLive({
      url: liveUrl(),
      onUnauthorized: () => authEvents.dispatchEvent(new Event('unauthorized')),
      onMessage: (message) => {
        if (message.type === 'snapshot') {
          setData((state) => applySnapshot(state, message.samples));
          setOpenAlerts(message.alerts ?? []);
        } else if (message.type === 'alert') {
          setOpenAlerts((open) => applyAlertEvent(open, message.event, message.alert));
        } else {
          const { type: _type, ...sample } = message;
          // A pushed sample is stamped just before it is sent, so its ts is
          // the server's clock right now (less a few ms of transit).
          clockOffset.current = sample.ts - Date.now();
          setData((state) => applySample(state, sample, WINDOW_MS));
          setBeat((count) => count + 1);
        }
      },
      onStatus: (status, retryInMs) => {
        setConnection({ status, ...(retryInMs === undefined ? {} : { retryInMs }) });
        if (status !== 'live') return;
        // Refill anything missed while disconnected; the first connect
        // has nothing to refill beyond the load above.
        if (connectedBefore) loadHistory(config.plugins);
        connectedBefore = true;
      }
    });
  }, [config, loadHistory]);

  const signedIn = () => {
    setNeedSignIn(false);
    setSession((current) => ({ ...current, signedIn: true }));
    setLoadKey((key) => key + 1);
  };
  const signOut = () => {
    void sendJson('POST', '/api/logout').finally(() => {
      setSession((current) => ({ ...current, signedIn: false }));
      if (session.protectReads) setNeedSignIn(true);
    });
  };

  if (needSignIn) {
    return (
      <main class="page">
        <SignIn heading="Sign in to PiPulse" onSignedIn={signedIn} />
      </main>
    );
  }

  if (unreachable) {
    return (
      <main class="page">
        <div class="problem" role="alert">
          <h2>Can't reach the PiPulse server at {location.host}</h2>
          <p>
            Check that the PiPulse server is running on the Pi and that its port is open in the
            firewall. Trying again in {Math.round(unreachable.retryInMs / 1000)} s.
          </p>
        </div>
      </main>
    );
  }

  if (!config) {
    return (
      <main class="page">
        <p class="waiting">Loading</p>
      </main>
    );
  }

  const { device } = config;
  const worstOpen = worstAlert(openAlerts);

  return (
    <main class="page">
      <header class="device">
        <div>
          <h1>{device.hostname}</h1>
          <DeviceFacts
            device={device}
            uptimeMs={
              uptimeAnchor.current &&
              uptimeAnchor.current.uptimeMs + (performance.now() - uptimeAnchor.current.at)
            }
          />
        </div>
        <ConnectionLine status={connection.status} retryInMs={connection.retryInMs} beat={beat} />
        {session.signedIn && (
          <button type="button" class="link-button" onClick={signOut}>
            Sign out
          </button>
        )}
      </header>
      <nav class="pages" aria-label="Pages">
        <a
          href={routeHash({ page: 'now' })}
          aria-current={route.page === 'now' ? 'page' : undefined}
        >
          Now
        </a>
        <a
          href={routeHash({
            page: 'history',
            range: route.page === 'history' ? route.range : '24h'
          })}
          aria-current={route.page === 'history' ? 'page' : undefined}
        >
          History
        </a>
        <a
          href={routeHash({ page: 'alerts' })}
          aria-current={route.page === 'alerts' ? 'page' : undefined}
          aria-label={
            worstOpen ? `Alerts, ${openAlerts.length} open, ${worstOpen.severity}` : undefined
          }
        >
          Alerts
          {worstOpen && (
            <span class="badge" data-severity={worstOpen.severity}>
              <StatusIcon level={worstOpen.severity} />
              {openAlerts.length}
            </span>
          )}
        </a>
        <a
          href={routeHash({ page: 'settings' })}
          aria-current={route.page === 'settings' ? 'page' : undefined}
        >
          Settings
        </a>
      </nav>
      {route.page === 'history' ? (
        <HistoryPage
          config={config}
          range={route.range}
          now={() => Date.now() + clockOffset.current}
        />
      ) : route.page === 'settings' ? (
        <SettingsPage
          session={session}
          onSessionChange={(next) => {
            setSession(next);
            if (next.protectReads && !next.signedIn) setNeedSignIn(true);
          }}
        />
      ) : route.page === 'alerts' ? (
        <AlertsPage
          config={config}
          open={openAlerts}
          now={() => Date.now() + clockOffset.current}
        />
      ) : (
        <div class="panel">
          <div class="tiles">
            {config.plugins
              .filter((plugin) => !historyOnly.has(plugin.id))
              .map((plugin) => (
                <Tile
                  key={plugin.id}
                  plugin={plugin}
                  rules={config.rules ?? []}
                  alert={worstAlert(openAlerts.filter((a) => a.metric === plugin.id))}
                  latest={data.latest[plugin.id]}
                  series={data.series[plugin.id] ?? []}
                  now={now}
                  waitingSince={waitingSince.current}
                  windowMs={WINDOW_MS}
                  max={meterMax(plugin.id, device)}
                />
              ))}
          </div>
        </div>
      )}
    </main>
  );
}
