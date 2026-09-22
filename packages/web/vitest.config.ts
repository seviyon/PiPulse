import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'happy-dom',
    environmentOptions: { happyDOM: { url: 'http://io.lan:8889/' } }
  }
});
