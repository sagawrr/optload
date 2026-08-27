import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@optload/core': fileURLToPath(
        new URL('../../packages/core/src/index.ts', import.meta.url),
      ),
      '@optload/browser': fileURLToPath(
        new URL('../../packages/browser/src/index.ts', import.meta.url),
      ),
    },
  },
});
