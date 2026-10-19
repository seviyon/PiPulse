import { X509Certificate } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { parseArgs } from 'node:util';
import { paths } from '../ca/layout.js';
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

/** The slice of `process` that changes identity (tests pass a fake). */
export interface Identity {
  geteuid?: () => number;
  getgroups?: () => number[];
  setgroups?: (groups: number[]) => void;
  seteuid?: (uid: number) => void;
  setegid?: (gid: number) => void;
}

/**
 * Runs `fn` as the user who typed `sudo` (SUDO_UID/SUDO_GID), when this process is root: a
 * file written for them must be made with their rights, or `--out /etc/ld.so.preload` through
 * a narrow sudoers rule would let them create root-trusted files. The supplementary groups
 * are replaced too (root's would still open things the caller can't). Root again afterwards,
 * also when `fn` throws. Not root, or no SUDO_UID: `fn` runs as it is.
 */
export function asCaller<T>(env: NodeJS.ProcessEnv, fn: () => T, proc: Identity = process): T {
  const uid = Number(env['SUDO_UID']);
  const gid = Number(env['SUDO_GID']);
  if (
    proc.geteuid?.() !== 0 ||
    !Number.isInteger(uid) ||
    !Number.isInteger(gid) ||
    uid <= 0 ||
    gid < 0 ||
    !proc.seteuid ||
    !proc.setegid ||
    !proc.setgroups
  )
    return fn();
  const groups = proc.getgroups?.() ?? [0];
  proc.setgroups([gid]);
  proc.setegid(gid);
  proc.seteuid(uid);
  try {
    return fn();
  } finally {
    proc.seteuid(0);
    proc.setegid(0);
    proc.setgroups(groups);
  }
}

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
    // The file is made O_EXCL|O_NOFOLLOW, as the user who asked (asCaller), and the mode goes
    // through its descriptor: the CLI runs under umask 077, so it must be set explicitly (the CA
    // certificate is public and meant to be copied to other devices).
    const out = values.out;
    const failure = asCaller(ctx.env, () => {
      let fd: number | undefined;
      try {
        fd = openSync(
          out,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o644
        );
        fchmodSync(fd, 0o644);
        writeFileSync(fd, pem);
        return undefined;
      } catch (error) {
        if (fd !== undefined) rmSync(out, { force: true });
        return (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'it already exists'
          : (error as Error).message;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    });
    if (failure !== undefined) {
      ctx.err(`can't write ${out}: ${failure}`);
      return 1;
    }
    ctx.err(`wrote ${values.out}`);
  } else {
    ctx.out(pem.trimEnd());
  }
  ctx.err(`PiPulse CA on ${ctx.hostname()}: SHA-256 ${fingerprint}`);
  ctx.err(
    'Compare it with the fingerprint `sudo pipulse tls status` prints on the Pi itself (over SSH or at its console), never with one a web page shows.'
  );
  for (const line of TRUST_STEPS) ctx.err(line);
  return 0;
}
