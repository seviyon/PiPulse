import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { StateMode } from './config.js';
import { opensslVersion } from './issue.js';
import { issuanceClock, CLOCK_WAIT_MS } from './clock-gate.js';
import { buildConstraints, checkSubnet, consequenceText, subnetWarning } from './constraints.js';
import { removeTree } from './files.js';
import { runTransaction } from './journal.js';
import { listBackups, paths, pub, readState, writeState } from './layout.js';
import {
  checkCa,
  checkLeaf,
  makeLeaf,
  namesSetting,
  prepareWork,
  recoveryHint,
  repairPublic,
  stageNewCa,
  subnetsSetting,
  validateStage,
  writeLeaf
} from './material.js';
import { recover } from './journal.js';
import {
  confirm,
  isoDate,
  ensureTlsDirs,
  nativeLayoutProblem,
  operatorConfigured,
  tlsOff,
  printCa,
  reportOutside,
  usage,
  UsageError,
  type Context
} from './cli-common.js';

/**
 * The mode for an install without state.json: an upgrade (a previous install, or data from
 * one) stays on HTTP until the operator enables HTTPS — unless that data was already served
 * over HTTPS (the marker the server writes), so a lost TLS folder never silently falls back
 * to HTTP.
 */
export function decideInitialMode(input: {
  previousInstall: boolean;
  dbExists: boolean;
  markerExists: boolean;
}): StateMode {
  return (input.previousInstall || input.dbExists) && !input.markerExists ? 'legacy-http' : 'https';
}

type InitValues = {
  subnet?: string[] | undefined;
  yes?: boolean | undefined;
  quiet?: boolean | undefined;
};

export async function init(ctx: Context, args: string[]): Promise<number> {
  const { values } = usage(() =>
    parseArgs({
      args,
      options: {
        subnet: { type: 'string', multiple: true },
        yes: { type: 'boolean' },
        mode: { type: 'string' },
        'first-install': { type: 'boolean' },
        quiet: { type: 'boolean' }
      },
      strict: true
    })
  );
  if (values.mode === undefined) return material(ctx, values);
  if (values.mode !== 'auto') throw new UsageError(`--mode must be auto, not ${values.mode}`);
  // PIPULSE_TLS=off overrides everything: an install or upgrade makes no CA and, on a first
  // run, records legacy-http (so removing the setting later never flips the transport by itself).
  if (tlsOff(ctx.env)) {
    ctx.out('PIPULSE_TLS=off: plain HTTP; no CA made');
    if (readState(ctx.layout) === undefined) {
      ensureTlsDirs(ctx.layout, ctx.hook);
      writeState(ctx.layout, 'legacy-http', ctx.hook);
    }
    return 0;
  }
  // Mode already chosen (by an earlier install or by the operator): only fill in material.
  if (readState(ctx.layout) !== undefined) return material(ctx, values);
  const db = ctx.env['PIPULSE_DB_PATH']?.trim() || '/var/lib/pipulse/pipulse.sqlite';
  const exists = (path: string, whenUnsure: boolean) => {
    try {
      statSync(path);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : whenUnsure;
    }
  };
  // Unsure (unreadable) means: data present, never served over HTTPS, the choice that keeps HTTP.
  const markerExists = exists(join(dirname(db), 'tls-installed'), false);
  const mode = decideInitialMode({
    previousInstall: !values['first-install'],
    dbExists: exists(db, true),
    markerExists
  });
  const hadCa = checkCa(paths(ctx.layout).caDir).kind === 'ok';
  let code: number;
  try {
    code = await material(ctx, values);
  } catch (error) {
    // e.g. openssl missing: an upgrade must still land on legacy-http.
    ctx.err(`pipulse tls: ${(error as Error).message}`);
    code = 1;
  }
  if (mode === 'https') {
    // No state.json on failure: the server refuses rather than serve something half-made.
    if (code !== 0) return code;
    if (markerExists && !hadCa) {
      ctx.err(
        'warning: this data was served over HTTPS before but its TLS folder is gone: a new CA was made, so every device must trust the new CA (sudo pipulse tls export-ca)'
      );
    }
    writeState(ctx.layout, 'https', ctx.hook);
    return 0;
  }
  if (code !== 0) {
    ctx.err(
      'warning: HTTPS is not prepared (see above); PiPulse stays on plain HTTP. Try again later with: sudo pipulse tls init'
    );
  }
  writeState(ctx.layout, 'legacy-http', ctx.hook);
  // With an operator certificate configured the environment decides the transport, so
  // "not switched on" would be wrong (a 6b-1 install with PIPULSE_TLS=on keeps serving HTTPS).
  if (code === 0 && !operatorConfigured(ctx.env)) {
    ctx.out(
      ctx.inContainer
        ? 'HTTPS is ready but not switched on (this is an upgrade): docker compose run --rm pipulse-tls pipulse tls enable --yes'
        : 'HTTPS is ready but not switched on (this is an upgrade): sudo pipulse tls enable'
    );
  }
  return 0;
}

