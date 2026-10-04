import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { ClockState } from './clock.js';
import { RELEASE_DEFAULT, readTlsConfig, type StateMode } from './config.js';
import { consequenceText, formatAddress, parseAddress } from './constraints.js';
import { EXPIRING_SOON_MS, parseSans, validityOf, type Validity } from './inspect.js';
import { readTxn } from './journal.js';
import {
  paths,
  readMeta,
  readRenewStatus,
  readState,
  type CaMeta,
  type RenewStatus
} from './layout.js';
import { parseCertificateFile } from './pem.js';
import {
  isoDate,
  isoMinute,
  nativeLayoutProblem,
  operatorConfigured,
  scopeHint,
  usage,
  type Context
} from './cli-common.js';

export interface LeafInfo {
  fingerprint: string;
  notBefore: number;
  notAfter: number;
  validity: Validity;
  sans: { dns: string[]; ip: string[] };
  /** Generated: whether it verifies against the public ca.crt. Operator: null. */
  verifies: boolean | null;
}

/** What the running server reports (Task 14 fills this in from /run/pipulse/tls-status.json). */
export type ActiveView = { state: 'unknown' };

export interface StatusReport {
  configured: {
    tlsDir: string;
    state: StateMode | 'absent' | 'unreadable';
    override: 'on' | 'off' | null;
    /** What a (re)start would do with these files and settings. */
    effective: 'https' | 'http' | 'refuse';
    problem: string | null;
    source: 'generated' | 'operator';
    ca: CaMeta | null;
    caProblem: string | null;
    leaf: LeafInfo | null;
    leafProblem: string | null;
    clock: { state: ClockState; trust: boolean };
    journal: 'none' | 'pending';
  };
  active: ActiveView;
  renewal: RenewStatus | null;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const canonicalIp = (text: string) => {
  try {
    return formatAddress(parseAddress(text));
  } catch {
    return text;
  }
};

function leafInfo(
  ctx: Context,
  source: 'generated' | 'operator',
  now: number
): { leaf: LeafInfo | null; leafProblem: string | null } {
  // Public files only (leaf.crt, ca.crt, the operator's certificate): status
  // never needs a private key, so it also works in the server container.
  const certPath =
    source === 'operator' ? ctx.env['PIPULSE_TLS_CERT']!.trim() : paths(ctx.layout).leafCrt;
  let content: string;
  try {
    content = readFileSync(certPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { leaf: null, leafProblem: null };
    return { leaf: null, leafProblem: messageOf(error) };
  }
  try {
    const cert = new X509Certificate(
      parseCertificateFile(content, source === 'operator' ? 'PIPULSE_TLS_CERT' : 'leaf.crt')[0]!
    );
    let verifies: boolean | null = null;
    if (source === 'generated') {
      try {
        const ca = new X509Certificate(readFileSync(paths(ctx.layout).publicCa));
        verifies = cert.checkIssued(ca) && cert.verify(ca.publicKey);
      } catch {
        verifies = false;
      }
    }
    const window = {
      notBefore: cert.validFromDate.getTime(),
      notAfter: cert.validToDate.getTime()
    };
    const sans = parseSans(cert.subjectAltName);
    return {
      leaf: {
        fingerprint: cert.fingerprint256,
        ...window,
        validity: validityOf(window, now, EXPIRING_SOON_MS[source]),
        sans: { dns: sans.dns, ip: sans.ip.map(canonicalIp) },
        verifies
      },
      leafProblem: null
    };
  } catch (error) {
    return { leaf: null, leafProblem: messageOf(error) };
  }
}

export function collectStatus(ctx: Context): StatusReport {
  const now = ctx.now();
  const flag = ctx.env['PIPULSE_TLS']?.trim();
  let state: StatusReport['configured']['state'];
  let problem: string | null = null;
  try {
    state = readState(ctx.layout) ?? 'absent';
  } catch (error) {
    state = 'unreadable';
    problem = messageOf(error);
  }
  let effective: StatusReport['configured']['effective'] = 'refuse';
  try {
    effective = readTlsConfig(ctx.env, { releaseDefault: RELEASE_DEFAULT }).mode;
  } catch (error) {
    problem ??= messageOf(error);
  }
  const source = operatorConfigured(ctx.env) ? 'operator' : 'generated';
  let ca: CaMeta | null = null;
  let caProblem: string | null = null;
  try {
    ca = readMeta(ctx.layout) ?? null;
  } catch (error) {
    caProblem = messageOf(error);
  }
  const { leaf, leafProblem } = leafInfo(ctx, source, now);
  let journal: 'none' | 'pending' = 'none';
  try {
    if (readTxn(ctx.layout)) journal = 'pending';
  } catch {
    journal = 'pending';
  }
  let renewal: RenewStatus | null;
  try {
    renewal = readRenewStatus(paths(ctx.layout).renewStatus) ?? null;
  } catch {
    renewal = null;
  }
  const clock = ctx.clock(source === 'generated' && leaf ? leaf.notBefore : undefined);
  return {
    configured: {
      tlsDir: ctx.layout.tlsDir,
      state,
      override: flag === 'on' || flag === 'off' ? flag : null,
      effective,
      problem,
      source,
      ca,
      caProblem,
      leaf,
      leafProblem,
      clock: { state: clock.state, trust: ctx.env['PIPULSE_TLS_CLOCK']?.trim() === 'trust' },
      journal
    },
    active: { state: 'unknown' },
    renewal
  };
}

function validityLine(leaf: LeafInfo, now: number): string {
  switch (leaf.validity) {
    case 'expired':
      return `EXPIRED on ${isoMinute(leaf.notAfter)}`;
    case 'not-yet-valid':
      return `not valid until ${isoMinute(leaf.notBefore)} (is the clock right?)`;
    default: {
      const days = Math.floor((leaf.notAfter - now) / 86_400_000);
      return `valid ${isoDate(leaf.notBefore)} to ${isoDate(leaf.notAfter)} (${days} days left)${leaf.validity === 'expiring-soon' ? ', renewal due' : ''}`;
    }
  }
}

function clockLine(clock: { state: ClockState; trust: boolean }): string {
  if (clock.state === 'synced') return 'synchronized';
  if (clock.state === 'unsynced') return 'not synchronized yet (renewal waits)';
  return clock.trust
    ? 'no synchronization signal; trusted (PIPULSE_TLS_CLOCK=trust)'
    : 'no synchronization signal (renewal waits; set PIPULSE_TLS_CLOCK=trust if chrony or ntpd keeps it right)';
}

function renewalLine(renewal: RenewStatus): string {
  const what = {
    renewed: 'renewed',
    'not-due': 'not due',
    'waiting-clock': 'waiting for clock synchronization',
    failed: 'FAILED'
  }[renewal.result];
  return `${isoMinute(renewal.lastAttempt)}: ${what}${renewal.reason ? ` (${renewal.reason})` : ''}`;
}

/** Task 14 replaces this with the runtime-status reader's view. */
export function activeLines(active: ActiveView): string[] {
  void active;
  return ['  not reported by this version: systemctl status pipulse'];
}

export function formatStatus(report: StatusReport, ctx: Context): string[] {
  const c = report.configured;
  const lines: string[] = [`Configured (${c.tlsDir})`];
  const stateText =
    c.state === 'absent'
      ? 'not chosen (no state.json)'
      : c.state === 'unreadable'
        ? 'state.json is unreadable'
        : `${c.state} (state.json)`;
  const effective =
    c.effective === 'refuse' ? 'PiPulse would refuse to start' : c.effective.toUpperCase();
  lines.push(
    `  Mode:      ${effective} — ${c.override ? `PIPULSE_TLS=${c.override} in the settings (overrides state.json)` : stateText}`
  );
  if (c.problem) lines.push(`             problem: ${c.problem}`);
  if (c.state === 'legacy-http' && !c.override)
    lines.push('             HTTPS is ready: sudo pipulse tls enable');
  lines.push(
    `  Source:    ${c.source === 'operator' ? 'your certificate (PIPULSE_TLS_CERT/PIPULSE_TLS_KEY)' : 'generated by PiPulse'}`
  );
  const folderProblem = c.source === 'generated' ? nativeLayoutProblem(ctx) : undefined;
  if (folderProblem) lines.push(`             problem: ${folderProblem}`);
  if (c.source === 'generated') {
    if (c.ca) {
      lines.push(`  CA:        SHA-256 ${c.ca.fingerprint}`);
      lines.push(
        `             ${c.ca.subject}, made ${isoDate(c.ca.createdAt)}, valid until ${isoDate(c.ca.notAfter)}`
      );
      for (const line of consequenceText(c.ca.constraints).slice(1))
        lines.push(`             ${line.trim()}`);
      lines.push(
        `  Backups:   ${c.ca.backups.length === 0 ? 'none' : c.ca.backups.map((b) => `${b.name} (SHA-256 ${b.fingerprint.slice(0, 23)}…)`).join(', ')}`
      );
    } else {
      lines.push(`  CA:        ${c.caProblem ?? 'none yet (sudo pipulse tls init)'}`);
    }
  }
  if (c.leaf) {
    lines.push(`  Certificate: SHA-256 ${c.leaf.fingerprint}`);
    lines.push(
      `             ${validityLine(c.leaf, ctx.now())}${c.leaf.verifies === false ? '; does NOT verify against ca.crt' : ''}`
    );
    lines.push(`             names: ${[...c.leaf.sans.dns, ...c.leaf.sans.ip].join(', ')}`);
  } else {
    lines.push(`  Certificate: ${c.leafProblem ?? 'none yet'}`);
  }
  if (c.source === 'generated' && c.ca) {
    lines.push(`  Coverage:  DNS access: covered (${c.ca.constraints.dns.join(', ')})`);
    lines.push(
      `             IP access: ${c.ca.constraints.subnets.length ? `covered for ${c.ca.constraints.subnets.join(', ')}` : 'not covered'}`
    );
    lines.push(`             How to change scope: ${scopeHint(ctx)}`);
  }
  lines.push(`  Clock:     ${clockLine(c.clock)}`);
  if (c.journal === 'pending')
    lines.push(
      '  Journal:   an unfinished CA change is pending; any other sudo pipulse tls command finishes it'
    );
  lines.push('Active (the running server)', ...activeLines(report.active));
  lines.push('Last renewal', `  ${report.renewal ? renewalLine(report.renewal) : 'none recorded'}`);
  if (
    [c.problem, c.caProblem, c.leafProblem].some(
      (p) => p?.includes('EACCES') || p?.includes('not readable')
    )
  ) {
    lines.push('Some files are not readable by this user: sudo pipulse tls status');
  }
  return lines;
}

export async function status(ctx: Context, args: string[]): Promise<number> {
  const { values } = usage(() =>
    parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true })
  );
  const report = collectStatus(ctx);
  if (values.json) ctx.out(JSON.stringify(report, null, 2));
  else for (const line of formatStatus(report, ctx)) ctx.out(line);
  return 0;
}
