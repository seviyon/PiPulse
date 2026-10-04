import { parseArgs } from 'node:util';
import { opensslVersion } from './issue.js';
import { issuanceClock, CLOCK_WAIT_MS } from './clock-gate.js';
import { buildConstraints, checkSubnet, consequenceText, subnetWarning } from './constraints.js';
import { removeTree } from './files.js';
import { runTransaction } from './journal.js';
import { listBackups, paths, pub } from './layout.js';
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
  ensureTlsDirs,
  nativeLayoutProblem,
  operatorConfigured,
  printCa,
  reportOutside,
  usage,
  type Context
} from './cli-common.js';

export async function init(ctx: Context, args: string[]): Promise<number> {
  const { values } = usage(() =>
    parseArgs({
      args,
      options: { subnet: { type: 'string', multiple: true }, yes: { type: 'boolean' } },
      strict: true
    })
  );
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
      printCa(ctx);
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
    if (leaf.kind === 'ok') {
      ctx.out('the CA and certificate are in place; nothing to do');
      return 0;
    }
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