async function material(ctx: Context, values: InitValues): Promise<number> {
  const layout = ctx.layout;
  if (operatorConfigured(ctx.env)) {
    ctx.out(
      'operator certificate in use (PIPULSE_TLS_CERT/PIPULSE_TLS_KEY); managed CA not created'
    );
    return 0;
  }
  const folderProblem = nativeLayoutProblem(ctx);
  if (folderProblem) {
    ctx.err(`not creating a CA: ${folderProblem}`);
    return 1;
  }
  recover(layout, ctx.hook);
  const subnets = values.subnet ?? subnetsSetting(ctx.env);
  ensureTlsDirs(layout, ctx.hook);
  prepareWork(layout, ctx.hook);
  try {
    const check = checkCa(paths(layout).caDir);
    if (check.kind === 'partial') {
      ctx.err(`the CA is incomplete: ${check.problem}`);
      ctx.err(`to recover: ${recoveryHint(layout)}`);
      return 1;
    }
    if (check.kind === 'none') {
      let built;
      try {
        built = buildConstraints({
          hostname: ctx.hostname(),
          names: namesSetting(ctx.env),
          subnets
        });
      } catch (error) {
        ctx.err(`not creating a CA: ${(error as Error).message}`);
        return 1;
      }
      const { constraints, warnings } = built;
      for (const warning of warnings) ctx.err(`warning: ${warning}`);
      for (const subnet of constraints.subnets) {
        const warning = subnetWarning(subnet, ctx.interfaces());
        if (warning) ctx.err(`warning: ${warning}`);
      }
      if (constraints.subnets.length > 0) {
        for (const line of consequenceText(constraints)) ctx.out(line);
        if (!(await confirm(ctx, values.yes, 'Create this CA?'))) {
          ctx.err('nothing changed');
          return 1;
        }
      }
      await opensslVersion(ctx.openssl); // a missing or non-conforming openssl says so by name
      const gate = await issuanceClock(ctx, { lenient: true, waitMs: CLOCK_WAIT_MS });
      if (!gate.ok) {
        ctx.err(`not issuing: ${gate.reason}`);
        return 1;
      }
      let outside: string[] = [];
      await runTransaction(layout, {
        kind: 'init',
        now: ctx.now(),
        hook: ctx.hook,
        stage: async (dirs) => {
          ({ outside } = await stageNewCa(ctx, dirs, constraints, listBackups(layout)));
        },
        validate: (dirs) => {
          validateStage(dirs, pub(layout));
        }
      });
      reportOutside(ctx, outside);
      if (!values.quiet) printCa(ctx);
      return 0;
    }

    const ca = check.ca;
    if (values.subnet) {
      const wanted = values.subnet
        .map((subnet) => checkSubnet(subnet).text)
        .sort()
        .join(',');
      if (wanted !== [...ca.constraints.subnets].sort().join(',')) {
        ctx.err(
          `warning: the CA already exists with IP scope [${ca.constraints.subnets.join(', ') || 'none'}]; init never replaces a CA. To change the scope: sudo pipulse tls new-ca --subnet …`
        );
      }
    }
    for (const file of repairPublic(ctx, ca)) ctx.out(`repaired ${file}`);
    const leaf = checkLeaf(paths(layout).bundle, ca, pub(layout));
    if (leaf.kind === 'ok' && leaf.notAfter > ctx.now()) {
      ctx.out(
        `the CA and certificate are in place (the certificate is valid until ${isoDate(leaf.notAfter)}); nothing to do`
      );
      return 0;
    }
    if (leaf.kind === 'ok')
      ctx.err(`replacing the certificate: it expired on ${isoDate(leaf.notAfter)}`);
    if (leaf.kind === 'refused') ctx.err(`replacing the certificate: ${leaf.problem}`);
    await opensslVersion(ctx.openssl);
    const gate = await issuanceClock(ctx, { lenient: true, waitMs: CLOCK_WAIT_MS });
    if (!gate.ok) {
      ctx.err(`not issuing: ${gate.reason}`);
      return 1;
    }
    const made = await makeLeaf(ctx, ca);
    writeLeaf(layout.tlsDir, layout, made.issued, ctx.hook);
    reportOutside(ctx, made.outside);
    ctx.out(`issued a certificate: SHA-256 ${made.issued.fingerprint}`);
    return 0;
  } finally {
    removeTree(paths(layout).work);
  }
}
