import { X509Certificate } from 'node:crypto';
import { chownSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { paths } from './layout.js';
import { usage, type Context } from './cli-common.js';

/** Per-OS steps. The wording is always "trust this certificate authority", never "accept this certificate". */
export const TRUST_STEPS = [
  'Trust this certificate authority on each device that opens PiPulse (not a single certificate):',
  '  macOS (Safari, Chrome): sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain pipulse-ca.crt',
  '  Firefox: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import (tick "identify websites");',
  '           on macOS and Windows, setting security.enterprise_roots.enabled to true in about:config makes it use the system store',
  '  Windows (administrator prompt): certutil -addstore -f Root pipulse-ca.crt',
  '  Debian/Ubuntu: sudo cp pipulse-ca.crt /usr/local/share/ca-certificates/pipulse.crt && sudo update-ca-certificates',
  '           (Chrome on Linux: certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n pipulse -i pipulse-ca.crt)',
  '  iPhone/iPad: open the file, install the profile, then Settings → General → About → Certificate Trust Settings → turn it on',
  '  Android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate',
  'Before importing, check the fingerprint on that device: openssl x509 -in pipulse-ca.crt -noout -fingerprint -sha256'
];

export function exportCa(ctx: Context, args: string[]): number {
  const { values } = usage(() =>
    parseArgs({ args, options: { out: { type: 'string' } }, strict: true })
  );
  let pem: string;
  try {
    pem = readFileSync(paths(ctx.layout).publicCa, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      ctx.err('there is no generated CA yet: sudo pipulse tls init makes one');
      return 1;
    }
    throw error;
  }
  const fingerprint = new X509Certificate(pem).fingerprint256;
  if (values.out) {
    try {
      writeFileSync(values.out, pem, { mode: 0o644, flag: 'wx' });
    } catch (error) {
      ctx.err(
        `can't write ${values.out}: ${(error as NodeJS.ErrnoException).code === 'EEXIST' ? 'it already exists' : (error as Error).message}`
      );
      return 1;
    }
    // Written as root through sudo: hand the file to the user who asked for it.
    const uid = Number(ctx.env['SUDO_UID']);
    const gid = Number(ctx.env['SUDO_GID']);
    if (Number.isInteger(uid) && Number.isInteger(gid) && uid > 0) chownSync(values.out, uid, gid);
    ctx.err(`wrote ${values.out}`);
  } else {
    ctx.out(pem.trimEnd());
  }
  ctx.err(`PiPulse CA on ${hostname()}: SHA-256 ${fingerprint}`);
  ctx.err(
    'Compare it with the fingerprint `sudo pipulse tls status` prints on the Pi itself (over SSH or at its console), never with one a web page shows.'
  );
  for (const line of TRUST_STEPS) ctx.err(line);
  return 0;
}
