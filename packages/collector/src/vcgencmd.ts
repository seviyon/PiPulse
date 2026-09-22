import { execFile } from 'node:child_process';
import type { CollectorPlugin } from './index.js';

/** vcgencmd answers in milliseconds; a hung firmware call must not stall the scheduler slot forever. */
const TIMEOUT_MS = 2000;

/**
 * vcgencmd is installed but can't reach the firmware: the service user isn't
 * in the `video` group, or a container wasn't given /dev/vchiq. Unlike a
 * timeout, retrying won't help until someone fixes the setup.
 */
const UNUSABLE_STDERR = /vchiq|VCHI|permission denied/i;

class VcgencmdUnusableError extends Error {}

/**
 * Runs `vcgencmd <args>` (no shell) and resolves its stdout, or `null` when
 * vcgencmd isn't installed, i.e. this isn't a Raspberry Pi. Rejects with
 * VcgencmdUnusableError when it can't reach the firmware, and with the raw
 * error for anything else (timeouts), so the scheduler reports it.
 */
function vcgencmd(args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile('vcgencmd', args, { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') resolve(null);
      else if (error && (code === 'EACCES' || UNUSABLE_STDERR.test(String(stderr)))) {
        const detail = String(stderr).trim() || error.message;
        reject(
          new VcgencmdUnusableError(
            `vcgencmd can't reach the firmware (${detail}). Add the PiPulse service user to ` +
              'the "video" group, or pass /dev/vchiq into the container, then restart PiPulse.'
          )
        );
      } else if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

/**
 * A vcgencmd runner for one plugin that reports an unusable vcgencmd once,
 * with the fix, and then resolves `null` (tile shows "no readings") instead
 * of logging the same failure on every poll for as long as the server runs.
 */
function vcgencmdReportingOnce(): (args: string[]) => Promise<string | null> {
  let reported = false;
  return async (args) => {
    try {
      return await vcgencmd(args);
    } catch (error) {
      if (!(error instanceof VcgencmdUnusableError)) throw error;
      if (reported) return null;
      reported = true;
      throw error;
    }
  };
}

/** Pulls the first capture group out of vcgencmd's `key=value` output. */
function parse(output: string, pattern: RegExp): string {
  const match = pattern.exec(output);
  if (!match?.[1]) throw new Error(`unexpected vcgencmd output: ${output.trim()}`);
  return match[1];
}

const measureVolts = vcgencmdReportingOnce();

export const cpuVoltagePlugin: CollectorPlugin = {
  id: 'cpu_voltage',
  label: 'Core voltage',
  unit: 'V',
  intervalMs: 30000,
  apiVersion: 1,
  async collect() {
    const output = await measureVolts(['measure_volts']);
    return output === null ? null : Number(parse(output, /volt=([\d.]+)V/));
  }
};

/**
 * The firmware's throttle bitmask (`vcgencmd get_throttled`). Bits 0–3 are
 * conditions happening now (under-voltage, frequency capped, throttled,
 * soft temperature limit); bits 16–19 are the same since boot. Stored raw;
 * the dashboard decodes it.
 */
const getThrottled = vcgencmdReportingOnce();

export const throttledPlugin: CollectorPlugin = {
  id: 'throttled',
  label: 'Throttling',
  unit: 'flags',
  intervalMs: 10000,
  apiVersion: 1,
  async collect() {
    const output = await getThrottled(['get_throttled']);
    return output === null ? null : Number.parseInt(parse(output, /throttled=(0x[\da-f]+)/i), 16);
  }
};
