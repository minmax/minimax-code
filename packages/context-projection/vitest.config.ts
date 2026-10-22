import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Package-local config so the suite can run before the file is registered in
// test/vitest-suites.json; the repository gate keeps using the root config.
// No @mavis/* aliases are needed: the package imports the backend contract
// straight from the workspace-relative source file (see src/projection.ts).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
  },
});
