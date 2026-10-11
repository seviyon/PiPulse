/** Sleeps this many milliseconds, blocking the thread (a few of them while another process opens the file). */
const blockingSleep = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `fn`, trying again for a few seconds while it fails with "database is locked". Switching
 * to WAL while another connection is opening the same file answers that at once, without waiting
 * for the busy timeout.
 */
export function retryWhileLocked(
  fn: () => void,
  options: { attempts?: number; sleepMs?: number; sleep?: (ms: number) => void } = {}
): void {
  const attempts = options.attempts ?? 100;
  const sleepMs = options.sleepMs ?? 25;
  const sleep = options.sleep ?? blockingSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      fn();
      return;
    } catch (error) {
      if (attempt >= attempts || !/locked|busy/i.test((error as Error).message)) throw error;
      sleep(sleepMs);
    }
  }
}
