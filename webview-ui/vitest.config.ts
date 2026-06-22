import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ESM-safe __dirname (not available natively in ESM modules).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Standalone test config (vitest prefers vitest.config.* over vite.config.*).
// The store reducer is pure state logic, so a `node` environment is enough —
// no jsdom. The `@shared` alias mirrors vite.config.ts so tests can resolve the
// same shared types the app does.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../src/shared'),
    },
  },
});
