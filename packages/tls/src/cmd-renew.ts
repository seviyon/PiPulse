import { parseArgs } from 'node:util';
import { opensslVersion } from './issue.js';
import { leafNames } from './constraints.js';
import { pathExists, removeTree } from './files.js';
import { recover } from './journal.js';
import { paths, pub, writeRenewStatus, type RenewStatus } from './layout.js';
import {
  checkCa,
  checkLeaf,
  makeLeaf,
  namesSetting,
  prepareWork,
  repairPublic,
  writeLeaf,
  type LeafCheck
} from './material.js';
import {
  isoDate,
  nativeLayoutProblem,
  operatorConfigured,
  reportOutside,
  usage,
  type Context
} from './cli-common.js';

const DAY_MS = 86_400_000;
export const RENEW_BEFORE_MS = 30 * DAY_MS;
/** A leaf is backdated an hour (issue.ts BACKDATE_MS), so its age is measured from notBefore + this. */
const BACKDATE_MS = 3_600_000;
/**
 * A new IPv6 address is waited for this long before it makes the leaf due: privacy
 * (temporary) addresses rotate and Node can't tell them apart, so reissuing for each one
 * would rewrite the key and reload the server as often as the address changes.
 */
export const IPV6_RENEW_AFTER_MS = DAY_MS;

/**
 * Why the leaf should be replaced now, or undefined. A default-route address
 * or configured name the CA covers but the leaf lacks makes it due early; an
 * address that went away never does (it drops off at the next renewal).
 */
export function renewDue(input: {
  leaf: LeafCheck;
  now: number;
  wanted: { dns: string[]; ip: string[] };
  /** When the CA expires: a leaf never outlives it, so near that date expiry is not a reason. */
  caNotAfter?: number;
}): string | undefined {
  const { leaf } = input;
  if (leaf.kind === 'missing') return 'there is no certificate';
  if (leaf.kind === 'refused') return `the certificate is not usable: ${leaf.problem}`;
  if (input.caNotAfter !== undefined && input.now >= input.caNotAfter)
    return `the CA expired on ${isoDate(input.caNotAfter)}`;
  // A leaf already ending where the CA ends can't be extended: renewing it hourly would
  // only rewrite the key and reload the server (see renewCapped for what is said instead).
  const capped = input.caNotAfter !== undefined && leaf.notAfter >= input.caNotAfter;
  if (!capped && leaf.notAfter - input.now <= RENEW_BEFORE_MS)
    return `it expires on ${isoDate(leaf.notAfter)}`;
  const missing = input.wanted.ip.filter((ip) => !leaf.sans.ip.includes(ip));
  const v4 = missing.filter((ip) => !ip.includes(':'));
  const v6 = missing.filter((ip) => ip.includes(':'));
  if (v4.length > 0) return `the default-route address ${v4.join(', ')} is not in it`;
  if (v6.length > 0 && input.now - leaf.notBefore >= IPV6_RENEW_AFTER_MS + BACKDATE_MS)
    return `the default-route address ${v6.join(', ')} is not in it`;
  const names = input.wanted.dns.filter((name) => !leaf.sans.dns.includes(name));
  if (names.length > 0) return `${names.join(', ')} is not in it`;
  return undefined;
}

