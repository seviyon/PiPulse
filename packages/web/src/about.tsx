import { useEffect, useState } from 'preact/hooks';
import { getJson } from './api.js';
import { StatusIcon } from './tile.js';
import type { Config } from './types.js';

/** "2027-04-30" → "30 Apr 2027", fixed (not locale-dependent) so it reads the same everywhere. */
function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ][m! - 1];
  return `${d} ${month} ${y}`;
}

/** Which PiPulse and Node this is, and whether that Node still gets security fixes. */
export function AboutSection() {
  const [config, setConfig] = useState<Config | 'loading' | 'error'>('loading');
  useEffect(() => {
    getJson<Config>('/api/config').then(setConfig, () => setConfig('error'));
  }, []);
  return (
    <section aria-labelledby="settings-about">
      <h2 id="settings-about">About</h2>
      {config === 'loading' && <p class="waiting">Loading</p>}
      {config === 'error' && (
        <p class="waiting">Couldn't load the version from the PiPulse server.</p>
      )}
      {typeof config === 'object' && (
        <>
          <p>PiPulse {config.version ?? 'dev'}</p>
          {config.node && (
            <p>
              Node {config.node.version}
              {config.node.supportEnds &&
                !config.node.ended &&
                `, security fixes until ${formatDay(config.node.supportEnds)}`}
            </p>
          )}
          {config.node?.ended && config.node.supportEnds && (
            <p class="alert-severity">
              <StatusIcon level="warning" />
              Node {config.node.line} no longer gets security fixes (since{' '}
              {formatDay(config.node.supportEnds)}).
            </p>
          )}
        </>
      )}
    </section>
  );
}
