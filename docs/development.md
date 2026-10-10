# Development

Building, testing and running PiPulse from a checkout. Requirements and variables are in [Configuration](configuration.md).

Requires **Node.js >=22.13.0** (for built-in `node:sqlite` support with no experimental flag).

```bash
git clone https://github.com/<your-username>/PiPulse.git
cd PiPulse
npm install
npm run build     # storage -> collector -> alerts -> api -> web, in dependency order
npm test          # builds, then runs the Vitest suites across all packages
npm run dev       # runs the server (collector + API) in watch mode
```

The end-to-end tests (Playwright, Chromium only) live in the standalone `e2e/` folder and drive the real built server with fake plugins. Install their dependencies and the browser once, then run them (this builds first):

```bash
npm ci --prefix e2e
npx --prefix e2e playwright install chromium   # add --with-deps on Linux
npm run test:e2e
```

To run the server (collector + dashboard + REST API + WebSocket feed) from a build, then open `http://<host>:8889/` (an installed PiPulse reads the same variables from `/etc/pipulse/pipulse.env`):

```bash
PIPULSE_DB_PATH=~/pipulse-data/pipulse.sqlite PIPULSE_PORT=8889 \
  node --disable-warning=ExperimentalWarning packages/api/dist/server.js
```

To run only the collector daemon, without the API (writes to `PIPULSE_DB_PATH`, default `./pipulse.sqlite`; stop with Ctrl-C):

```bash
PIPULSE_DB_PATH=~/pipulse-data/pipulse.sqlite npm run start --workspace=packages/collector
```

> For dashboard development, run the server (`npm run dev`) and, in a second terminal, `npm run dev --workspace=packages/web`. Vite serves the dashboard on port 5173 and proxies `/api` and the WebSocket to the server (`PIPULSE_API`, default `http://localhost:8889`).
