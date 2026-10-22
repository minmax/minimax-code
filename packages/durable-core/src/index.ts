/**
 * `@mavis/durable-core` — type-only shared contracts of the durable-core
 * wave. Ships no runtime code; everything is declared in `./contracts.js`.
 *
 * @module
 */

export type {
	Commit,
	DeadLetter,
	DeadLetterAck,
	DeadLetterReason,
	Entry,
	EntryAppendStatus,
	FlushFailureStability,
} from './contracts.js';
