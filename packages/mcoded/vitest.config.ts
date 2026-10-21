import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Package-local config so the suite can run before the file is registered in
// test/vitest-suites.json; the repository gate keeps using the root config.
//
// The published `@mavis/*` exports point at built `dist` output, which a
// source checkout does not have, so workspace specifiers are aliased to the
// TypeScript sources exactly the way the root `vitest.config.ts` derives its
// aliases from `scripts/lib/package-exports.mjs`. Listed here: this package's
// direct dependency (`@mavis/config`) plus the `@mavis/shared` entries its
// sources import.
const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceSources: ReadonlyArray<readonly [specifier: string, file: string]> = [
	['@mavis/config', '../config/src/index.ts'],
	['@mavis/shared', '../shared/src/index.ts'],
	['@mavis/shared/source-provenance', '../shared/src/source-provenance.ts'],
	['@mavis/shared/runtime-boundary-env', '../shared/src/runtime-boundary-env.ts'],
];
const alias = workspaceSources.map(([specifier, file]) => ({
	find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
	replacement: path.join(packageRoot, file),
}));

export default defineConfig({
	root: packageRoot,
	resolve: { alias },
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
	},
});
