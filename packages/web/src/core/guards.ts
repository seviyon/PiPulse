import type {
  Alert,
  Config,
  LiveMessage,
  Preview,
  Rule,
  RuleEntry,
  Sample,
  Series,
  SettingsBody,
  UpdatesView,
  WebhookStatus
} from './types.js';

/**
 * Shape checks for what the server sends. The server is the same release in the normal case, but
 * an older or newer one, a half-written answer or a proxy's error page must not crash a page:
 * a guard that fails makes the caller treat the answer as a failed load, which every page
 * already shows. Fields the types mark optional ("absent from older servers") are checked only
 * when present; anything extra is ignored.
 */
export type Guard<T> = (value: unknown) => value is T;

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === 'string';
const num = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const bool = (value: unknown): value is boolean => typeof value === 'boolean';
const nullable =
  (inner: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    value === null || inner(value);
const optional =
  (inner: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    value === undefined || inner(value);
const oneOf =
  (...allowed: readonly string[]) =>
  (value: unknown): boolean =>
    str(value) && allowed.includes(value);
const arrayOf =
  (inner: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    Array.isArray(value) && value.every(inner);
/** An object whose listed fields satisfy their checks (a missing field is `undefined`). */
const shape =
  (fields: Record<string, (value: unknown) => boolean>) =>
  (value: unknown): boolean =>
    isRec(value) && Object.entries(fields).every(([key, check]) => check(value[key]));

const RESOLUTIONS = ['raw', '1m', '1h', '1d'] as const;
const SEVERITY = oneOf('warning', 'critical');

export const isSample: Guard<Sample> = shape({ ts: num, metric: str, value: num }) as Guard<Sample>;
export const isSamples: Guard<Sample[]> = arrayOf(isSample) as Guard<Sample[]>;

const isRule: Guard<Rule> = shape({
  id: str,
  metric: str,
  atLeast: optional(num),
  atMost: optional(num),
  bitsSet: optional(num),
  noReadingFor: optional((v) => num(v) || v === 'auto'),
  certExpiresWithin: optional(num),
  certExpired: optional(bool),
  forMs: num,
  clearAfterMs: num,
  severity: SEVERITY,
  message: str,
  source: oneOf('built-in', 'file', 'saved')
}) as Guard<Rule>;
const isRules = arrayOf(isRule);

export const isAlert: Guard<Alert> = shape({
  id: num,
  ruleId: str,
  metric: str,
  severity: SEVERITY,
  message: str,
  value: nullable(num),
  raisedAt: num,
  clearedAt: nullable(num),
  clearedBy: nullable(oneOf('condition', 'rule_removed', 'rule_changed')),
  acknowledgedAt: optional(nullable(num))
}) as Guard<Alert>;
export const isAlerts: Guard<Alert[]> = arrayOf(isAlert) as Guard<Alert[]>;

const isRuleEntry = shape({
  id: str,
  kind: oneOf('built-in', 'file', 'edited', 'added'),
  disabled: bool,
  rule: nullable(isRule),
  written: nullable(isRec),
  overrides: nullable(isRule),
  problem: nullable(str),
  saved: bool
});
export const isRuleList: Guard<{ rules: RuleEntry[] }> = shape({
  rules: arrayOf(isRuleEntry)
}) as Guard<{ rules: RuleEntry[] }>;

const strings = arrayOf(str);
const isReload = shape({
  state: oneOf('ok', 'failing'),
  lastAttempt: nullable(num),
  lastError: nullable(str)
});
const isTlsView = (value: unknown): boolean => {
  if (!isRec(value)) return false;
  if (value['mode'] === 'http') {
    return (
      oneOf('env', 'state', 'default')(value['reason']) &&
      optional(oneOf('https', 'legacy-http'))(value['stateMode']) &&
      optional(bool)(value['inContainer'])
    );
  }
  if (value['mode'] !== 'https') return false;
  return shape({
    inContainer: optional(bool),
    source: oneOf('operator', 'generated'),
    validity: oneOf('valid', 'expiring-soon', 'expired', 'not-yet-valid'),
    notBefore: num,
    notAfter: num,
    fingerprint: str,
    caFingerprint: optional(str),
    sans: shape({ dns: strings, ip: strings }),
    class: oneOf(
      'valid',
      'degraded-incomplete-chain',
      'degraded-san',
      'degraded-untrusted',
      'degraded-purpose'
    ),
    reasons: strings,
    missingNames: strings,
    certificateAgeMs: num,
    clock: oneOf('synced', 'unsynced', 'unknown'),
    clockSynced: bool,
    reload: isReload,
    ca: optional(
      (ca) =>
        isRec(ca) &&
        oneOf('ok', 'transitional', 'unavailable')(ca['state']) &&
        (ca['state'] !== 'ok' ||
          shape({
            subject: str,
            createdAt: num,
            notAfter: num,
            constraints: shape({ dns: strings, excludedDns: strings, subnets: strings }),
            backups: num
          })(ca))
    ),
    coverage: optional(shape({ dns: strings, ipSubnets: strings })),
    renewal: optional(
      shape({
        state: oneOf('ok', 'waiting-clock', 'failing', 'unknown'),
        lastAttempt: nullable(num),
        result: nullable(oneOf('renewed', 'not-due', 'waiting-clock', 'failed')),
        reason: nullable(str)
      })
    ),
    metadata: optional(oneOf('ok', 'transitional', 'unreadable')),
    metadataProblems: optional(
      arrayOf(shape({ file: oneOf('ca-meta.json', 'renew-status.json'), message: str }))
    )
  })(value);
};

const isNodeSupport = shape({ version: str, line: num, supportEnds: nullable(str), ended: bool });

export const isConfig: Guard<Config> = shape({
  device: shape({
    hostname: str,
    platform: str,
    arch: str,
    model: optional(str),
    os: optional(str),
    kernel: optional(str),
    memoryTotalMb: optional(num),
    cpus: optional(num)
  }),
  plugins: arrayOf(
    shape({ id: str, label: str, unit: str, intervalMs: num, unavailable: optional(str) })
  ),
  serverTime: optional(num),
  uptimeMs: optional(num),
  rules: optional(isRules),
  version: optional(str),
  node: optional(isNodeSupport),
  tls: optional(isTlsView)
}) as Guard<Config>;

/** The part of /api/config the About section shows. */
export type AboutConfig = Pick<Config, 'version' | 'node'>;
export const isAboutConfig: Guard<AboutConfig> = shape({
  version: optional(str),
  node: optional(isNodeSupport)
}) as Guard<AboutConfig>;
/** The part of /api/config the Certificate section shows. */
export type TlsConfig = Pick<Config, 'tls' | 'serverTime'>;
export const isTlsConfig: Guard<TlsConfig> = shape({
  tls: optional(isTlsView),
  serverTime: optional(num)
}) as Guard<TlsConfig>;

const isSeriesPoint = shape({ ts: num, avg: num, min: num, max: num, count: num });
export const isSeries: Guard<Series> = shape({
  resolution: oneOf(...RESOLUTIONS),
  points: arrayOf(isSeriesPoint)
}) as Guard<Series>;

const levels = (check: (value: unknown) => boolean) =>
  shape(Object.fromEntries(RESOLUTIONS.map((level) => [level, check])));
export const isSettingsBody: Guard<SettingsBody> = shape({
  retention: levels(
    shape({
      text: str,
      ms: nullable(num),
      source: oneOf('env', 'saved', 'default'),
      variable: str,
      locked: bool
    })
  ),
  storage: shape({
    fileBytes: num,
    freeBytes: num,
    diskFreeBytes: nullable(num),
    levels: levels(shape({ rows: num, oldest: nullable(num) }))
  })
}) as Guard<SettingsBody>;
export const isPreview: Guard<Preview> = shape({
  deletions: levels(shape({ deletesRows: num, from: nullable(num), to: nullable(num) })),
  estimatedBytes: num
}) as Guard<Preview>;

export const isUpdatesView: Guard<UpdatesView> = (value): value is UpdatesView => {
  if (!isRec(value)) return false;
  switch (value['state']) {
    case 'unsupported':
      return oneOf('container', 'no-apt')(value['reason']);
    case 'pending':
      return true;
    case 'failed':
      return num(value['checkedAt']) && str(value['problem']);
    case 'ok':
      return shape({
        checkedAt: num,
        listsRefreshedAt: nullable(num),
        pipulse: shape({
          source: oneOf('apt', 'other'),
          installed: nullable(str),
          candidate: nullable(str),
          available: bool
        }),
        os: shape({
          total: num,
          packages: arrayOf(shape({ name: str, from: str, to: str })),
          keptBack: strings
        })
      })(value);
    default:
      return false;
  }
};

export const isSession = shape({
  editable: bool,
  signedIn: bool,
  protectReads: bool
}) as Guard<{ editable: boolean; signedIn: boolean; protectReads: boolean }>;

const isWebhook = shape({
  id: str,
  host: str,
  method: oneOf('POST', 'PUT'),
  events: arrayOf(oneOf('raised', 'cleared')),
  minSeverity: SEVERITY,
  pending: num,
  lastSuccessAt: nullable(num),
  lastFailure: nullable(shape({ at: num, reason: str })),
  needsAttention: optional(nullable(shape({ reason: str }))),
  degradedSince: optional(nullable(num)),
  counts: optional(
    shape({
      openedAndCleared: num,
      cleared: num,
      rejected: num,
      abandoned: num,
      dropped: num
    })
  ),
  lastSummaryAt: optional(nullable(num))
});
export const isWebhooks: Guard<WebhookStatus[]> = arrayOf(isWebhook) as Guard<WebhookStatus[]>;

export const isLiveMessage: Guard<LiveMessage> = (value): value is LiveMessage => {
  if (!isRec(value)) return false;
  switch (value['type']) {
    case 'snapshot':
      return shape({
        samples: isSamples,
        alerts: optional(isAlerts),
        rules: optional(isRules)
      })(value);
    case 'sample':
      return isSample(value);
    case 'alert':
      return oneOf('raised', 'cleared', 'acknowledged')(value['event']) && isAlert(value['alert']);
    case 'rules':
      return isRules(value['rules']);
    default:
      return false;
  }
};

/** For an answer whose body is not used (a logout, for instance): anything is fine. */
export const anything = (_value: unknown): _value is unknown => true;
