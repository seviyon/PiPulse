import type { AlertEvent, Rule } from '@pipulse/alerts';
import type { WebhookStatus } from '@pipulse/notify';
import type { RetentionPolicy } from '@pipulse/storage';
import type { AlertRulesOptions } from './alert-routes.js';
import type { AuthOptions } from './auth-routes.js';
import type { Feed, LiveFeed } from './feed.js';
import type { Health } from './health.js';
import type { SettingsOptions } from './settings-routes.js';
import type { TlsView } from './tls-status.js';
import type { Updates } from './updates.js';
import type { NodeSupport } from './version.js';

/** What the API exposes about each collector plugin via /api/config. */
export interface PluginInfo {
  id: string;
  label: string;
  unit: string;
  intervalMs: number;
  /** Why this plugin isn't running here (e.g. 'Not available in Docker'); absent when it runs. */
  unavailable?: string;
}

export interface DeviceInfo {
  hostname: string;
  platform: string;
  arch: string;
  /** Richer details when the server can read them (see the collector's readDeviceInfo). */
  model?: string;
  os?: string;
  kernel?: string;
  memoryTotalMb?: number;
  cpus?: number;
}

export interface ServerOptions {
  /** Limits on one client's connections and requests; see DEFAULT_LIMITS in app.ts (tests shrink them). */
  limits?: Partial<{
    requestTimeoutMs: number;
    connectionTimeoutMs: number;
    maxConnections: number;
  }>;
  plugins?: PluginInfo[];
  device?: DeviceInfo;
  live?: LiveFeed;
  /**
   * How often /api/live pings each client. A client that hasn't answered
   * the previous ping by the next one is dropped, so connections that
   * vanished without a close (sleeping laptop, dropped Wi-Fi) don't leak.
   */
  heartbeatMs?: number;
  /** Drop a /api/live client once this many bytes are queued unsent to it. */
  maxBufferedBytes?: number;
  /**
   * Browser origins allowed to open /api/live besides the server's own
   * host (e.g. "https://pipulse.lan"). Browsers don't apply the same-origin
   * policy to WebSockets, so without this check any page could read the feed.
   */
  allowedOrigins?: string[];
  /**
   * Host names this server answers to (PIPULSE_ALLOWED_HOSTS). Set: a request for any other
   * name gets 421, which stops DNS rebinding (a page on an attacker's name pointed at this
   * address). Addresses and localhost are always served. Unset or empty: no check.
   */
  allowedHosts?: string[];
  /** Retention the housekeeping job applies; /series never picks a resolution it has pruned. */
  retention?: RetentionPolicy;
  /** Directory holding the built dashboard (packages/web/dist); omitted = API only. */
  webRoot?: string;
  /** Time since boot in ms; defaults to os.uptime(). Injectable for tests. */
  uptimeMs?: () => number;
  /** The effective alert rules, served in /api/config for the dashboard. */
  rules?: Rule[];
  /** Alert raises and clears, pushed to /api/live clients. */
  alertFeed?: Feed<AlertEvent>;
  /** Sign-in and read protection; unset = read-only with public reads. */
  auth?: AuthOptions;
  /** Settings routes and live retention; omitted = no /api/settings. */
  settings?: SettingsOptions;
  /** Rule editing and the live rule set; when set, /api/config serves its rules in force. */
  alertRules?: AlertRulesOptions;
  /** The release version (from version.json); 'dev' when unset. */
  version?: string;
  /** The running Node and its end of security support. */
  node?: NodeSupport;
  /** Liveness at /api/health (public); default checks only the database. */
  health?: Health;
  /** Serve HTTPS with this key and certificate chain; omitted = plain HTTP. */
  https?: { key: string; cert: string };
  /**
   * HSTS max-age in seconds (PIPULSE_TLS_HSTS), sent on HTTPS responses only.
   * Off by default: HSTS ignores the port, so it would force every service on
   * this host name to HTTPS in the browser (Pi-hole on :80, RPi-Monitor on :8888).
   */
  hstsSeconds?: number;
  /** HTTPS state for /api/config and /api/health; omitted = plain HTTP. */
  tls?: () => TlsView;
  /** Webhook delivery status, served read-only at /api/notify. */
  notify?: { status(): WebhookStatus[] };
  /** What `apt-get upgrade` would do (GET /api/updates); omitted = "not available here". */
  updates?: Updates;
}
