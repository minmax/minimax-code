import { defineConfig } from 'vitest/config';

// Local test config for `pnpm --filter @mavis/storage-worker test`. The
// repository-wide suites are declared in `test/vitest-suites.json`; this file
// only exists so the package can be exercised standalone during development.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