export async function renew(ctx: Context, args: string[]): Promise<number> {
  const { values } = usage(() =>
    parseArgs({ args, options: { force: { type: 'boolean' } }, strict: true })
  );
  const layout = ctx.layout;
  const now = ctx.now();
  const record = (result: RenewStatus['result'], reason: string) => {
    try {
      writeRenewStatus(layout, {
        version: 1,
        lastAttempt: now,
        result,
        reason: reason.slice(0, 300)
      });
    } catch (error) {
      ctx.err(`warning: could not write renew-status.json: ${(error as Error).message}`);
    }
  };
  if (operatorConfigured(ctx.env)) {
    record('not-due', 'operator certificate');
    ctx.out('not due: an operator certificate is in use (PiPulse never renews it)');
    return 0;
  }
  const folderProblem = nativeLayoutProblem(ctx);
  if (folderProblem) {
    // The renew unit can write only the default folder: record the refusal there, where
    // `status` looks. If even that fails, the non-zero exit and stderr put it in the journal.
    try {
      writeRenewStatus(
        { ...layout, tlsDir: ctx.defaultTlsDir, caRoot: ctx.defaultTlsDir },
        { version: 1, lastAttempt: now, result: 'failed', reason: folderProblem.slice(0, 300) }
      );
    } catch (error) {
      ctx.err(
        `could not record the failure in ${ctx.defaultTlsDir}/renew-status.json: ${(error as Error).message}`
      );
    }
    ctx.err(`renewal failed: ${folderProblem}`);
    return 1;
  }
  // A corrupt journal or a failed recovery is recorded like any other failure: otherwise
  // renew-status.json keeps its last good result while every hourly run fails.
  let check: ReturnType<typeof checkCa>;
  try {
    recover(layout, ctx.hook);
    check = checkCa(paths(layout).caDir);
  } catch (error) {
    record('failed', (error as Error).message);
    ctx.err(`renewal failed: ${(error as Error).message}`);
    return 1;
  }
  if (check.kind === 'none') {
    // Nothing generated at all is simply "not set up". But a served leaf or a chosen mode with
    // no CA behind it is a failure the hourly run must not hide behind its last good result.
    let orphaned: boolean;
    try {
      orphaned = pathExists(paths(layout).bundle) || pathExists(paths(layout).state);
    } catch {
      orphaned = true; // can't tell: don't claim all is well
    }
    if (orphaned) {
      const reason = 'there is no CA but a certificate or mode is in place: sudo pipulse tls init';
      record('failed', reason);
      ctx.err(`renewal failed: ${reason}`);
      return 1;
    }
    ctx.out('there is no generated certificate here: sudo pipulse tls init makes one');
    return 0;
  }
  if (check.kind === 'partial') {
    record('failed', `the CA is incomplete: ${check.problem}`);
    ctx.err(`renewal failed: the CA is incomplete: ${check.problem}`);
    return 1;
  }
  const ca = check.ca;
  try {
    prepareWork(layout, ctx.hook);
    repairPublic(ctx, ca);
    const leaf = checkLeaf(paths(layout).bundle, ca, pub(layout));
    const clock = ctx.clock(leaf.kind === 'ok' ? leaf.notBefore : undefined);
    if (!clock.synced) {
      record('waiting-clock', `clock ${clock.state}`);
      ctx.out('waiting for clock synchronization');
      return 0;
    }
    const wanted = leafNames({
      constraints: ca.constraints,
      hostname: ctx.hostname(),
      names: namesSetting(ctx.env),
      addresses: ctx.addresses()
    });
    const reason = values.force
      ? 'forced'
      : renewDue({ leaf, now, wanted, caNotAfter: ca.notAfter });
    if (reason === undefined) {
      // A leaf that ends with the CA can't be extended: say what to do about the CA instead.
      const note =
        leaf.kind === 'ok'
          ? leaf.notAfter >= ca.notAfter
            ? `valid until ${isoDate(leaf.notAfter)}, when the CA expires: sudo pipulse tls new-ca`
            : `valid until ${isoDate(leaf.notAfter)}`
          : '';
      record('not-due', note);
      ctx.out(`not due${note ? `: ${note}` : ''}`);
      return 0;
    }
    await opensslVersion(ctx.openssl);
    const made = await makeLeaf(ctx, ca);
    writeLeaf(layout.tlsDir, layout, made.issued, ctx.hook);
    reportOutside(ctx, made.outside);
    record('renewed', reason);
    ctx.out(
      `renewed (${reason}): SHA-256 ${made.issued.fingerprint}, valid until ${isoDate(made.issued.notAfter)}; the server picks it up within about two minutes`
    );
    return 0;
  } catch (error) {
    record('failed', (error as Error).message);
    ctx.err(`renewal failed: ${(error as Error).message}`);
    return 1;
  } finally {
    removeTree(paths(layout).work);
  }
}
