import { openDb } from '@pipulse/storage';
import { builtinPlugins, runOnce } from '@pipulse/collector';
import { buildServer } from './index.js';

const DB_PATH = process.env['PIPULSE_DB_PATH'] ?? 'pipulse.sqlite';
const PORT = Number(process.env['PIPULSE_PORT'] ?? 8888);
const COLLECT_INTERVAL_MS = 5000;

const db = openDb(DB_PATH);
const app = buildServer(db);

setInterval(() => {
  void runOnce(db, builtinPlugins, (plugin, error) => {
    app.log?.warn?.(`plugin ${plugin.id} failed: ${String(error)}`);
  });
}, COLLECT_INTERVAL_MS);

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => {
    console.log(`PiPulse API listening on http://0.0.0.0:${PORT}`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
