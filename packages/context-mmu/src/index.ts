// Context MMU: resident/digest paging of CAS-backed pages.
//
// Runtime dependency-free: the `CasStore` is injected and only referenced
// through its wave-1 contract via a type-only import.

export { createMMU, formatPageDigest } from './mmu.js';
export { PathWatcher } from './watch.js';
export type { PathWatcherOptions } from './watch.js';
export type { PageDigestInfo } from './digest.js';
export type {
  AdmitResult,
  CasStore,
  ContextMmu,
  MmuOptions,
  MmuStats,
  PageFileMeta,
  PageHandle,
  PageRef,
  PageStatus,
  Pages,
} from './types.js';
