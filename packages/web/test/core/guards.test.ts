import { describe, expect, it } from 'vitest';
import {
  anything,
  isAboutConfig,
  isAlert,
  isAlerts,
  isConfig,
  isLiveMessage,
  isPreview,
  isRuleList,
  isSamples,
  isSeries,
  isSession,
  isSettingsBody,
  isTlsConfig,
  isUpdatesView,
  isWebhooks,
  type Guard
} from '../../src/core/guards.js';

// What the server really sends, as each guard sees it. `damage` edits a copy; a guard must accept
// the original and refuse every damaged copy.
const clone = <T>(value: T): T => structuredClone(value);
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const rule = {
  id: 'cpu_busy',
  metric: 'cpu_load',
  atLeast: 90,
  forMs: 600_000,
  clearAfterMs: 60_000,
  severity: 'warning',
  message: 'CPU busy',
  source: 'built-in'
};
const alert = {
  id: 2,
  ruleId: 'cpu_busy',
  metric: 'cpu_load',
  severity: 'warning',
  message: 'CPU busy',
  value: 97,
  raisedAt: 5,
  clearedAt: null,
  clearedBy: null,
  acknowledgedAt: null
};
const tlsHttps = {
  mode: 'https',
  source: 'generated',
  validity: 'valid',
  notBefore: 1,
  notAfter: 2,
  fingerprint: 'AA',
  caFingerprint: 'BB',
  sans: { dns: ['io'], ip: ['127.0.0.1'] },
  class: 'valid',
  reasons: [],
  missingNames: [],
  certificateAgeMs: 5,
  clock: 'synced',
  clockSynced: true,
  reload: { state: 'ok', lastAttempt: null, lastError: null },
  ca: {
    state: 'ok',
    subject: 'CA',
    createdAt: 1,
    notAfter: 2,
    constraints: { dns: ['io'], excludedDns: ['.io'], subnets: [] },
    backups: 0
  },
  coverage: { dns: ['io'], ipSubnets: [] },
  renewal: { state: 'ok', lastAttempt: 1, result: 'not-due', reason: null },
  metadata: 'ok',
  metadataProblems: []
};
const config = {
  device: { hostname: 'io', platform: 'linux', arch: 'arm', cpus: 4, model: 'Pi 2' },
  plugins: [{ id: 'cpu_load', label: 'CPU load', unit: '%', intervalMs: 5000 }],
  serverTime: 1,
  uptimeMs: 2,
  rules: [rule],
  version: '0.9.6',
  node: { version: '22.23.5', line: 22, supportEnds: '2027-04-30', ended: false },
  tls: tlsHttps
};
const level = { text: '2d', ms: 172_800_000, source: 'default', variable: 'X', locked: false };
const settings = {
  retention: { raw: level, '1m': level, '1h': level, '1d': level },
  storage: {
    fileBytes: 1,
    freeBytes: 2,
    diskFreeBytes: null,
    levels: Object.fromEntries(['raw', '1m', '1h', '1d'].map((l) => [l, { rows: 1, oldest: null }]))
  }
};
const webhook = {
  id: 'a',
  host: 'h',
  method: 'POST',
  events: ['raised'],
  minSeverity: 'warning',
  pending: 0,
  lastSuccessAt: null,
  lastFailure: null
};

/** A value of a different type than `original`, for each type the field cannot be. */
const wrongTypes = (original: unknown): unknown[] => {
  const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  // A field that is null may also be a number or a string (nullable), so only types no field takes.
  const pool: unknown[] =
    original === null ? [{ nope: 1 }, true, []] : [{ nope: 1 }, 'x', 12345, true, []];
  return pool.filter((candidate) => kind(candidate) !== kind(original));
};

/** Every way to break a document: each key removed, then set to a value of the wrong type. */
function breakEachField(doc: Doc, optional: string[] = []): Array<[string, Doc]> {
  const out: Array<[string, Doc]> = [];
  for (const key of Object.keys(doc)) {
    if (!optional.includes(key)) {
      const missing = clone(doc);
      delete missing[key];
      out.push([`${key} missing`, missing]);
    }
    for (const wrong of wrongTypes(doc[key])) {
      const bad = clone(doc);
      bad[key] = wrong;
      out.push([`${key} = ${JSON.stringify(wrong)}`, bad]);
    }
  }
  return out;
}

