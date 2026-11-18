import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5175,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4175,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-deterministic-compat'],
        },
      },
    },
  },
});
