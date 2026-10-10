import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/** Every fake plugin polls this often, so a changed reading reaches the dashboard within seconds. */
export const FAKE_INTERVAL_MS = 1000;

/** The control file's path, read by the fake collector inside the server process only. */
export const READINGS_ENV = 'PIPULSE_E2E_READINGS';

/** Values that keep every built-in alert rule quiet; a test changes one at a time. */
export const DEFAULT_READINGS: Readonly<Record<string, number>> = {
  cpu_load: 12,
  load_1: 0.2,
  cpu_temperature: 45,
  cpu_frequency: 1200,
  cpu_voltage: 1.2,
  throttled: 0,
  memory_used: 35,
  swap_used: 10,
  swap_io: 0,
  disk_used: 40,
  boot_used: 30,
  network_rx: 1000,
  network_tx: 500
};

/** Printed by the fake alert engine when it starts: the launcher refuses a server without it. */
export const ALERTS_MARKER = '[e2e] fake alert engine:';

export type Readings = Record<string, number | null>;

/** Writes the whole file through a temp file and a rename, so a poll never reads half of it. */
export function writeReadings(path: string, values: Readings): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(values));
  renameSync(temp, path);
}

/**
 * A missing file means no readings yet ({}). A file that is there but wrong is a harness
 * fault and must fail at its cause, never turn into silent "no readings".
 */
export function readReadings(path: string): Readings {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${READINGS_ENV} ${path}: invalid JSON (${(error as Error).message})`, {
      cause: error
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${READINGS_ENV} ${path}: not an object`);
  }
  for (const [id, value] of Object.entries(parsed)) {
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`${READINGS_ENV} ${path}: ${id} is not a number or null`);
    }
  }
  return parsed as Readings;
}
