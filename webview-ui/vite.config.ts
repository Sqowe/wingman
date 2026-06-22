import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ESM-safe __dirname (not available natively in ESM modules).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      // Allows both the host and the webview to import from the same
      // shared type file: import type { HostMessage } from '@shared/messages'
      '@shared': path.resolve(__dirname, '../src/shared'),
    },
  },

  build: {
    // Output into the extension's dist/ so the provider can load it via asWebviewUri.
    outDir: path.resolve(__dirname, '../dist/webview'),
    emptyOutDir: true,

    rollupOptions: {
      output: {
        // Fixed filenames — the VS Code provider references these directly
        // without reading a manifest. No content-hash needed for a webview.
        entryFileNames: 'assets/main.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) return 'assets/main.css';
          return 'assets/[name][extname]';
        },
      },
    },
  },
});
