/**
 * Default image externalization for the v2 import: inline base64 `image`
 * blocks are stored in the CAS and replaced with `image_ref` blocks, so image
 * bytes never live in the history log ("images never in the history, from the
 * first commit").
 *
 * The default CAS location is the DURABLE data root (`~/.mcode-durable/cas`,
 * resolved through `@mavis/config`'s `resolveDurableRoot` + `resolveCasDirPath`
 * and guarded by `assertNoLegacyWrite`) — never the legacy `~/.minimax` tree,
 * which the durable runtime only reads.
 *
 * The CAS store is structural (`CasStoreLike`) and resolved lazily: a store
 * instance may be handed in directly, a directory path opens the real
 * `@mavis/cas` store on first use, and the default (`undefined`) opens the
 * store under the durable root. When neither the CAS package nor the config
 * package is resolvable in the current runtime, the default degrades to "keep
 * inline" — import stays correct, only the externalization is skipped.
 *
 * @module
 */

import os from 'node:os';
import { join } from 'node:path';

import type { V2ImageHook } from './session-reader.js';

/** Structural surface of the CAS store the image hook needs. */
export interface CasStoreLike {
	putBytes(data: Uint8Array): Promise<{ readonly sha256: string; readonly size: number }>;
}

/**
 * Fallback durable CAS location, kept as a literal so the default can never
 * drift back into the legacy `~/.minimax` tree (the write-forbidden legacy
 * family is `~/.minimax[-<profile>]`; this sibling root is what the durable
 * runtime owns — see `@mavis/config` `durable-paths.ts`).
 */
export const DEFAULT_CAS_ROOT = join(os.homedir(), '.mcode-durable', 'cas');

/** Explicit import option: a store, a CAS root directory, or `null` to keep images inline. */
export type CasImageOption = CasStoreLike | string | null;

/**
 * Builds the image hook: decodes the base64 block, stores the original bytes
 * in the CAS, and returns the canonical `cas://` reference. Store failures
 * degrade to `undefined` (the block stays inline) instead of failing the
 * import — the history stays importable, matching the optional-hook contract.
 */
export function createCasImageHook(store: CasStoreLike): V2ImageHook {
	return async (base64: string): Promise<string | undefined> => {
		try {
			const bytes = Buffer.from(base64, 'base64');
			const { sha256, size } = await store.putBytes(bytes);
			return `cas://sha256/${sha256}#${size}`;
		} catch {
			return undefined;
		}
	};
}

/**
 * Resolves the durable CAS root for the default profile. A literal, by design:
 * the durable root layout (`~/.mcode-durable`, profile suffixes for non-default
 * profiles) is pinned by `@mavis/config`'s `durable-paths.ts`, and this adapter
 * must never fall back into the legacy `~/.minimax` family regardless of which
 * packages the runtime resolved. Profile-aware callers hand an explicit root
 * (`cas` option) instead of relying on the default.
 */
export function resolveDefaultCasRoot(): string {
	return join(os.homedir(), '.mcode-durable', 'cas');
}

/**
 * Resolves the effective image hook for an import. `undefined` means "no
 * externalization" (keep inline): either the caller disabled it with `null`,
 * or the default was requested but the CAS package is not resolvable here.
 */
export async function resolveImageHook(option: CasImageOption | undefined): Promise<V2ImageHook | undefined> {
	if (option === null) return undefined;
	if (option !== undefined && typeof option !== 'string') return createCasImageHook(option);
	const root = resolveDefaultCasRoot();
	try {
		// Lazy and structural: only resolve the real CAS package when a store
		// was not handed in directly.
		const casModule = (await import('@mavis/cas')) as { openCas: (root: string) => Promise<CasStoreLike> };
		const store = await casModule.openCas(root);
		return createCasImageHook(store);
	} catch {
		return undefined;
	}
}
