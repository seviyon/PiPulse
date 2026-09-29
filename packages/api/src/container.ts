/** Shown on a tile whose reading a container can't make. */
export const CONTAINER_UNAVAILABLE = 'Not available in Docker';

/** Plugins that need the Pi firmware (vcgencmd, /dev/vchiq), absent from the image. */
export const FIRMWARE_PLUGINS: ReadonlySet<string> = new Set(['cpu_voltage', 'throttled']);

/** In a container, the firmware plugins aren't scheduled at all. */
export function splitForContainer<P extends { id: string }>(
  plugins: P[],
  inContainer: boolean
): { run: P[]; unavailable: Set<string> } {
  if (!inContainer) return { run: plugins, unavailable: new Set() };
  return {
    run: plugins.filter((p) => !FIRMWARE_PLUGINS.has(p.id)),
    unavailable: new Set(plugins.filter((p) => FIRMWARE_PLUGINS.has(p.id)).map((p) => p.id))
  };
}
