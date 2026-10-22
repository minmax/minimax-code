/**
 * The `mcoded` entry point: parse the profile/root arguments, start the daemon
 * on the durable root and wire POSIX signals to the graceful shutdown.
 *
 * This is the skeleton main — the Ф4 product version adds CLI polish and the
 * real runtime injection, but the lifecycle below is the final shape: adopt
 * or bind the socket, serve until SIGTERM/SIGINT, drain, checkpoint, exit.
 *
 * @module
 */

import path from 'node:path';
import process from 'node:process';

import { resolveDurableRoot } from '@mavis/config';

import { MCODED_CHECKPOINT_BASENAME, FileCheckpointStore } from './checkpoint.js';
import { McodedDaemon } from './daemon.js';
import { EchoRuntimeAdapter, type RuntimeAdapter } from './runtime-adapter.js';

export interface McodedMainOptions {
	/** Argument vector; defaults to `process.argv.slice(2)`. */
	readonly argv?: readonly string[];
	/** Environment; defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/** Home directory for durable-root resolution (tests override this). */
	readonly homeDir?: string;
	/** Runtime override — the Ф4 runtime plugs in here; default: echo stub. */
	readonly adapter?: RuntimeAdapter;
	/** Log sink for the readiness/error lines. Default: console. */
	readonly log?: (line: string) => void;
}

/**
 * Parse `--profile <name>` / `--root <path>` from the argument vector.
 * Unknown flags are ignored for now; the Ф4 CLI owns the real surface.
 */
export function parseMcodedArgs(
	argv: readonly string[] = [],
): { profile?: string; root?: string } {
	let profile: string | undefined;
	let root: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === '--profile') {
			profile = argv[index + 1];
			index += 1;
		} else if (flag?.startsWith('--profile=')) {
			profile = flag.slice('--profile='.length);
		} else if (flag === '--root') {
			root = argv[index + 1];
			index += 1;
		} else if (flag?.startsWith('--root=')) {
			root = flag.slice('--root='.length);
		}
	}
	return {
		...(profile !== undefined && profile !== '' ? { profile } : {}),
		...(root !== undefined && root !== '' ? { root } : {}),
	};
}

/**
 * Run the daemon until a termination signal arrives. Resolves (not rejects)
 * after the graceful shutdown completed; embedders that manage their own
 * lifecycle should construct {@link McodedDaemon} directly instead.
 */
export async function mcodedMain(options: McodedMainOptions = {}): Promise<McodedDaemon> {
	const log = options.log ?? ((line: string) => console.log(line));
	const args = parseMcodedArgs(options.argv ?? process.argv.slice(2));
	const root =
		args.root ??
		resolveDurableRoot(args.profile ?? null, options.homeDir ?? process.env['HOME']);

	const daemon = new McodedDaemon({
		root: path.resolve(root),
		adapter: options.adapter ?? new EchoRuntimeAdapter(),
		checkpointFileName: MCODED_CHECKPOINT_BASENAME,
	});

	const shutdown = (): void => {
		void daemon.shutdown().then(() => log(`mcoded: shutdown complete (${daemon.socketPath})`));
	};
	process.once('SIGTERM', shutdown);
	process.once('SIGINT', shutdown);

	await daemon.start();
	log(`mcoded: listening on ${daemon.socketPath}${daemon.isAdopted ? ' (adopted fd)' : ''}`);
	return daemon;
}
