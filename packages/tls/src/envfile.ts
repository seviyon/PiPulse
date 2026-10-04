import { readFileSync } from 'node:fs';

export const ENV_FILE = '/etc/pipulse/pipulse.env';

/**
 * pipulse.env as data, the way systemd's EnvironmentFile and install.sh's
 * env_value read it: KEY=VALUE lines, # and ; comments, one pair of
 * surrounding quotes removed, the last line for a key wins. Nothing is ever
 * expanded or run: the CLI runs as root and never sources this file.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote))
      value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

/**
 * The settings the CLI acts on: the process environment (systemd already
 * loaded pipulse.env into the renew unit; Docker's env_file does the same),
 * falling back to pipulse.env for anything unset (sudo resets the
 * environment of an interactive `sudo pipulse tls …`).
 */
export function settingsEnv(
  env: NodeJS.ProcessEnv,
  options: { file?: string; read?: (path: string) => string } = {}
): NodeJS.ProcessEnv {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseEnvFile(
      (options.read ?? ((path) => readFileSync(path, 'utf8')))(options.file ?? ENV_FILE)
    );
  } catch {
    // Missing, or hidden by the renew unit's sandbox: the environment has it.
  }
  const merged: NodeJS.ProcessEnv = { ...fromFile };
  for (const [key, value] of Object.entries(env)) if (value !== undefined) merged[key] = value;
  return merged;
}
