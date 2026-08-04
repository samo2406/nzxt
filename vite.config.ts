import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works from https://<user>.github.io/<repo>/
  base: './',
  server: {
    // Spotify rejects the hostname `localhost` as a redirect URI but accepts
    // the loopback IP literal, so dev must be served from 127.0.0.1.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'chrome110',
    assetsInlineLimit: 0,
  },
});
