import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Package-local config so the suite can run before the file is registered in
// test/vitest-suites.json; the repository gate keeps using the root config.
// `@mavis/oauth-lease-protocol` is aliased to its TypeScript source because
// the package export points at the (not built here) `dist` output — the same
// export → source resolution the root config derives from the package exports.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@mavis/oauth-lease-protocol': fileURLToPath(
        new URL('../oauth-lease-protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
