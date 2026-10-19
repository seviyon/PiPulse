import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildConstraints } from '../../src/ca/constraints.js';
import { ensureDir } from '../../src/common/files.js';
import { MODES, paths, pub, readMeta, type Layout } from '../../src/ca/layout.js';
import {
  checkCa,
  checkLeaf,
  makeLeaf,
  prepareWork,
  repairPublic,
  stageCopiedCa,
  stageNewCa,
  validateStage,
  writeLeaf,
  type IssueContext
} from '../../src/ca/material.js';
import { fixture, tempDir } from '../helpers.js';
import { TEST_OPENSSL } from '../openssl.js';

let dir: string;
let ctx: IssueContext;
const NOW = Date.now();
beforeEach(() => {
  dir = tempDir();
  const layout: Layout = {
    tlsDir: dir,
    caRoot: dir,
    uid: process.getuid!(),
    gid: process.getgid!(),
    privateGid: process.getgid!()
  };
  ctx = {
    env: {},
    layout,
    openssl: TEST_OPENSSL,
    now: () => NOW,
    hostname: () => 'io',
    addresses: () => ['192.168.1.35']
  };
  prepareWork(layout);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const { constraints } = buildConstraints({
  hostname: 'io',
  names: [],
  subnets: ['192.168.1.0/24']
});

async function stagedCa() {
  const dirs = { ca: join(dir, 'ca.next-test'), pub: join(dir, '.next-test') };
  ensureDir(dirs.ca, { mode: 0o700 });
  ensureDir(dirs.pub, { mode: 0o750 });
  const staged = await stageNewCa(ctx, dirs, constraints, []);
  return { dirs, ...staged };
}

describe('stageNewCa', () => {
  it('stages a CA and a leaf that validate, with the right modes, key never public', async () => {
    const { dirs, ca } = await stagedCa();
    expect(validateStage(dirs, pub(ctx.layout)).fingerprint).toBe(ca.fingerprint);
    expect(statSync(join(dirs.ca, 'ca', 'ca.key')).mode & 0o777).toBe(MODES.caFile);
    expect(statSync(join(dirs.ca, 'ca')).mode & 0o777).toBe(MODES.caDir);
    expect(statSync(join(dirs.pub, 'leaf.pem')).mode & 0o777).toBe(MODES.bundle);
    expect(statSync(join(dirs.pub, 'ca.crt')).mode & 0o777).toBe(MODES.publicCert);
    const bundle = readFileSync(join(dirs.pub, 'leaf.pem'), 'utf8');
    const caKey = readFileSync(join(dirs.ca, 'ca', 'ca.key'), 'utf8');
    expect(bundle).not.toContain(caKey.split('\n')[1]);
    expect(ca.subject).toMatch(/^PiPulse CA io [0-9a-f]{6}$/);
    expect(ca.constraints).toEqual(constraints);
  });

  it('puts the default-route address in the leaf when the CA covers it', async () => {
    const { dirs, ca } = await stagedCa();
    const leaf = checkLeaf(join(dirs.pub, 'leaf.pem'), ca, pub(ctx.layout));
    expect(leaf.kind === 'ok' && leaf.sans).toEqual({
      dns: ['io', 'io.local', 'localhost'],
      ip: ['127.0.0.1', '::1', '192.168.1.35']
    });
  });

  it('leaves no key material in the work folder', async () => {
    await stagedCa();
    expect(existsSync(paths(ctx.layout).work)).toBe(true);
    expect(readdirSync(paths(ctx.layout).work)).toEqual([]);
  });
});

describe('checkCa', () => {
  it('reports a partial CA instead of ever regenerating it', async () => {
    const { dirs } = await stagedCa();
    const caDir = join(dirs.ca, 'ca');
    unlinkSync(join(caDir, 'ca.key'));
    expect(checkCa(caDir)).toEqual({ kind: 'partial', problem: `${caDir} is missing ca.key` });
  });
  it('reports a key that does not match', async () => {
    const one = await stagedCa();
    const other = { ...ctx, layout: { ...ctx.layout } };
    const dirs2 = { ca: join(dir, 'ca.next-two'), pub: join(dir, '.next-two') };
    ensureDir(dirs2.ca, { mode: 0o700 });
    ensureDir(dirs2.pub, { mode: 0o750 });
    await stageNewCa(other, dirs2, constraints, []);
    writeFileSync(join(one.dirs.ca, 'ca', 'ca.key'), readFileSync(join(dirs2.ca, 'ca', 'ca.key')));
    chmodSync(join(one.dirs.ca, 'ca', 'ca.key'), 0o600);
    const check = checkCa(join(one.dirs.ca, 'ca'));
    expect(check.kind === 'partial' && check.problem).toMatch(/does not match/);
  });
  it('is "none" when there is no CA folder', () => {
    expect(checkCa(join(dir, 'ca'))).toEqual({ kind: 'none' });
  });
});

describe('checkLeaf', () => {
  it('refuses a leaf from another CA and a world-readable bundle', async () => {
    const one = await stagedCa();
    const dirs2 = { ca: join(dir, 'ca.next-two'), pub: join(dir, '.next-two') };
    ensureDir(dirs2.ca, { mode: 0o700 });
    ensureDir(dirs2.pub, { mode: 0o750 });
    const two = await stageNewCa(ctx, dirs2, constraints, []);
    expect(checkLeaf(join(dirs2.pub, 'leaf.pem'), one.ca).kind).toBe('refused');
    chmodSync(join(dirs2.pub, 'leaf.pem'), 0o644);
    const check = checkLeaf(join(dirs2.pub, 'leaf.pem'), two.ca);
    expect(check.kind === 'refused' && check.problem).toMatch(/broader than 640/);
  });
});

describe('a CA that cannot be seen is not "none"', () => {
  const asRoot = process.getuid?.() === 0;

  it.skipIf(asRoot)('reports an unreadable parent as partial, never as no CA', () => {
    const parent = join(dir, 'locked');
    mkdirSync(join(parent, 'ca'), { recursive: true });
    chmodSync(parent, 0o000);
    try {
      const check = checkCa(join(parent, 'ca'));
      expect(check.kind).toBe('partial');
      expect(check.kind === 'partial' && check.problem).toMatch(/can't be checked \(EACCES\)/);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  it.skipIf(asRoot)('reports a file it cannot stat as such, not as missing', () => {
    const caDir = join(dir, 'ca');
    mkdirSync(caDir);
    chmodSync(caDir, 0o000);
    try {
      const check = checkCa(caDir);
      expect(check.kind === 'partial' && check.problem).toMatch(/can't be checked/);
      expect(check.kind === 'partial' && check.problem).not.toMatch(/is missing/);
    } finally {
      chmodSync(caDir, 0o700);
    }
  });

  it('still says none for a folder that is not there, and missing for an absent file', () => {
    expect(checkCa(join(dir, 'nothing')).kind).toBe('none');
    const caDir = join(dir, 'ca');
    mkdirSync(caDir);
    const check = checkCa(caDir);
    expect(check.kind === 'partial' && check.problem).toMatch(/is missing ca\.key, ca\.crt/);
  });

  it('checkLeaf: missing only for ENOENT', () => {
    expect(checkLeaf(join(dir, 'nope', 'leaf.pem'), { certPem: '' }).kind).toBe('missing');
    if (asRoot) return;
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const check = checkLeaf(join(locked, 'leaf.pem'), { certPem: '' });
      expect(check.kind === 'refused' && check.problem).toMatch(/can't be checked \(EACCES\)/);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('checkLeaf: an expired leaf is still "ok" and reports its dates (callers decide)', () => {
    const bundle = join(dir, 'expired.pem');
    writeFileSync(
      bundle,
      fixture('expired.key') + fixture('expired.crt') + fixture('intermediate.crt'),
      { mode: 0o640 }
    );
    const check = checkLeaf(bundle, { certPem: fixture('root-ca.crt') });
    expect(check.kind).toBe('ok');
    expect(check.kind === 'ok' && check.notAfter).toBeLessThan(Date.now());
  });
});

describe('repairPublic and writeLeaf', () => {
  it('rewrites a missing public ca.crt and ca-meta.json from the CA, and nothing else', async () => {
    const { ca } = await stagedCa();
    const fixed = repairPublic(ctx, ca);
    expect(fixed.sort()).toEqual(['ca-meta.json', 'ca.crt']);
    expect(readFileSync(paths(ctx.layout).publicCa, 'utf8')).toBe(ca.certPem);
    expect(readMeta(ctx.layout)?.fingerprint).toBe(ca.fingerprint);
    expect(repairPublic(ctx, ca)).toEqual([]);
    const leaf = await makeLeaf(ctx, ca);
    writeLeaf(dir, ctx.layout, leaf.issued);
    expect(checkLeaf(paths(ctx.layout).bundle, ca, pub(ctx.layout)).kind).toBe('ok');
  });

  it('rewrites leaf.crt from leaf.pem when a kill left them apart', async () => {
    const { ca } = await stagedCa();
    repairPublic(ctx, ca);
    const first = await makeLeaf(ctx, ca);
    writeLeaf(dir, ctx.layout, first.issued);
    expect(repairPublic(ctx, ca)).toEqual([]);
    // A second leaf was written, but the kill came between leaf.crt and leaf.pem: leaf.crt is new.
    const second = await makeLeaf(ctx, ca);
    writeFileSync(paths(ctx.layout).leafCrt, second.issued.certPem);
    expect(repairPublic(ctx, ca)).toEqual(['leaf.crt']);
    expect(readFileSync(paths(ctx.layout).leafCrt, 'utf8')).toBe(first.issued.certPem);
    expect(repairPublic(ctx, ca)).toEqual([]);
    // A missing leaf.crt is restored too.
    unlinkSync(paths(ctx.layout).leafCrt);
    expect(repairPublic(ctx, ca)).toEqual(['leaf.crt']);
  });
});

/** A second staged CA, for swapping one of its files into the first. */
async function otherCa(name: string) {
  const dirs = { ca: join(dir, `ca.next-${name}`), pub: join(dir, `.next-${name}`) };
  ensureDir(dirs.ca, { mode: 0o700 });
  ensureDir(dirs.pub, { mode: 0o750 });
  return { dirs, ...(await stageNewCa(ctx, dirs, constraints, [])) };
}
const copyOver = (from: string, to: string, mode: number) => {
  writeFileSync(to, readFileSync(from));
  chmodSync(to, mode);
};

describe('checkCa, files that disagree', () => {
  it('refuses a ca.crt that is not a CA certificate', async () => {
    const { dirs } = await stagedCa();
    const caDir = join(dirs.ca, 'ca');
    copyOver(join(dirs.pub, 'leaf.crt'), join(caDir, 'ca.crt'), MODES.caFile);
    const check = checkCa(caDir);
    expect(check).toEqual({
      kind: 'partial',
      problem: `${caDir}: ca.crt is not a CA certificate`
    });
  });

  it('refuses a constraints.json that belongs to another CA', async () => {
    const one = await stagedCa();
    const two = await otherCa('two');
    const caDir = join(one.dirs.ca, 'ca');
    copyOver(join(two.dirs.ca, 'ca', 'constraints.json'), join(caDir, 'constraints.json'), 0o600);
    expect(checkCa(caDir)).toEqual({
      kind: 'partial',
      problem: `${caDir}: constraints.json belongs to another CA`
    });
  });

  it('reports a constraints.json it cannot parse as partial, with the reason', async () => {
    const { dirs } = await stagedCa();
    const caDir = join(dirs.ca, 'ca');
    writeFileSync(join(caDir, 'constraints.json'), 'not json', { mode: 0o600 });
    const check = checkCa(caDir);
    expect(check.kind).toBe('partial');
    expect(check.kind === 'partial' && check.problem.startsWith(`${caDir}: `)).toBe(true);
  });
});

describe('validateStage, what a stage must hold', () => {
  it('names an incomplete staged CA', async () => {
    const { dirs } = await stagedCa();
    unlinkSync(join(dirs.ca, 'ca', 'ca.key'));
    expect(() => validateStage(dirs, pub(ctx.layout))).toThrow(
      /the staged CA is not complete: .*is missing ca\.key/
    );
  });

  it('says "missing" when there is no staged CA folder at all', async () => {
    const { dirs } = await stagedCa();
    rmSync(join(dirs.ca, 'ca'), { recursive: true });
    expect(() => validateStage(dirs, pub(ctx.layout))).toThrow(
      'the staged CA is not complete: missing'
    );
  });

  it('refuses a staged ca.crt that is not the staged CA', async () => {
    const one = await stagedCa();
    const two = await otherCa('two');
    copyOver(join(two.dirs.pub, 'ca.crt'), join(one.dirs.pub, 'ca.crt'), MODES.publicCert);
    expect(() => validateStage(one.dirs, pub(ctx.layout))).toThrow(
      'the staged ca.crt is not the staged CA'
    );
  });

  it('refuses a staged ca-meta.json that describes another CA', async () => {
    const one = await stagedCa();
    const two = await otherCa('two');
    copyOver(join(two.dirs.pub, 'ca-meta.json'), join(one.dirs.pub, 'ca-meta.json'), 0o640);
    expect(() => validateStage(one.dirs, pub(ctx.layout))).toThrow(
      'the staged ca-meta.json describes another CA'
    );
  });

  it('refuses a staged leaf that is missing, or one the policy refuses', async () => {
    const { dirs } = await stagedCa();
    const leaf = join(dirs.pub, 'leaf.pem');
    chmodSync(leaf, 0o644);
    expect(() => validateStage(dirs, pub(ctx.layout))).toThrow(
      /the staged leaf is not usable: .*broader than 640/
    );
    unlinkSync(leaf);
    expect(() => validateStage(dirs, pub(ctx.layout))).toThrow(
      'the staged leaf is not usable: missing'
    );
  });
});

describe('stageCopiedCa', () => {
  it('copies a backed-up CA and makes a leaf that validates', async () => {
    const source = await stagedCa();
    const dirs = { ca: join(dir, 'ca.next-copy'), pub: join(dir, '.next-copy') };
    ensureDir(dirs.ca, { mode: 0o700 });
    ensureDir(dirs.pub, { mode: 0o750 });
    const copied = await stageCopiedCa(ctx, dirs, join(source.dirs.ca, 'ca'), []);
    expect(copied.ca.fingerprint).toBe(source.ca.fingerprint);
    expect(validateStage(dirs, pub(ctx.layout)).fingerprint).toBe(source.ca.fingerprint);
  });

  it('refuses to stage a backup whose key does not match its certificate', async () => {
    const source = await stagedCa();
    const other = await otherCa('two');
    const backup = join(source.dirs.ca, 'ca');
    copyOver(join(other.dirs.ca, 'ca', 'ca.key'), join(backup, 'ca.key'), MODES.caFile);
    const dirs = { ca: join(dir, 'ca.next-copy'), pub: join(dir, '.next-copy') };
    ensureDir(dirs.ca, { mode: 0o700 });
    ensureDir(dirs.pub, { mode: 0o750 });
    await expect(stageCopiedCa(ctx, dirs, backup, [])).rejects.toThrow(
      /the staged CA did not check out: .*ca\.key does not match ca\.crt/
    );
  });
});

describe('repairPublic, an unreadable ca-meta.json', () => {
  it('is rewritten from the CA instead of failing', async () => {
    const { ca } = await stagedCa();
    repairPublic(ctx, ca);
    writeFileSync(paths(ctx.layout).meta, 'not json', { mode: 0o640 });
    expect(repairPublic(ctx, ca)).toEqual(['ca-meta.json']);
    expect(readMeta(ctx.layout)?.fingerprint).toBe(ca.fingerprint);
  });
});
