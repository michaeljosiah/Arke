import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser build shows this in Settings › About; the desktop shell overrides it with the real app
// version via the preload bridge. Read from package.json at config time so it stays in one place.
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  plugins: [react()],
  define: { __ARKE_VERSION__: JSON.stringify(version) },
  // Relative base (SPEC-022) so the built assets load under BOTH `http://localhost` (browser dev/preview)
  // and the desktop `app://` protocol handler, where absolute `/assets/*` would not resolve. The client
  // is store-routed (no URL routes), so index.html is always at the root — relative paths are safe.
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
