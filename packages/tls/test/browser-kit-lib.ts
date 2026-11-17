import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import {
  NO_PURPOSE_LIMITS,
  PURPOSE_LIMITS,
  issueCa,
  issueLeaf,
  type IssueScope,
  type Issued,
  type PurposeLimits
} from '../src/ca/issue.js';
import { TEST_OPENSSL } from './openssl.js';

/**
 * What browser-kit.ts builds, kept apart from its entry so the arguments and the CA's extensions
 * can be tested. The CA comes from the real issueCa; the mode only says which purpose limits stay
 * on (gate checklist 2026-11-16, Part A items 5 and 6): `base` is today's CA before the limits,
 * `pr3` has all three, and `pr3=x` is base plus exactly that one line.
 */
export type KitMode = 'base' | 'pr3' | 'pr3=eku' | 'pr3=email' | 'pr3=uri';
export const KIT_MODES: readonly KitMode[] = ['base', 'pr3', 'pr3=eku', 'pr3=email', 'pr3=uri'];
export const KIT_USAGE =
  'usage: browser-kit.ts <outDir> <this Mac LAN IP> <base|pr3|pr3=eku|pr3=email|pr3=uri>';

export class KitUsageError extends Error {}

export function parseKitArgs(argv: string[]): { out: string; lanIp: string; mode: KitMode } {
  const [out, lanIp, mode, ...extra] = argv;
  if (!out || !lanIp || !mode || extra.length > 0) throw new KitUsageError(KIT_USAGE);
  if (!(KIT_MODES as readonly string[]).includes(mode)) throw new KitUsageError(KIT_USAGE);
  if (isIP(lanIp) === 0) throw new KitUsageError(KIT_USAGE); // checked before anything is written
  return { out, lanIp, mode: mode as KitMode };
}

export function kitLimits(mode: KitMode): PurposeLimits {
  if (mode === 'base') return NO_PURPOSE_LIMITS;
  if (mode === 'pr3') return PURPOSE_LIMITS;
  return { ...NO_PURPOSE_LIMITS, [mode.slice('pr3='.length)]: true };
}

// The kit's CA always carries the single-label exclusions: it exists to test them (D2 gate).
export const KIT_SCOPE: IssueScope = {
  dns: ['pipulse-check', 'pipulse-check.local', 'localhost', 'io'],
  excludedDns: ['.pipulse-check', '.localhost', '.io'],
  ip: [
    { address: '127.0.0.1', prefix: 32 },
    { address: '::1', prefix: 128 },
    { address: '10.99.0.0', prefix: 24 }
  ]
};

export function buildKitCa(o: {
  workDir: string;
  mode: KitMode;
  now: number;
  openssl?: string;
}): Promise<Issued> {
  return issueCa({
    openssl: o.openssl ?? TEST_OPENSSL,
    workDir: o.workDir,
    subject: 'PiPulse browser check CA',
    scope: KIT_SCOPE,
    now: o.now,
    limits: kitLimits(o.mode)
  });
}

export async function runKit(
  argv: string[],
  io: { out(line: string): void; err(line: string): void }
): Promise<number> {
  let args: ReturnType<typeof parseKitArgs>;
  try {
    args = parseKitArgs(argv);
  } catch (error) {
    if (!(error instanceof KitUsageError)) throw error;
    io.err(KIT_USAGE);
    return 2;
  }
  const { out, lanIp, mode } = args;
  mkdirSync(out, { recursive: true });
  const now = Date.now();
  const ca = await buildKitCa({ workDir: out, mode, now });
  writeFileSync(join(out, 'ca.key'), ca.keyPem, { mode: 0o600 });
  chmodSync(join(out, 'ca.key'), 0o600); // a re-run over an older, wider file keeps no wider mode
  writeFileSync(join(out, 'ca.crt'), ca.certPem);
  const leaves: [number, string[], string[]][] = [
    [8441, ['pipulse-check', 'pipulse-check.local'], []],
    [8442, [], ['127.0.0.1']],
    [8443, ['other-check.lan'], []],
    [8444, [], [lanIp]],
    [8445, ['x.pipulse-check'], []],
    [8446, ['io'], []],
    [8447, ['x.io'], []]
  ];
  for (const [port, dns, ip] of leaves) {
    const leaf = await issueLeaf({
      openssl: TEST_OPENSSL,
      workDir: out,
      ca: { keyPath: join(out, 'ca.key'), certPath: join(out, 'ca.crt'), certPem: ca.certPem },
      subject: 'browser check',
      dns,
      ip,
      now
    });
    writeFileSync(join(out, `${port}.pem`), leaf.keyPem + leaf.certPem, { mode: 0o600 });
    chmodSync(join(out, `${port}.pem`), 0o600);
  }
  writeFileSync(
    join(out, 'serve.mjs'),
    `import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
for (const port of [8441, 8442, 8443, 8444, 8445, 8446, 8447]) {
  const pem = readFileSync(new URL(port + '.pem', import.meta.url), 'utf8');
  createServer({ key: pem, cert: pem }, (_q, r) => r.end('port ' + port + ' ok\\n')).listen(port, '0.0.0.0');
}
console.log('serving 8441-8447; Ctrl-C to stop');
`
  );
  io.out(`mode ${mode}`);
  io.out(`CA SHA-256 ${ca.fingerprint}`);
  io.out(`wrote ${out}`);
  return 0;
}
