// Multi-process stress for the pipulse tls lock: `node test/lock-stress.mjs [workers] [seconds]`
// (needs `npm run build` first). Workers loop on withLock and mark a critical section with an
// O_EXCL file; with STALE=1 another process keeps putting the lock of a dead process on the
// path, so every worker is also breaking stale locks while the others queue. Prints
// `overlaps=<n>`: two workers inside at once. Breaking a stale lock is a run of syscalls, so a
// race in it can only show between processes, never inside one.
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK = new URL('../dist/lock.js', import.meta.url).href;
const [role, dir, secs] = process.argv.slice(2);

if (role === 'worker') {
  const { withLock } = await import(LOCK);
  const layout = { caRoot: dir, tlsDir: dir };
  const end = Date.now() + Number(secs) * 1000;
  const inside = join(dir, 'inside');
  while (Date.now() < end) {
    try {
      await withLock(
        layout,
        async () => {
          let fd;
          try {
            fd = openSync(inside, 'wx');
          } catch {
            appendFileSync(join(dir, 'overlaps'), `${process.pid}\n`);
            return;
          }
          appendFileSync(join(dir, 'entered'), 'x');
          await new Promise((resolve) => setTimeout(resolve, 2));
          closeSync(fd);
          rmSync(inside, { force: true });
        },
        {
          create: false,
          waitMs: 5000,
          sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
          onLost: () => appendFileSync(join(dir, 'lost'), `${process.pid}\n`)
        }
      );
    } catch {
      // a LockError after waiting: try again
    }
  }
} else if (role === 'stale') {
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const path = join(dir, '.pipulse-tls.lock');
  const end = Date.now() + Number(secs) * 1000;
  while (Date.now() < end) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(
        fd,
        JSON.stringify({
          pid: dead,
          startTime: null,
          bootId: null,
          pidNs: null,
          host: hostname(),
          token: `dead-${Math.random()}`,
          startedAt: Date.now()
        })
      );
      closeSync(fd);
    } catch {
      // a lock is there: wait for it to go
    }
    if (process.env.LEFTOVERS === '1') {
      // what a breaker killed mid-break leaves: an unowned mutex, a minute old
      try {
        const fd = openSync(`${path}.breaking`, 'wx', 0o600);
        closeSync(fd);
        const old = new Date(Date.now() - 60_000);
        utimesSync(`${path}.breaking`, old, old);
      } catch {
        // one is there already
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
} else {
  const workers = Number(process.argv[2] ?? 6);
  const seconds = process.argv[3] ?? '20';
  const root = mkdtempSync(join(tmpdir(), 'lock-stress-'));
  const run = (kind) =>
    new Promise((resolve) =>
      spawn(process.execPath, [process.argv[1], kind, root, seconds], { stdio: 'inherit' }).on(
        'exit',
        resolve
      )
    );
  const jobs = Array.from({ length: workers }, () => run('worker'));
  if (process.env.STALE === '1') jobs.push(run('stale'));
  await Promise.all(jobs);
  const lines = (name) =>
    existsSync(join(root, name))
      ? readFileSync(join(root, name), 'utf8').split('\n').filter(Boolean).length
      : 0;
  const entered = existsSync(join(root, 'entered'))
    ? readFileSync(join(root, 'entered'), 'utf8').length
    : 0;
  console.log(
    `workers=${workers} seconds=${seconds} sections=${entered} overlaps=${lines('overlaps')} lost=${lines('lost')}`
  );
  rmSync(root, { recursive: true, force: true });
}