function expectGuard<T>(guard: Guard<T>, good: unknown, doc: Doc, optional: string[] = []) {
  expect(guard(good)).toBe(true);
  for (const [name, bad] of breakEachField(doc, optional)) {
    expect(guard(bad), `${name} should be refused`).toBe(false);
  }
}

describe('what is not an object is never accepted', () => {
  it.each([
    ['isConfig', isConfig],
    ['isAlert', isAlert],
    ['isSeries', isSeries],
    ['isSettingsBody', isSettingsBody],
    ['isPreview', isPreview],
    ['isRuleList', isRuleList],
    ['isUpdatesView', isUpdatesView],
    ['isSession', isSession],
    ['isLiveMessage', isLiveMessage],
    ['isAboutConfig', isAboutConfig],
    ['isTlsConfig', isTlsConfig]
  ] as Array<[string, Guard<unknown>]>)('%s', (_name, guard) => {
    for (const value of [null, undefined, 'x', 7, true, [], [{}]]) {
      expect(guard(value)).toBe(false);
    }
  });

  it('the lists want arrays', () => {
    for (const guard of [isSamples, isAlerts, isWebhooks] as Array<Guard<unknown>>) {
      for (const value of [null, undefined, 'x', 7, {}]) expect(guard(value)).toBe(false);
      expect(guard([])).toBe(true);
    }
  });
});

describe('Config', () => {
  it('accepts a full answer and refuses damage to each required field', () => {
    expectGuard(isConfig, config, config, [
      'serverTime',
      'uptimeMs',
      'rules',
      'version',
      'node',
      'tls'
    ]);
  });

  it('accepts an older server that lacks the newer fields', () => {
    expect(
      isConfig({
        device: { hostname: 'io', platform: 'linux', arch: 'arm' },
        plugins: []
      })
    ).toBe(true);
  });

  it('refuses a plugin with a missing or mistyped field', () => {
    for (const plugin of [
      { label: 'x', unit: '%', intervalMs: 1 },
      { id: 1, label: 'x', unit: '%', intervalMs: 1 },
      { id: 'a', label: 'x', unit: '%', intervalMs: 'soon' },
      { id: 'a', label: 'x', unit: '%', intervalMs: Infinity },
      { id: 'a', label: 'x', unit: '%', intervalMs: 1, unavailable: 5 }
    ]) {
      expect(isConfig({ ...config, plugins: [plugin] })).toBe(false);
    }
  });

  it('refuses a rule that is not a rule, an unknown node and a broken tls view', () => {
    expect(isConfig({ ...config, rules: [{ id: 'x' }] })).toBe(false);
    expect(isConfig({ ...config, node: { version: 22 } })).toBe(false);
    expect(isConfig({ ...config, tls: { mode: 'ftp' } })).toBe(false);
    expect(isConfig({ ...config, tls: { ...tlsHttps, sans: { dns: 'io', ip: [] } } })).toBe(false);
    expect(isConfig({ ...config, tls: { ...tlsHttps, class: 'fine' } })).toBe(false);
    expect(isConfig({ ...config, tls: { ...tlsHttps, ca: { state: 'ok' } } })).toBe(false);
  });

  it('accepts the plain-HTTP tls views and a CA that is being replaced', () => {
    expect(isConfig({ ...config, tls: { mode: 'http', reason: 'env' } })).toBe(true);
    expect(
      isConfig({
        ...config,
        tls: { mode: 'http', reason: 'state', stateMode: 'legacy-http', inContainer: true }
      })
    ).toBe(true);
    expect(isConfig({ ...config, tls: { ...tlsHttps, ca: { state: 'transitional' } } })).toBe(true);
    expect(isConfig({ ...config, tls: { mode: 'http', reason: 'nope' } })).toBe(false);
  });

  it('the slices the About and Certificate sections use are checked on their own', () => {
    expect(isAboutConfig({})).toBe(true);
    expect(isAboutConfig({ version: '1', node: config.node })).toBe(true);
    expect(isAboutConfig({ version: 1 })).toBe(false);
    expect(isAboutConfig({ node: { version: '1' } })).toBe(false);
    expect(isTlsConfig({})).toBe(true);
    expect(isTlsConfig({ tls: tlsHttps, serverTime: 1 })).toBe(true);
    expect(isTlsConfig({ tls: { mode: 'ftp' } })).toBe(false);
    expect(isTlsConfig({ serverTime: 'now' })).toBe(false);
  });
});

