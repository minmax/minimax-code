import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Local test config for `pnpm --filter @mavis/wire-compiler test`. The
// repository-wide suites are declared in `test/vitest-suites.json`; this file
// only exists so the package can be exercised standalone during development.
// `@mavis/cas/cas-ref` (the single-source `cas://` reference format, imported
// by the dialect) is aliased to its TypeScript source because the cas package
// export points at the (not built here) `dist` output — the same
// export → source resolution the root config derives from the package exports.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@mavis/cas/cas-ref': fileURLToPath(new URL('../cas/src/cas-ref.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
  },
});
