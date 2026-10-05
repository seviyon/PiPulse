import { rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { RELEASE_DEFAULT, readTlsConfig, type StateMode } from './config.js';
import type { CheckResult } from './health-check.js';
import { loadCertificate, validityOf } from './inspect.js';
import { recover } from './journal.js';
import { paths, pub, readState, writeState, type Layout } from './layout.js';
import { checkCa, checkLeaf, repairPublic, type CaFiles } from './material.js';
import {
  confirm,
  ensureTlsDirs,
  isoDate,
  nativeLayoutProblem,
  operatorConfigured,
  portOf,
  usage,
  type Context
} from './cli-common.js';

export const HEALTH_WAIT_MS = 30_000;

/** The shared check until it passes, fails on TLS (exit 2), or HEALTH_WAIT_MS pass. */
async function waitHealthy(ctx: Context): Promise<CheckResult> {
  const deadline = ctx.now() + HEALTH_WAIT_MS;
  for (;;) {
    const result = await ctx.health(ctx.env);
    if (result.code === 0 || result.code === 2 || ctx.now() >= deadline) return result;
    await ctx.sleep(1000);
  }
}

function putBack(layout: Layout, previous: StateMode | undefined): void {
  if (previous) writeState(layout, previous);
  else rmSync(paths(layout).state, { force: true });
}

/** putBack that reports instead of throwing (a full disk must not hide why we were backing out). */
function tryPutBack(ctx: Context, previous: StateMode | undefined): void {
  try {
    putBack(ctx.layout, previous);
  } catch (error) {
    ctx.err(
      `could NOT put state.json back (${(error as Error).message}): it still says what this command wrote; fix it by hand (${paths(ctx.layout).state}) or run sudo pipulse tls ${previous === 'https' ? 'enable' : 'disable'} again`
    );
  }
}

/** Restart with the new mode; if the shared check fails, restore the old mode and restart again. */
async function switchMode(
  ctx: Context,
  to: StateMode,
  previous: StateMode | undefined
): Promise<boolean> {
  // After a 6b-1 install with an operator certificate there is no TLS folder yet.
  ensureTlsDirs(ctx.layout, ctx.hook);
  writeState(ctx.layout, to, ctx.hook);
  try {
    const mode = readTlsConfig(ctx.env, { releaseDefault: RELEASE_DEFAULT }).mode;
    if (mode !== (to === 'https' ? 'https' : 'http'))
      throw new Error(`the settings still resolve to ${mode}`);
  } catch (error) {
    ctx.err(`not switching: ${(error as Error).message}`);
    tryPutBack(ctx, previous);
    return false;
  }
  if (ctx.inContainer) {
    ctx.out(
      `state.json now says ${to}: restart the server container to apply it (docker compose restart pipulse)`
    );
    return true;
  }
  let result: CheckResult;
  try {
    await ctx.restart();
    result = await waitHealthy(ctx);
  } catch (error) {
    // A restart that fails is a failed switch: back out exactly as for an unhealthy one.
    result = { code: 1, message: `restart failed: ${(error as Error).message}` };
  }
  if (result.code === 0) return true;
  ctx.err(
    `PiPulse did not come up healthy as ${to} (${result.message}); putting ${previous ?? 'the previous mode'} back`
  );
  tryPutBack(ctx, previous);
  try {
    await ctx.restart();
  } catch (error) {
    ctx.err(`restart failed: ${(error as Error).message}`);
  }
  const back = await waitHealthy(ctx);
  ctx.err(
    back.code === 0
      ? `back on ${previous ?? 'the previous mode'}, which is healthy`
      : `the previous mode is not healthy either (${back.message}): see journalctl -u pipulse`
  );
  return false;
}

export async function enable(ctx: Context, args: string[]): Promise<number> {
  const { values } = usage(() =>
    parseArgs({
      args,
      options: { yes: { type: 'boolean' }, 'allow-expired': { type: 'boolean' } },
      strict: true
    })
  );
  const layout = ctx.layout;
  if (ctx.env['PIPULSE_TLS']?.trim() === 'off') {
    ctx.err(
      'PIPULSE_TLS=off in pipulse.env overrides state.json: remove that line first, then run enable again'
    );
    return 1;
  }
  const summary: string[] = [];
  let toRepair: CaFiles | undefined;
  let caFingerprint: string | undefined;
  let leafFingerprint: string;
  if (operatorConfigured(ctx.env)) {
    try {
      const config = readTlsConfig(
        { ...ctx.env, PIPULSE_TLS: 'on' },
        { releaseDefault: RELEASE_DEFAULT }
      );
      const cert = loadCertificate(config.source!, { names: config.names });
      leafFingerprint = cert.fingerprint;
      if (validityOf(cert, ctx.now(), 0) === 'expired' && !values['allow-expired']) {
        ctx.err(
          `your certificate expired on ${isoDate(cert.notAfter)}: browsers would refuse it. Replace it first, or pass --allow-expired to switch anyway`
        );
        return 1;
      }
      summary.push(
        'Serving your certificate (PIPULSE_TLS_CERT)',
        `  names: ${[...cert.sans.dns, ...cert.sans.ip].join(', ')}`
      );
    } catch (error) {
      ctx.err(`your certificate can't be served: ${(error as Error).message}`);
      return 1;
    }
  } else {
    const folderProblem = nativeLayoutProblem(ctx);
    if (folderProblem) {
      ctx.err(`not enabling HTTPS: ${folderProblem}`);
      return 1;
    }
    recover(layout, ctx.hook); // only where this command may write (not a refused folder, not an operator pair)
    const check = checkCa(paths(layout).caDir);
    if (check.kind !== 'ok') {
      ctx.err(
        check.kind === 'none'
          ? 'there is no CA yet: run sudo pipulse tls init first'
          : `the CA is incomplete: ${check.problem}`
      );
      return 1;
    }
    const leaf = checkLeaf(paths(layout).bundle, check.ca, pub(layout));
    if (leaf.kind !== 'ok') {
      ctx.err(
        `the certificate is not usable (${leaf.kind === 'refused' ? leaf.problem : 'missing'}): run sudo pipulse tls renew --force`
      );
      return 1;
    }
    // checkLeaf never judges dates: a leaf that expired (or isn't valid yet) would be served
    // and every browser would refuse it, so HTTPS is not switched on over it.
    if (leaf.notAfter <= ctx.now()) {
      ctx.err(
        `the certificate expired on ${isoDate(leaf.notAfter)}: run sudo pipulse tls renew --force first`
      );
      return 1;
    }
    if (leaf.notBefore > ctx.now()) {
      ctx.err(
        `the certificate is not valid until ${isoDate(leaf.notBefore)}: check the clock (timedatectl), then run enable again`
      );
      return 1;
    }
    toRepair = check.ca; // the public copies are repaired after the confirmation, never before
    caFingerprint = check.ca.fingerprint;
    leafFingerprint = leaf.fingerprint;
    const ip = check.ca.constraints.subnets;
    summary.push(
      `Serving names: ${[...leaf.sans.dns, ...leaf.sans.ip].join(', ')}`,
      `IP scope: ${ip.length ? ip.join(', ') : 'none (IP addresses will show a warning)'}`,
      `CA SHA-256: ${caFingerprint}`
    );
  }
  const previous = readState(layout);
  if (previous === 'https') {
    // Already on: a restart would only cause an outage for nothing.
    let mode: string | undefined;
    try {
      mode = readTlsConfig(ctx.env, { releaseDefault: RELEASE_DEFAULT }).mode;
    } catch {
      mode = undefined;
    }
    if (mode === 'https' && (await ctx.health(ctx.env)).code === 0) {
      ctx.out('HTTPS is already on and healthy: nothing to do');
      return 0;
    }
  }
  for (const line of summary) ctx.out(line);
  if (!(await confirm(ctx, values.yes, 'Switch PiPulse to HTTPS?'))) {
    ctx.err('nothing changed');
    return 1;
  }
  if (toRepair) for (const file of repairPublic(ctx, toRepair)) ctx.out(`repaired ${file}`);
  if (!(await switchMode(ctx, 'https', previous))) return 1;
  if (ctx.inContainer) return 0;
  const host = ctx.hostname().toLowerCase();
  const port = portOf(ctx.env);
  ctx.out(`HTTPS is on: https://${host}:${port} (also https://${host}.local:${port})`);
  if (caFingerprint) ctx.out(`CA SHA-256: ${caFingerprint}`);
  ctx.out(`Certificate SHA-256: ${leafFingerprint}`);
  ctx.out('Old http:// bookmarks now fail: change them to https://.');
  if (caFingerprint) ctx.out('Trust the CA on each device first: sudo pipulse tls export-ca');
  return 0;
}

export async function disable(ctx: Context, args: string[]): Promise<number> {
  const { values } = usage(() =>
    parseArgs({
      args,
      options: { 'allow-insecure': { type: 'boolean' }, yes: { type: 'boolean' } },
      strict: true
    })
  );
  if (!operatorConfigured(ctx.env) && nativeLayoutProblem(ctx) === undefined)
    recover(ctx.layout, ctx.hook); // finish an interrupted CA change first, where we may write
  if (ctx.env['PIPULSE_TLS']?.trim() === 'on') {
    ctx.err(
      'PIPULSE_TLS=on in pipulse.env overrides state.json: remove that line first, then run disable again'
    );
    return 1;
  }
  const signIn = Boolean(ctx.env['PIPULSE_ADMIN_PASSWORD_HASH_FILE']?.trim());
  if (signIn && !values['allow-insecure']) {
    ctx.err(
      'sign-in is on (PIPULSE_ADMIN_PASSWORD_HASH_FILE): over plain HTTP the password and the session cookie cross the network readable. Pass --allow-insecure to do it anyway.'
    );
    return 1;
  }
  ctx.out(
    `PiPulse will serve plain HTTP: anyone on the network can read the pages${signIn ? ', the password and the session cookie' : ''}. The certificates stay; sudo pipulse tls enable switches back.`
  );
  if (!(await confirm(ctx, values.yes, 'Switch PiPulse to plain HTTP?'))) {
    ctx.err('nothing changed');
    return 1;
  }
  if (!(await switchMode(ctx, 'legacy-http', readState(ctx.layout)))) return 1;
  if (!ctx.inContainer)
    ctx.out(`HTTPS is off: http://${ctx.hostname().toLowerCase()}:${portOf(ctx.env)}`);
  return 0;
}