describe('Sample, Alert, Series', () => {
  it('samples want a finite ts and value and a metric name', () => {
    expect(isSamples([{ ts: 1, metric: 'a', value: 2 }])).toBe(true);
    for (const bad of [
      { ts: 1, metric: 'a' },
      { ts: 1, metric: 'a', value: NaN },
      { ts: '1', metric: 'a', value: 2 },
      { ts: 1, metric: 3, value: 2 },
      null
    ]) {
      expect(isSamples([bad])).toBe(false);
    }
  });

  it('an alert', () => {
    expectGuard(isAlert, alert, alert, ['acknowledgedAt']);
    expect(isAlert({ ...alert, clearedBy: 'condition', clearedAt: 9 })).toBe(true);
    expect(isAlert({ ...alert, clearedBy: 'someone' })).toBe(false);
    expect(isAlert({ ...alert, severity: 'info' })).toBe(false);
    expect(isAlerts([alert, { ...alert, id: 'x' }])).toBe(false);
  });

  it('a series', () => {
    const series = {
      resolution: '1m',
      points: [{ ts: 1, avg: 2, min: 1, max: 3, count: 4 }]
    };
    expectGuard(isSeries, series, series);
    expect(isSeries({ resolution: '5m', points: [] })).toBe(false);
    expect(isSeries({ ...series, points: [{ ts: 1, avg: 2, min: 1, max: 3 }] })).toBe(false);
    expect(isSeries({ resolution: 'raw', points: [] })).toBe(true);
  });
});

