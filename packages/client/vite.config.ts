import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base (SPEC-022) so the built assets load under BOTH `http://localhost` (browser dev/preview)
  // and the desktop `app://` protocol handler, where absolute `/assets/*` would not resolve. The client
  // is store-routed (no URL routes), so index.html is always at the root — relative paths are safe.
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
