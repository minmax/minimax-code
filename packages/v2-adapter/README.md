# @mavis/v2-adapter

Read-only streaming reader for legacy mcode v2 session directories
(`messages.jsonl` canonical history; see `hybrid-plans/facts/facts-mcode.md`
section 5.2). The adapter never writes to the source session and never holds
the whole history in memory: files are streamed one line at a time, so the
100 MB picture-heavy sessions with multi-megabyte base64 lines import with
memory bounded by the largest single line.

## API

```ts
import { openV2Session } from '@mavis/v2-adapter';

const reader = openV2Session(sessionDir); // resolves <sessionDir>/messages.jsonl

// Stream envelopes in file order (async callbacks apply backpressure).
await reader.readEnvelopes((envelope) => { ... });

// File size in bytes and the number of non-empty history lines.
await reader.stats(); // => { bytes, lines }

// Import into a new-generation sink, externalizing inline images to a CAS.
const stats = await reader.importTo(
  { putEntry: async (envelope) => { ... } },
  {
    onImage: async (base64) => {
      // CAS integration point: decode with Buffer.from(base64, 'base64'),
      // store via CAS.putImage, return the blob descriptor.
      return 'sha256:...';
    },
  },
);
```

An `image` content block whose hook returns a descriptor is imported as
`{ type: 'image_ref', blob: <descriptor> }`; `undefined` keeps the block
inline. `ImportStats` reports `bytes`, `lines`, `envelopes`, `imageBlocks`,
`imagesMigrated`, and `imagesInline`.

Envelope lines are validated against the canonical shape (exact key set
`message_id`/`turn_id`/`message`/`turn_config`/`history_artifact`, message_id
matching `msg-.+` or digits); violations throw `V2SessionFormatError` naming
the file and line number, and JSON parse failures never leak the line payload
into the diagnostic. `turn_config` and `history_artifact` pass through as
opaque records.

## Repository registration (one-time, outside this package)

The package is self-contained but not yet wired into the distribution
gates. Registering it requires the standard steps from `src/AGENTS.md`:
add `packages/v2-adapter` to `pnpm-workspace.yaml` and `packageRoots` in
`release/extraction.json`, run `pnpm gen:tsconfig`, regenerate
`release/public-source.json` via `node scripts/source-inventory.mjs --write`,
and add `packages/v2-adapter/test/unit/*.test.ts` to a group in
`test/vitest-suites.json`. Until then, verify locally with:

- `src/node_modules/.bin/vitest run` from `src/packages/v2-adapter`
- `src/node_modules/.bin/tsc -p src/packages/v2-adapter/tsconfig.json`
  from `src/`