describe('rules, settings, preview, updates, session, webhooks', () => {
  it('the rules list', () => {
    const entry = {
      id: 'cpu_busy',
      kind: 'built-in',
      disabled: false,
      rule,
      written: null,
      overrides: null,
      problem: null,
      saved: false
    };
    expect(isRuleList({ rules: [entry] })).toBe(true);
    expectGuard(isRuleList, { rules: [entry] }, { rules: [entry] });
    expect(isRuleList({ rules: [{ ...entry, kind: 'mystery' }] })).toBe(false);
    expect(isRuleList({ rules: [{ ...entry, disabled: 'no' }] })).toBe(false);
    expect(isRuleList({ rules: [{ ...entry, rule: { id: 'x' } }] })).toBe(false);
    expect(isRuleList({ rules: [{ ...entry, written: 'text' }] })).toBe(false);
    expect(isRuleList({ rules: [{ ...entry, rule: null, problem: 'broken', saved: true }] })).toBe(
      true
    );
  });

  it('a rule: every number and enum is checked', () => {
    const base = {
      rules: [
        {
          id: 'a',
          kind: 'added',
          disabled: false,
          rule,
          written: {},
          overrides: null,
          problem: null,
          saved: true
        }
      ]
    };
    expect(isRuleList(base)).toBe(true);
    for (const patch of [
      { forMs: '1' },
      { clearAfterMs: null },
      { severity: 'bad' },
      { source: 'web' },
      { atLeast: 'x' },
      { noReadingFor: 'never' },
      { certExpired: 'yes' },
      { message: 1 }
    ]) {
      const bad = clone(base);
      Object.assign(bad.rules[0]!.rule, patch);
      expect(isRuleList(bad)).toBe(false);
    }
    const auto = clone(base);
    Object.assign(auto.rules[0]!.rule, { noReadingFor: 'auto' });
    expect(isRuleList(auto)).toBe(true);
  });

  it('settings and preview', () => {
    expectGuard(isSettingsBody, settings, settings);
    const bad = clone(settings) as Doc;
    delete bad['retention']['1h'];
    expect(isSettingsBody(bad)).toBe(false);
    const badSource = clone(settings) as Doc;
    badSource['retention']['raw'].source = 'cli';
    expect(isSettingsBody(badSource)).toBe(false);
    const preview = {
      deletions: Object.fromEntries(
        ['raw', '1m', '1h', '1d'].map((l) => [l, { deletesRows: 0, from: null, to: null }])
      ),
      estimatedBytes: 0
    };
    expectGuard(isPreview, preview, preview);
    const badPreview = clone(preview) as Doc;
    badPreview['deletions']['1d'].deletesRows = 'many';
    expect(isPreview(badPreview)).toBe(false);
  });

  it('every state of the updates view', () => {
    const ok = {
      state: 'ok',
      checkedAt: 1,
      listsRefreshedAt: null,
      pipulse: { source: 'apt', installed: '1', candidate: null, available: false },
      os: { total: 1, packages: [{ name: 'a', from: '1', to: '2' }], keptBack: ['b'] },
      reach: { state: 'partial', attemptedAt: 5, succeededAt: null, reached: 1, total: 2 }
    };
    expect(isUpdatesView(ok)).toBe(true);
    expect(isUpdatesView({ state: 'pending' })).toBe(true);
    expect(isUpdatesView({ state: 'unsupported', reason: 'container' })).toBe(true);
    expect(isUpdatesView({ state: 'unsupported', reason: 'no-apt' })).toBe(true);
    expect(isUpdatesView({ state: 'failed', checkedAt: 1, problem: 'x' })).toBe(true);
    expect(isUpdatesView({ state: 'unsupported', reason: 'other' })).toBe(false);
    expect(isUpdatesView({ state: 'failed', checkedAt: 1 })).toBe(false);
    expect(isUpdatesView({ state: 'failed', problem: 'x' })).toBe(false);
    expect(isUpdatesView({ state: 'done' })).toBe(false);
    expect(isUpdatesView({ state: 'ok' })).toBe(false);
    expectGuard(isUpdatesView, ok, ok);
    for (const reach of [
      undefined,
      {},
      { state: 'weird', attemptedAt: 1, succeededAt: 1, reached: 1, total: 1 },
      { state: 'ok', attemptedAt: 'x', succeededAt: 1, reached: 1, total: 1 },
      { state: 'ok', attemptedAt: 1, succeededAt: 'x', reached: 1, total: 1 },
      { state: 'ok', attemptedAt: 1, succeededAt: 1, reached: '1', total: 1 },
      { state: 'ok', attemptedAt: 1, succeededAt: 1, reached: 1, total: '1' }
    ]) {
      expect(isUpdatesView({ ...ok, reach })).toBe(false);
    }
    for (const state of ['ok', 'partial', 'failed', 'no-sources']) {
      expect(isUpdatesView({ ...ok, reach: { ...ok.reach, state } })).toBe(true);
    }
    const nested = clone(ok) as Doc;
    nested['os'].packages = [{ name: 'a' }];
    expect(isUpdatesView(nested)).toBe(false);
  });

  it('the session', () => {
    expect(isSession({ editable: true, signedIn: false, protectReads: false })).toBe(true);
    expect(isSession({ editable: true, signedIn: 'no', protectReads: false })).toBe(false);
    expect(isSession({ editable: true, signedIn: false })).toBe(false);
  });

  it('the webhook list', () => {
    expect(isWebhooks([webhook])).toBe(true);
    expect(
      isWebhooks([
        {
          ...webhook,
          needsAttention: { reason: 'x' },
          degradedSince: 1,
          counts: { openedAndCleared: 0, cleared: 0, rejected: 0, abandoned: 0, dropped: 0 },
          lastSummaryAt: null,
          lastFailure: { at: 1, reason: 'x' }
        }
      ])
    ).toBe(true);
    for (const patch of [
      { method: 'GET' },
      { events: ['seen'] },
      { minSeverity: 'info' },
      { pending: 'x' },
      { lastFailure: { at: 1 } },
      { counts: { cleared: 1 } },
      { needsAttention: { reason: 5 } }
    ]) {
      expect(isWebhooks([{ ...webhook, ...patch }])).toBe(false);
    }
  });

  it('anything accepts anything', () => {
    for (const value of [null, undefined, 1, 'x', {}, []]) expect(anything(value)).toBe(true);
  });
});

