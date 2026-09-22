import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

/** Where `npm run dev` forwards /api (REST and the /api/live WebSocket). */
const apiTarget = process.env['PIPULSE_API'] ?? 'http://localhost:8888';

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    // Host is left unchanged (no changeOrigin), so the dev page's Origin still
    // matches the Host header and passes the server's /api/live origin check.
    proxy: { '/api': { target: apiTarget, ws: true } }
  }
});
