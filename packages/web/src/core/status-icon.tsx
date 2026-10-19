/** A warning triangle or a critical octagon: status is never colour alone (the words come with it). */
export function StatusIcon({ level }: { level: 'warning' | 'critical' }) {
  return level === 'critical' ? (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M4.1 0.5h5.8l3.6 3.6v5.8l-3.6 3.6H4.1L0.5 9.9V4.1z" fill="var(--critical)" />
      <path d="M7 3.5v4" stroke="#fff" stroke-width="1.8" stroke-linecap="round" />
      <circle cx="7" cy="10.2" r="1" fill="#fff" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 0.8l6.4 12H0.6z" fill="var(--warning)" stroke-linejoin="round" />
      <path d="M7 5v3.6" stroke="#17202b" stroke-width="1.6" stroke-linecap="round" />
      <circle cx="7" cy="10.6" r="0.9" fill="#17202b" />
    </svg>
  );
}
