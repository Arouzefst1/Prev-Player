import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Tauri uses a fixed port; strictPort ensures Vite fails fast if it's taken.
  server: {
    port: 3001,
    host: '0.0.0.0',
    strictPort: true,
    // Don't open a browser tab — Tauri opens its own window.
    open: false,
    watch: {
      // Don't watch the Rust source tree; cargo handles that.
      ignored: ['**/src-tauri/**'],
    },
  },
  // Tauri expects ES modules and a modern target.
  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
