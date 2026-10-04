import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildConstraints } from '../src/constraints.js';
import { SimulatedCrash, type FsHook } from '../src/files.js';
import { readTxn, recover, runTransaction } from '../src/journal.js';
import { listBackups, paths, pub, readMeta, type Layout } from '../src/layout.js';
import {
  checkCa,
  checkLeaf,
  prepareWork,
  repairPublic,
  stageNewCa,
  validateStage,
  type IssueContext
} from '../src/material.js';
import { tempDir } from './helpers.js';
import { TEST_OPENSSL } from './openssl.js';

const NOW = Date.now();
const { constraints } = buildConstraints({ hostname: 'io', names: [], subnets: [] });

let dir: string;
let ctx: IssueContext;
function freshContext(): IssueContext {
  dir = tempDir();
  const layout: Layout = {
    tlsDir: dir,
    caRoot: dir,
    uid: process.getuid!(),
    gid: process.getgid!(),
    privateGid: process.getgid!()
  };
  prepareWork(layout);
  return {
    env: {},
    layout,
    openssl: TEST_OPENSSL,
    now: () => NOW,
    hostname: () => 'io',
    addresses: () => []
  };
}
beforeEach(() => {
  ctx = freshContext();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Makes the first CA the normal way (a clean init transaction). */
async function init(context: IssueContext, hook?: FsHook) {
  return runTransaction(context.layout, {
    kind: 'init',
    now: NOW,
    ...(hook ? { hook } : {}),
    stage: async (dirs) => {
      await stageNewCa({ ...context, hook }, dirs, constraints, []);
    },
    validate: (dirs) => {
      validateStage(dirs, pub(context.layout));
    }
  });
}

async function newCa(context: IssueContext, hook?: FsHook) {
  return runTransaction(context.layout, {
    kind: 'new-ca',
    now: NOW + 1000,
    ...(hook ? { hook } : {}),
    stage: async (dirs, backup) => {
      await stageNewCa({ ...context, hook }, dirs, constraints, [
        ...listBackups(context.layout),
        ...(backup
          ? [{ name: backup, fingerprint: activeFingerprint(context), createdAt: NOW }]
          : [])
      ]);
    },
    validate: (dirs) => {
      validateStage(dirs, pub(context.layout));
    }
  });
}

const activeFingerprint = (context: IssueContext) => {
  const check = checkCa(paths(context.layout).caDir);
  return check.kind === 'ok' ? check.ca.fingerprint : '';
};

/** One CA, its public copies and a leaf that verifies against it; or nothing at all. */
function consistent(context: IssueContext): string | 'nothing' {
  const p = paths(context.layout);
  expect(readTxn(context.layout)).toBeUndefined();
  const leftovers = readdirSync(dir).filter((name) => /^(ca\.next-|\.next-)|\.tmp$/.test(name));
  expect(leftovers).toEqual([]);
  const check = checkCa(p.caDir);
  if (check.kind === 'none') {
    expect(existsSync(p.publicCa) || existsSync(p.bundle)).toBe(false);
    return 'nothing';
  }
  expect(check.kind).toBe('ok');
  if (check.kind !== 'ok') throw new Error('unreachable');
  expect(readFileSync(p.publicCa, 'utf8')).toBe(check.ca.certPem);
  expect(readMeta(context.layout)?.fingerprint).toBe(check.ca.fingerprint);
  expect(checkLeaf(p.bundle, check.ca, pub(context.layout)).kind).toBe('ok');
  return check.ca.fingerprint;
}

/** How many hook calls a clean run makes. */
async function countPoints(run: (hook: FsHook) => Promise<unknown>): Promise<number> {
  let n = 0;
  await run(() => {
    n++;
  });
  return n;
}

describe('runTransaction', () => {
  it('installs a first CA and leaf (init)', async () => {
    expect((await init(ctx)).backup).toBeNull();
    expect(consistent(ctx)).not.toBe('nothing');
  });

  it('replaces the CA and keeps the old one as a backup (new-ca)', async () => {
    await init(ctx);
    const before = activeFingerprint(ctx);
    const { backup } = await newCa(ctx);
    const after = consistent(ctx);
    expect(after).not.toBe(before);
    expect(backup).toMatch(/^ca\.old-/);
    expect(listBackups(ctx.layout).map((b) => b.fingerprint)).toEqual([before]);
  });

  it('two CA changes in the same second get different backup names', async () => {
    await init(ctx);
    const first = await newCa(ctx);
    const second = await newCa(ctx); // the same fixed NOW: the same second
    expect(first.backup).toMatch(/^ca\.old-/);
    expect(second.backup).toMatch(/^ca\.old-/);
    expect(second.backup).not.toBe(first.backup);
    expect(listBackups(ctx.layout)).toHaveLength(2);
  });

  it('a failure while staging leaves the serving CA and leaf untouched', async () => {
    await init(ctx);
    const before = consistent(ctx);
    await expect(
      runTransaction(ctx.layout, {
        kind: 'new-ca',
        now: NOW + 1000,
        stage: async () => {
          throw new Error('openssl failed');
        },
        validate: () => {}
      })
    ).rejects.toThrow('openssl failed');
    expect(consistent(ctx)).toBe(before);
  });

  it('refuses to start while another transaction is unfinished', async () => {
    await init(ctx);
    // Crash just before the active CA would move to its backup folder.
    await expect(
      newCa(ctx, (point, path) => {
        if (point === 'rename' && path.includes('ca.old-')) throw new SimulatedCrash('crash');
      })
    ).rejects.toThrow(SimulatedCrash);
    await expect(newCa(ctx)).rejects.toThrow(/unfinished CA change/);
    recover(ctx.layout);
    await expect(newCa(ctx)).resolves.toBeDefined();
  });
});

describe('recover after a crash at every hook point', () => {
  let initPoints: number;
  let newCaPoints: number;
  beforeAll(async () => {
    const context = freshContext();
    initPoints = await countPoints((hook) => init(context, hook));
    newCaPoints = await countPoints((hook) => newCa(context, hook));
    rmSync(dir, { recursive: true, force: true });
  });

  it('init: ends with nothing or one complete CA, every time', async () => {
    expect(initPoints).toBeGreaterThan(10);
    for (let k = 0; k < initPoints; k++) {
      ctx = freshContext();
      let calls = 0;
      await expect(
        init(ctx, () => {
          if (calls++ === k) throw new SimulatedCrash(`crash at ${k}`);
        })
      ).rejects.toThrow(SimulatedCrash);
      recover(ctx.layout);
      if (consistent(ctx) === 'nothing') {
        await init(ctx);
        expect(consistent(ctx)).not.toBe('nothing');
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('new-ca: ends with the old CA untouched or the new one plus a backup of the old', async () => {
    for (let k = 0; k < newCaPoints; k++) {
      ctx = freshContext();
      await init(ctx);
      const old = activeFingerprint(ctx);
      let calls = 0;
      await expect(
        newCa(ctx, () => {
          if (calls++ === k) throw new SimulatedCrash(`crash at ${k}`);
        })
      ).rejects.toThrow(SimulatedCrash);
      recover(ctx.layout);
      const now = consistent(ctx);
      const backups = listBackups(ctx.layout);
      if (now === old) {
        expect(backups).toEqual([]);
      } else {
        expect(backups.map((b) => b.fingerprint)).toEqual([old]);
        // A crash after the new CA landed may leave ca-meta.json listing it
        // before the backup is visible; repairPublic makes them agree.
        const check = checkCa(paths(ctx.layout).caDir);
        if (check.kind === 'ok') repairPublic(ctx, check.ca);
        expect(readMeta(ctx.layout)?.backups.map((b) => b.fingerprint)).toEqual([old]);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it('sweeps an issue-* folder a killed issuance left in the work folder', async () => {
    const stale = join(paths(ctx.layout).work, 'issue-abc123');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'key.pem'), 'secret');
    expect(recover(ctx.layout)).toBe('none');
    expect(existsSync(stale)).toBe(false);
    // and with a journal pending too
    await init(ctx);
    mkdirSync(stale, { recursive: true });
    recover(ctx.layout);
    expect(existsSync(stale)).toBe(false);
  });

  it('a second recover is a no-op', async () => {
    await init(ctx);
    expect(recover(ctx.layout)).toBe('none');
  });
});
