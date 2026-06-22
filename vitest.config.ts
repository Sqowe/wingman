import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Mock the vscode module for unit tests
      vscode: path.resolve(__dirname, 'src/__mocks__/vscode.ts'),
    },
  },
});
