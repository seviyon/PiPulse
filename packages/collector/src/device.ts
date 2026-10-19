import { closeSync, openSync, readSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import si from 'systeminformation';

/** Static facts about the machine, for the dashboard header (served via /api/config). */
export interface DeviceInfo {
  hostname: string;
  platform: string;
  arch: string;
  model: string;
  os: string;
  kernel: string;
  memoryTotalMb: number;
  /** Logical CPUs; a load average above this means work is queueing. */
  cpus: number;
}

/** The first 4 KB of a small text file, or undefined: the files read here are a line or two. */
function readText(path: string): string | undefined {
  try {
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      return buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * The host's OS name and Pi model, read under `hostRoot` (a container mounts
 * the host's /etc/os-release and /proc/device-tree/model there). Missing
 * files are left out, so the usual sources apply.
 */
export function hostOverrides(hostRoot: string): { os?: string; model?: string } {
  const result: { os?: string; model?: string } = {};
  const osRelease = readText(join(hostRoot, 'etc/os-release'));
  const pretty = osRelease?.match(/^PRETTY_NAME="?([^"\n]*)"?$/m)?.[1];
  if (pretty) result.os = pretty;
  const model = readText(join(hostRoot, 'model'))?.replace(/\0/g, '').trim();
  if (model) result.model = model;
  return result;
}
/** Device facts; with `hostRoot`, the OS name and model come from the host's files under it. */
export async function readDeviceInfo(options: { hostRoot?: string } = {}): Promise<DeviceInfo> {
  const [system, osInfo, mem] = await Promise.all([si.system(), si.osInfo(), si.mem()]);
  const release = [osInfo.release, osInfo.codename && `(${osInfo.codename})`].filter(Boolean);
  const info: DeviceInfo = {
    hostname: osInfo.hostname,
    platform: osInfo.platform,
    arch: osInfo.arch,
    model: system.model,
    os: [osInfo.distro, ...release].join(' '),
    kernel: osInfo.kernel,
    memoryTotalMb: Math.round((mem.total / 2 ** 20) * 100) / 100,
    cpus: os.cpus().length
  };
  return { ...info, ...(options.hostRoot ? hostOverrides(options.hostRoot) : {}) };
}
