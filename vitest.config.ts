import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readExtraction } from "./scripts/lib/release-metadata.mjs";
import { packageExportEntries } from "./scripts/lib/package-exports.mjs";

// Default auto-discovered config for ad-hoc `vitest run <paths>` invocations:
// it resolves the workspace's `@mavis/*` package specifiers to their TypeScript
// sources (the published `exports` point at built `dist`, which source checkouts
// do not have). The registered-suite gates use vitest.oss.config.mjs, which
// derives the same aliases plus the suite file list.
const root = fileURLToPath(new URL(".", import.meta.url));
const { packageRoots } = readExtraction(root);
const alias = packageExportEntries(root, packageRoots).map(
  ({ specifier, file }) => ({
    find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    replacement: path.join(root, file),
  }),
);

export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
  },
});
