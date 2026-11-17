// browser-kit.ts — manual check that browsers enforce the generated CA's name constraints and
// purpose limits (spec: "Browser name-constraint check"; gate checklist
// docs/superpowers/checklists/2026-11-16-ca-purpose-limits-browser-check.md). Not part of the suite.
// The fourth argument is required: base | pr3 | pr3=eku | pr3=email | pr3=uri (see browser-kit-lib.ts).
import { runKit } from './browser-kit-lib.js';

process.exitCode = await runKit(process.argv.slice(2), {
  out: console.log,
  err: console.error
});
