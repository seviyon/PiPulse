import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

/** Where `npm run dev` forwards /api (REST and the /api/live WebSocket). */
const apiTarget = process.env['PIPULSE_API'] ?? 'http://localhost:8889';

const webVersion = process.env['PIPULSE_WEB_VERSION'] ?? 'dev';

export default defineConfig({
  plugins: [
    preact(),
    {
      // dist/web-version.txt: which dashboard a server is shipping, readable with curl; the
      // release builder checks it against the version it is packing.
      name: 'pipulse-web-version',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'web-version.txt', source: `${webVersion}\n` });
      }
    }
  ],
  // The release builds with PIPULSE_WEB_VERSION set, so the page knows which dashboard it is
  // (src/build.ts); without it (npm run dev, tests) it says `dev`.
  define: { __PIPULSE_WEB_VERSION__: JSON.stringify(webVersion) },
  server: {
    port: 5173,
    // Host is left unchanged (no changeOrigin), so the dev page's Origin still
    // matches the Host header and passes the server's /api/live origin check.
    proxy: { '/api': { target: apiTarget, ws: true } }
  }
});