describe('the live feed', () => {
  it('accepts each message the server sends', () => {
    const sample = { ts: 1, metric: 'a', value: 2 };
    expect(isLiveMessage({ type: 'snapshot', samples: [sample] })).toBe(true);
    expect(isLiveMessage({ type: 'snapshot', samples: [], alerts: [alert], rules: [rule] })).toBe(
      true
    );
    expect(isLiveMessage({ type: 'sample', ...sample })).toBe(true);
    for (const event of ['raised', 'cleared', 'acknowledged']) {
      expect(isLiveMessage({ type: 'alert', event, alert })).toBe(true);
    }
    expect(isLiveMessage({ type: 'rules', rules: [rule] })).toBe(true);
  });

  it('refuses everything else', () => {
    const sample = { ts: 1, metric: 'a', value: 2 };
    for (const message of [
      { type: 'other' },
      { type: 'snapshot' },
      { type: 'snapshot', samples: [{ ts: 1 }] },
      { type: 'snapshot', samples: [], alerts: [{ id: 'x' }] },
      { type: 'snapshot', samples: [], rules: [{ id: 'x' }] },
      { type: 'sample', ts: 1 },
      { type: 'sample', ...sample, value: 'x' },
      { type: 'alert', event: 'seen', alert },
      { type: 'alert', event: 'raised', alert: { id: 'x' } },
      { type: 'alert', event: 'raised' },
      { type: 'rules', rules: 'x' },
      { type: 'rules', rules: [{ id: 'x' }] },
      { samples: [] }
    ]) {
      expect(isLiveMessage(message), JSON.stringify(message)).toBe(false);
    }
  });
});

