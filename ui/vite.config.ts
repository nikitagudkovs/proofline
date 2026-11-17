import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The built UI is served by `proofline ui` from dist/ui. File names are fixed (no hashes)
// so the same bundle can also be published as a static, recorded demo.
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/app[extname]',
      },
    },
  },
});
