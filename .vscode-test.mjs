import { defineConfig } from '@vscode/test-cli';

// Integration tests run in a real VS Code Extension Development Host.
// Compile them first with `npm run compile:test` (tsconfig.test.json) — this
// config loads the emitted JS. The sample workspace gives the host a non-empty
// `workspace.workspaceFolders` so activation behaves like a real session.
export default defineConfig({
  label: 'integration',
  files: 'out/integration/**/*.test.js',
  version: 'stable',
  workspaceFolder: './sample-workspace',
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