describe('every member of every enum is accepted, and every nested field is checked', () => {
  const withTls = (tls: unknown) => isConfig({ ...config, tls });
  const https = (patch: Doc) => ({ ...clone(tlsHttps), ...patch });

  it('the https view', () => {
    const enums: Array<[string, string[]]> = [
      ['source', ['operator', 'generated']],
      ['validity', ['valid', 'expiring-soon', 'expired', 'not-yet-valid']],
      [
        'class',
        [
          'valid',
          'degraded-incomplete-chain',
          'degraded-san',
          'degraded-untrusted',
          'degraded-purpose'
        ]
      ],
      ['clock', ['synced', 'unsynced', 'unknown']],
      ['metadata', ['ok', 'transitional', 'unreadable']]
    ];
    for (const [field, members] of enums) {
      for (const member of members) expect(withTls(https({ [field]: member }))).toBe(true);
      expect(withTls(https({ [field]: 'bogus' }))).toBe(false);
    }
    for (const state of ['ok', 'failing']) {
      expect(withTls(https({ reload: { state, lastAttempt: 1, lastError: 'x' } }))).toBe(true);
    }
    for (const reload of [
      { state: 'bogus', lastAttempt: null, lastError: null },
      { state: 'ok', lastAttempt: 'x', lastError: null },
      { state: 'ok', lastAttempt: null, lastError: 5 },
      { state: 'ok', lastAttempt: null },
      {}
    ]) {
      expect(withTls(https({ reload }))).toBe(false);
    }
  });

  it('the CA, coverage, renewal and metadata problems', () => {
    for (const state of ['transitional', 'unavailable']) {
      expect(withTls(https({ ca: { state } }))).toBe(true);
    }
    expect(withTls(https({ ca: { state: 'bogus' } }))).toBe(false);
    expect(withTls(https({ ca: null }))).toBe(false);
    expect(withTls(https({ ca: 'x' }))).toBe(false);
    const okCa = clone(tlsHttps.ca) as Doc;
    for (const patch of [
      { subject: 1 },
      { createdAt: 'x' },
      { notAfter: null },
      { backups: 'none' },
      { constraints: {} },
      { constraints: { dns: [], excludedDns: [], subnets: 'x' } },
      { constraints: { dns: [1], excludedDns: [], subnets: [] } },
      { constraints: { dns: [], excludedDns: 'x', subnets: [] } }
    ]) {
      expect(withTls(https({ ca: { ...okCa, ...patch } }))).toBe(false);
    }

    expect(withTls(https({ coverage: {} }))).toBe(false);
    expect(withTls(https({ coverage: { dns: [], ipSubnets: 'x' } }))).toBe(false);
    expect(withTls(https({ coverage: { dns: 'x', ipSubnets: [] } }))).toBe(false);

    for (const state of ['ok', 'waiting-clock', 'failing', 'unknown']) {
      expect(
        withTls(https({ renewal: { state, lastAttempt: null, result: null, reason: null } }))
      ).toBe(true);
    }
    for (const result of ['renewed', 'not-due', 'waiting-clock', 'failed', null]) {
      expect(
        withTls(https({ renewal: { state: 'ok', lastAttempt: 1, result, reason: null } }))
      ).toBe(true);
    }
    for (const renewal of [
      { state: 'bogus', lastAttempt: null, result: null, reason: null },
      { state: 'ok', lastAttempt: 'x', result: null, reason: null },
      { state: 'ok', lastAttempt: null, result: 'bogus', reason: null },
      { state: 'ok', lastAttempt: null, result: null, reason: 5 },
      { state: 'ok' }
    ]) {
      expect(withTls(https({ renewal }))).toBe(false);
    }

    for (const file of ['ca-meta.json', 'renew-status.json']) {
      expect(withTls(https({ metadataProblems: [{ file, message: 'x' }] }))).toBe(true);
    }
    for (const entry of [
      { file: 'other.json', message: 'x' },
      { file: 'ca-meta.json', message: 5 },
      { file: 'ca-meta.json' },
      {}
    ]) {
      expect(withTls(https({ metadataProblems: [entry] }))).toBe(false);
    }
  });

  it('the plain-HTTP view, and a tls value that is not a view', () => {
    for (const reason of ['env', 'state', 'default']) {
      expect(withTls({ mode: 'http', reason })).toBe(true);
    }
    for (const stateMode of ['https', 'legacy-http']) {
      expect(withTls({ mode: 'http', reason: 'env', stateMode })).toBe(true);
    }
    expect(withTls({ mode: 'http', reason: 'env', stateMode: 'bogus' })).toBe(false);
    expect(withTls({ mode: 'http', reason: 'env', inContainer: 'yes' })).toBe(false);
    expect(withTls({ mode: 'http' })).toBe(false);
    // The mode alone decides which view it is: a full https document is not one under another mode.
    expect(withTls({ ...clone(tlsHttps), mode: 'ftp' })).toBe(false);
    expect(withTls({ ...clone(tlsHttps), mode: undefined })).toBe(false);
    for (const value of [null, 'x', 7, true, []]) expect(withTls(value)).toBe(false);
  });

  it('the rule list: every kind and severity, every nested field', () => {
    const entry = (patch: Doc) => ({
      rules: [
        {
          id: 'a',
          kind: 'built-in',
          disabled: false,
          rule,
          written: null,
          overrides: null,
          problem: null,
          saved: false,
          ...patch
        }
      ]
    });
    for (const kind of ['built-in', 'file', 'edited', 'added']) {
      expect(isRuleList(entry({ kind }))).toBe(true);
    }
    for (const severity of ['warning', 'critical']) {
      expect(isRuleList(entry({ rule: { ...rule, severity } }))).toBe(true);
      expect(isAlert({ ...alert, severity })).toBe(true);
    }
    for (const source of ['built-in', 'file', 'saved']) {
      expect(isRuleList(entry({ rule: { ...rule, source } }))).toBe(true);
    }
    expect(isRuleList(entry({ overrides: { id: 'x' } }))).toBe(false);
    expect(isRuleList(entry({ overrides: rule }))).toBe(true);
    expect(isRuleList(entry({ written: { atLeast: '90%' } }))).toBe(true);
    expect(isRuleList(entry({ problem: 5 }))).toBe(false);
  });

  it('the updates view and the webhook list', () => {
    const ok = (source: string) => ({
      state: 'ok',
      checkedAt: 1,
      listsRefreshedAt: 2,
      pipulse: { source, installed: null, candidate: '1', available: true },
      os: { total: 0, packages: [], keptBack: [] },
      reach: { state: 'ok', attemptedAt: null, succeededAt: null, reached: 0, total: 0 }
    });
    for (const source of ['apt', 'other']) expect(isUpdatesView(ok(source))).toBe(true);
    expect(isUpdatesView(ok('bogus'))).toBe(false);
    for (const pipulse of [
      {},
      { source: 'apt', installed: 1, candidate: null, available: true },
      { source: 'apt', installed: null, candidate: 1, available: true },
      { source: 'apt', installed: null, candidate: null, available: 'yes' }
    ]) {
      expect(isUpdatesView({ ...ok('apt'), pipulse })).toBe(false);
    }

    const hook = { ...webhook };
    for (const method of ['POST', 'PUT']) expect(isWebhooks([{ ...hook, method }])).toBe(true);
    for (const events of [['raised'], ['cleared'], ['raised', 'cleared'], []]) {
      expect(isWebhooks([{ ...hook, events }])).toBe(true);
    }
    for (const minSeverity of ['warning', 'critical']) {
      expect(isWebhooks([{ ...hook, minSeverity }])).toBe(true);
    }
  });
});
