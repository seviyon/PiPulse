/** Wire types for the PiPulse API (mirrors packages/api; kept local so the browser bundle never imports server code). */
export interface Sample {
  ts: number;
  metric: string;
  value: number;
}

export interface PluginInfo {
  id: string;
  label: string;
  unit: string;
  intervalMs: number;
}

export interface DeviceInfo {
  hostname: string;
  platform: string;
  arch: string;
  model?: string;
  os?: string;
  kernel?: string;
  memoryTotalMb?: number;
}

export interface Config {
  device: DeviceInfo;
  plugins: PluginInfo[];
  /** The server's clock (unix ms) when it answered; absent from older servers. */
  serverTime?: number;
  /** Time since the Pi booted, in ms, when the server answered. */
  uptimeMs?: number;
}

export type LiveMessage = { type: 'snapshot'; samples: Sample[] } | ({ type: 'sample' } & Sample);
