import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ESM-safe __dirname (not available natively in ESM modules).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single vitest project with environment overrides per glob:
//   - Pure-function / store / lib tests (*.test.ts) stay in "node" — fast, no DOM.
//   - Component tests (*.test.tsx) run in "jsdom" — need HTMLElement / layout APIs.
// The React plugin is registered at the top level so JSX transforms work for
// both environments (vitest 1.x doesn't support per-project plugins).
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',           // default; overridden per glob below
    setupFiles: ['src/test-setup.ts'],
    environmentMatchGlobs: [
      // Pin known pure-function test locations to node — fast, no DOM.
      // Only these specific paths, not a catch-all, so any future DOM test
      // written as .test.ts still gets jsdom by default.
      ['src/lib/**/*.test.ts', 'node'],
      ['src/store/**/*.test.ts', 'node'],
    ],
    include: ['src/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../src/shared'),
    },
  },
});
