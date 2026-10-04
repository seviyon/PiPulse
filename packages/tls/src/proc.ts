import { readFileSync } from 'node:fs';

const readText = (path: string) => readFileSync(path, 'utf8');

/**
 * A process's start time (/proc/<pid>/stat field 22, clock ticks since boot)
 * and the boot id: together they tell a reused pid apart. Linux only;
 * undefined elsewhere or when the pid is gone.
 */
export function processIdentity(
  pid: number,
  read: (path: string) => string = readText
): { startTime: string; bootId: string } | undefined {
  try {
    const stat = read(`/proc/${pid}/stat`);
    // Field 2 (the command) may hold spaces and parentheses: count from the last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTime = rest[19]; // fields 3.. are rest[0..], so field 22 is rest[19]
    const bootId = read('/proc/sys/kernel/random/boot_id').trim();
    return startTime && bootId ? { startTime, bootId } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `pid` runs (EPERM: it does, as another user). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
