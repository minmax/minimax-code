import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Package-local config so the suite can run before the file is registered in
// test/vitest-suites.json; the repository gate keeps using the root config.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
  },
});
