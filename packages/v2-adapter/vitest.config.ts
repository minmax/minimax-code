import { defineConfig } from 'vitest/config';

// Package-local Vitest config so `../../../node_modules/.bin/vitest run` works
// from this directory before the package is registered in
// `test/vitest-suites.json` (the root `vitest.oss.config.mjs` runs registered
// files only and needs no aliases here: tests import the package relatively).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
