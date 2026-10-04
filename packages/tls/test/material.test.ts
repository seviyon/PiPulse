import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildConstraints } from '../src/constraints.js';
import { ensureDir } from '../src/files.js';
import { MODES, paths, pub, readMeta, type Layout } from '../src/layout.js';
import {
  checkCa,
  checkLeaf,
  makeLeaf,
  prepareWork,
  repairPublic,
  stageNewCa,
  validateStage,
  writeLeaf,
  type IssueContext
} from '../src/material.js';
import { tempDir } from './helpers.js';
import { TEST_OPENSSL } from './openssl.js';

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
});
