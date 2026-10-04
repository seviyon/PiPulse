import type { Context } from '../src/cli-common.js';
import type { Layout } from '../src/layout.js';
import { TEST_OPENSSL } from './openssl.js';

export const NOW = Date.now();

export type TestContext = Context & {
  lines: string[];
  errors: string[];
  restarts: number;
  setNow(value: number): void;
};

/** A root CLI context in `dir`: synced clock, host "io" at 192.168.1.35, no terminal. `sleep` advances `now`. */
export function testContext(dir: string, overrides: Partial<Context> = {}): TestContext {
  let t = NOW;
  const layout: Layout = {
    tlsDir: dir,
    caRoot: dir,
    uid: process.getuid!(),
    gid: process.getgid!(),
    privateGid: process.getgid!()
  };
  const ctx: TestContext = {
    env: { PIPULSE_TLS_DIR: dir },
    layout,
    openssl: TEST_OPENSSL,
    now: () => t,
    hostname: () => 'io',
    addresses: () => ['192.168.1.35'],
    candidate: () => ({ iface: 'eth0', cidr: '192.168.1.0/24' }),
    interfaces: () => ({}),
    clock: () => ({ state: 'synced', synced: true }),
    isRoot: true,
    tty: false,
    ask: async () => false,
    out: (line) => {
      ctx.lines.push(line);
    },
    err: (line) => {
      ctx.errors.push(line);
    },
    restart: async () => {
      ctx.restarts++;
    },
    health: async () => ({ code: 0, message: 'healthy' }),
    sleep: async (ms) => {
      t += ms;
    },
    inContainer: false,
    defaultTlsDir: dir,
    lockWaitMs: 0,
    lines: [],
    errors: [],
    restarts: 0,
    setNow: (value) => {
      t = value;
    },
    ...overrides
  };
  return ctx;
}
