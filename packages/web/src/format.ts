export interface FormattedValue {
  text: string;
  unit: string;
}

/** Rounds to `decimals` places, dropping a trailing ".0" so whole numbers read cleanly. */
function round(value: number, decimals: number): string {
  return String(Number(value.toFixed(decimals)));
}

/**
 * Turns a raw reading into display text, scaling byte-based units up so a
 * value never shows more digits than a glance can take in.
 */
export function formatValue(value: number, unit: string): FormattedValue {
  switch (unit) {
    case '%':
    case '°C':
      return { text: round(value, 1), unit };
    case 'MB':
      return value >= 1024
        ? { text: round(value / 1024, 1), unit: 'GB' }
        : { text: round(value, 0), unit };
    case 'MHz':
      return { text: round(value, 0), unit };
    case 'flags':
      // vcgencmd's throttle bitmask: low bits are happening now, bits 16+ since boot.
      if ((value & 0xf) !== 0) return { text: 'Now', unit: '' };
      if (value !== 0) return { text: 'Since boot', unit: '' };
      return { text: 'None', unit: '' };
    case 'B/s':
      if (value >= 1_000_000) return { text: round(value / 1_000_000, 1), unit: 'MB/s' };
      if (value >= 1000) return { text: round(value / 1000, 1), unit: 'kB/s' };
      return { text: round(value, 0), unit };
    default:
      return { text: round(value, 2), unit };
  }
}

/** "just now", "12 s ago", "3 min ago", "2 h ago". */
export function formatAge(ms: number): string {
  if (ms < 2000) return 'just now';
  // Round once, then pick the unit from the rounded value, so 59.6 s reads
  // "1 min ago" rather than "60 s ago".
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** "5 min", "3 h 12 min", "16 days 11 h". */
export function formatUptime(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days} ${days === 1 ? 'day' : 'days'} ${hours % 24} h`;
  if (hours > 0) return `${hours} h ${minutes % 60} min`;
  return `${minutes} min`;
}
