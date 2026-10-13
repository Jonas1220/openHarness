import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// @openharness/core is TypeScript source in the monorepo, so it's bundled
// rather than treated as an external node_modules dependency.
const externalizeDeps = { exclude: ['@openharness/core'] };

export default defineConfig({
  main: {
    build: { externalizeDeps },
  },
  preload: {
    build: { externalizeDeps },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
    plugins: [react()],
  },
});
