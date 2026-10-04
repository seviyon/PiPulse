// browser-kit.ts — manual check that browsers enforce the generated CA's name
// constraints (spec: "Browser name-constraint check"). Not part of the suite.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { issueCa, issueLeaf, type IssueScope } from '../src/issue.js';
import { TEST_OPENSSL } from './openssl.js';

const [out, lanIp] = process.argv.slice(2);
// The kit's CA always carries the single-label exclusions: it exists to test them (D2 gate).
if (!out || !lanIp) throw new Error('usage: browser-kit.ts <outDir> <this Mac LAN IP>');
mkdirSync(out, { recursive: true });
const scope: IssueScope = {
  dns: ['pipulse-check', 'pipulse-check.local', 'localhost', 'io'],
  excludedDns: ['.pipulse-check', '.localhost', '.io'],
  ip: [
    { address: '127.0.0.1', prefix: 32 },
    { address: '::1', prefix: 128 },
    { address: '10.99.0.0', prefix: 24 }
  ]
};
const now = Date.now();
const ca = await issueCa({
  openssl: TEST_OPENSSL,
  workDir: out,
  subject: 'PiPulse browser check CA',
  scope,
  now
});
writeFileSync(join(out, 'ca.key'), ca.keyPem, { mode: 0o600 });
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
console.log(`CA SHA-256 ${ca.fingerprint}\nwrote ${out}`);
