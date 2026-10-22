// Content-addressed blob store with atomic publication.
//
// Blobs live under `<root>/cas/<aa>/<remaining 62 hex digits>`, where `aa` is
// the first pair of the lowercase hex SHA-256 digest. Every publication goes
// through a temporary file in `<root>/tmp` and lands on its final path with an
// exclusive hard link, so a reader only ever observes fully written blobs: an
// interrupted write either never reaches the store or atomically replaces an
// identical blob.
//
// Concurrency: concurrent publications of the same digest are safe. The link
// only commits into a free slot — the loser of the race gets `EEXIST` and
// drops its tmp copy. Because blobs are content-addressed, both racing writers
// produce byte-identical content, so "last writer wins" is unobservable:
// whichever inode survives, reading the digest always yields the same bytes.
//
// Reads verify integrity: every blob is hashed while it is streamed out and a
// mismatch against the digest it is stored under fails the read, so silently
// corrupted, truncated, or substituted files are reported instead of served.
//
// Orphan cleanup: tmp files left behind by killed publishers (e.g. `kill -9`
// between the write and the commit) are swept on `openCas` after a grace
// period that no live publication can cross. Losers of publication races
// remove their tmp file immediately, so the store stays clean under
// contention.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { link, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COPY_CHUNK_SIZE = 1024 * 1024;
/** One base64 decode chunk: 64 KiB of base64 chars -> 48 KiB of decoded bytes. */
const BASE64_CHUNK_CHARS = 4 * 16 * 1024;
/** Tmp files older than this are treated as orphans of crashed publishers. */
const TMP_ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
/** link() codes meaning "this filesystem cannot hard-link"; rename is the fallback. */
const NO_HARDLINK_CODES = new Set(['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'EXDEV']);

/** Result of publishing content into the store. */
export interface PutResult {
  /** Lowercase hex SHA-256 digest of the stored content. */
  sha256: string;
  /** Size of the stored content in bytes. */
  size: number;
}

/** Per-publication options. */
export interface PutOptions {
  /**
   * When `false`, the publication skips the fsync pair (tmp file + shard
   * directory) and is only ordered, not crash-durable. Bulk imports of
   * re-derivable data (e.g. image batches already on disk) save two fsyncs per
   * blob this way. Defaults to the store-wide `durability` (see `openCas`).
   */
  durability?: boolean;
}

/** Per-read options. */
export interface GetOptions {
  /** When set, the read also fails if the blob's size differs. */
  expectedSize?: number;
}

/** Options for {@link openCas}. */
export interface OpenCasOptions {
  /**
   * Default publication durability: fsync the tmp file and the shard directory
   * before a blob is declared published (default `true`).
   */
  durability?: boolean;
}

/** Read/write view over a content-addressed blob store. */
export interface CasStore {
  /** Stores an in-memory buffer and returns its digest and size. */
  putBytes(data: Uint8Array, options?: PutOptions): Promise<PutResult>;
  /** Stores a file's bytes verbatim and returns its digest and size. */
  putFile(sourcePath: string, options?: PutOptions): Promise<PutResult>;
  /**
   * Decodes a base64 payload in aligned chunks — without ever materializing
   * the whole decoded payload — and stores the decoded bytes. Decoding is
   * lenient (it mirrors `Buffer.from(base64, 'base64')`), and the digest
   * covers the decoded bytes.
   */
  putBase64(base64: string, options?: PutOptions): Promise<PutResult>;
  /** Absolute path of the blob for a (validated) digest. */
  pathFor(sha256: string): string;
  /**
   * @legacy Blocking existence probe kept for callers that cannot await.
   * Synchronously stalls the event loop — never use it in a hot path;
   * prefer {@link CasStore.hasAsync}.
   */
  has(sha256: string): boolean;
  /** Existence probe via async `stat`; use this instead of {@link CasStore.has}. */
  hasAsync(sha256: string): Promise<boolean>;
  /**
   * Reads a stored blob, verifying its SHA-256 (and, when given, its size)
   * against what the digest promises; rejects if the blob does not exist or
   * fails verification.
   */
  get(sha256: string, options?: GetOptions): Promise<Buffer>;
  /**
   * Streams a stored blob in chunks without materializing the whole blob, with
   * the same verification as {@link CasStore.get}: the stream errors if the
   * blob is missing or its bytes no longer hash to the digest (checked once
   * the stream is consumed to the end).
   */
  getStream(sha256: string, options?: GetOptions): Readable;
}

/** Lowercases and validates a digest, rejecting traversal-prone input. */
function toDigest(sha256: string): string {
  const digest = sha256.toLowerCase();
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`invalid SHA-256 digest: ${JSON.stringify(sha256)}`);
  }
  return digest;
}

/** Removes a leftover tmp file; failures are irrelevant to store consistency. */
async function discardTmp(tmpPath: string): Promise<void> {
  await unlink(tmpPath).catch(() => {});
}

/**
 * Fsyncs a directory so a just-linked blob survives a crash. Opening
 * directories is unsupported on some platforms (Windows) and directory fsync
 * is a durability refinement, so failures are ignored.
 */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Ignore.
  }
}

class FileCasStore implements CasStore {
  private readonly casDir: string;
  private readonly tmpDir: string;
  private readonly durable: boolean;
  /** Shard directories this instance has already created. */
  private readonly ensuredShards = new Set<string>();

  constructor(rootDir: string, options: OpenCasOptions = {}) {
    this.casDir = path.join(rootDir, 'cas');
    this.tmpDir = path.join(rootDir, 'tmp');
    this.durable = options.durability ?? true;
  }

  async ensureDirectories(): Promise<void> {
    await mkdir(this.casDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
  }

  pathFor(sha256: string): string {
    const digest = toDigest(sha256);
    return path.join(this.casDir, digest.slice(0, 2), digest.slice(2));
  }

  has(sha256: string): boolean {
    // Legacy compat probe. The store itself never calls this — every internal
    // dedup check goes through async stat (`blobExists`), so the per-blob hot
    // path never stalls the event loop.
    return existsSync(this.pathFor(toDigest(sha256)));
  }

  async hasAsync(sha256: string): Promise<boolean> {
    return this.blobExists(toDigest(sha256));
  }

  async get(sha256: string, options?: GetOptions): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.verifiedBlob(sha256, options?.expectedSize)) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  getStream(sha256: string, options?: GetOptions): Readable {
    return Readable.from(this.verifiedBlob(sha256, options?.expectedSize));
  }

  async putBytes(data: Uint8Array, options?: PutOptions): Promise<PutResult> {
    const sha256 = createHash('sha256').update(data).digest('hex');
    // The probe is only a fast path; the commit itself is exclusive (EEXIST),
    // so a publisher that appears between the probe and the commit is still
    // handled safely.
    if (!(await this.blobExists(sha256))) {
      await this.publishViaTmp(
        sha256,
        async (tmpPath, durable) => {
          const handle = await open(tmpPath, 'w');
          try {
            await handle.writeFile(data);
            if (durable) await handle.sync();
          } finally {
            await handle.close();
          }
        },
        options,
        // Already probed above; skips a second stat on the hot path.
        true,
      );
    }
    return { sha256, size: data.byteLength };
  }

  async putFile(sourcePath: string, options?: PutOptions): Promise<PutResult> {
    const durable = options?.durability ?? this.durable;
    // Single pass in the common case: stream the source into a tmp file while
    // hashing it. A pass is torn when the source is rewritten mid-copy — the
    // copied size then disagrees with the fresh stat — and only that case
    // takes a second pass.
    for (let attempt = 1; ; attempt += 1) {
      const snapshot = await stat(sourcePath);
      const copied = await this.copyHashingToTmp(sourcePath, durable);
      // Non-regular sources (fifos, character devices) have no meaningful
      // size: accept end-of-stream as the truth, like a plain copy would.
      if (!snapshot.isFile() || copied.size === snapshot.size) {
        await this.publishPrepared(copied.tmpPath, copied.sha256, durable);
        return { sha256: copied.sha256, size: copied.size };
      }
      // Torn pass: drop the tmp copy and re-read the (possibly changed) source.
      await discardTmp(copied.tmpPath);
      if (attempt >= 2) {
        throw new Error(`source file changed while publishing: ${sourcePath}`);
      }
    }
  }

  async putBase64(base64: string, options?: PutOptions): Promise<PutResult> {
    const durable = options?.durability ?? this.durable;
    const tmpPath = path.join(this.tmpDir, `base64-${randomUUID()}.tmp`);
    const handle = await open(tmpPath, 'w');
    let sha256: string;
    let size = 0;
    try {
      // Stream-decode in 4-char-aligned chunks so only chunk-sized plain
      // buffers are materialized — never the whole decoded payload. The
      // trailing sub-quantum remainder is carried into the next chunk.
      const hash = createHash('sha256');
      let carry = '';
      for (let offset = 0; offset < base64.length; offset += BASE64_CHUNK_CHARS) {
        const piece = carry + base64.slice(offset, offset + BASE64_CHUNK_CHARS);
        const aligned = piece.length - (piece.length % 4);
        carry = piece.slice(aligned);
        const bytes = Buffer.from(piece.slice(0, aligned), 'base64');
        hash.update(bytes);
        size += bytes.length;
        if (bytes.length > 0) await handle.write(bytes);
      }
      const tail = Buffer.from(carry, 'base64');
      hash.update(tail);
      size += tail.length;
      if (tail.length > 0) await handle.write(tail);
      if (durable) await handle.sync();
      sha256 = hash.digest('hex');
    } catch (error) {
      await handle.close();
      await discardTmp(tmpPath);
      throw error;
    }
    await handle.close();
    await this.publishPrepared(tmpPath, sha256, durable);
    return { sha256, size };
  }

  /**
   * Streams a stored blob in chunks while hashing it, so a read never
   * materializes the whole blob and corrupted, truncated, or substituted
   * files fail the read instead of being served.
   */
  private async *verifiedBlob(sha256: string, expectedSize?: number): AsyncGenerator<Buffer> {
    const digest = toDigest(sha256);
    const source = createReadStream(this.pathFor(digest), { highWaterMark: COPY_CHUNK_SIZE });
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(bytes);
        size += bytes.length;
        yield bytes;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error(`blob not found in CAS: ${digest}`, { cause: error });
      }
      throw error;
    }
    const actual = hash.digest('hex');
    if (actual !== digest) {
      throw new Error(
        `blob integrity check failed in CAS: stored ${digest}, read sha256 ${actual} (${size} bytes)`,
      );
    }
    if (expectedSize !== undefined && size !== expectedSize) {
      throw new Error(`blob size mismatch in CAS: ${digest} expected ${expectedSize} bytes, read ${size}`);
    }
  }

  /**
   * Single copy pass: streams the source into a fresh tmp file while hashing,
   * so a cold publication reads the source exactly once. The tmp file is
   * removed on any failure.
   */
  private async copyHashingToTmp(
    sourcePath: string,
    durable: boolean,
  ): Promise<PutResult & { tmpPath: string }> {
    const tmpPath = path.join(this.tmpDir, `incoming-${randomUUID()}.tmp`);
    const hash = createHash('sha256');
    let size = 0;
    const handle = await open(tmpPath, 'w');
    try {
      const source = createReadStream(sourcePath, { highWaterMark: COPY_CHUNK_SIZE });
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(bytes);
        size += bytes.length;
        await handle.write(bytes);
      }
      if (durable) await handle.sync();
    } catch (error) {
      await handle.close();
      await discardTmp(tmpPath);
      throw error;
    }
    await handle.close();
    return { sha256: hash.digest('hex'), size, tmpPath };
  }

  /**
   * Publishes an already-populated tmp file for `sha256`, or drops it on a
   * dedup hit. The existence probe is only a fast path — the commit itself is
   * exclusive, so the tmp file is always cleaned up on every outcome.
   */
  private async publishPrepared(
    tmpPath: string,
    sha256: string,
    durable: boolean,
    assumeMissing = false,
  ): Promise<void> {
    try {
      if (assumeMissing || !(await this.blobExists(sha256))) {
        await this.commit(tmpPath, this.pathFor(sha256), durable);
      }
    } finally {
      await discardTmp(tmpPath);
    }
  }

  /**
   * Publishes a blob for `sha256` by letting `populate` fill a fresh tmp file
   * (which must fsync it when `durable`), then committing it exclusively. On
   * any failure the tmp file is removed and nothing is published.
   */
  private async publishViaTmp(
    sha256: string,
    populate: (tmpPath: string, durable: boolean) => Promise<void>,
    options?: PutOptions,
    assumeMissing = false,
  ): Promise<void> {
    const durable = options?.durability ?? this.durable;
    const tmpPath = path.join(this.tmpDir, `${sha256}-${randomUUID()}.tmp`);
    try {
      await populate(tmpPath, durable);
      await this.publishPrepared(tmpPath, sha256, durable, assumeMissing);
    } catch (error) {
      await discardTmp(tmpPath);
      throw error;
    }
  }

  /**
   * Commits a fully written tmp file onto the final blob path with an
   * exclusive hard link: the link succeeds only into a free slot, and an
   * `EEXIST` loser keeps the existing blob. Content addressing makes the two
   * copies byte-identical, so the "last writer wins" race is unobservable.
   */
  private async commit(tmpPath: string, target: string, durable: boolean): Promise<void> {
    await this.ensureShard(path.dirname(target));
    try {
      await link(tmpPath, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') {
        // Lost the publication race: the destination already holds a blob for
        // this digest with identical bytes.
        return;
      }
      if (code !== undefined && NO_HARDLINK_CODES.has(code)) {
        // Filesystem without hard-link support (e.g. exFAT): rename is still
        // atomic, just not exclusive.
        await this.commitByRename(tmpPath, target);
        return;
      }
      throw error;
    } finally {
      // link() kept the inode alive via the new directory entry; drop our tmp
      // directory entry either way (a no-op when nothing was linked).
      await discardTmp(tmpPath);
    }
    if (durable) await syncDirectory(path.dirname(target));
  }

  /** Rename-based fallback for filesystems without hard-link support. */
  private async commitByRename(tmpPath: string, target: string): Promise<void> {
    try {
      await rename(tmpPath, target);
    } catch (error) {
      // Windows-style rename rejects an existing destination: a lost race
      // whose destination already holds identical bytes.
      if (await this.pathExists(target)) return;
      throw error;
    }
  }

  /**
   * Creates the digest's shard directory once per store instance, so
   * publishing N blobs costs at most one mkdir per shard instead of N
   * recursive mkdirs.
   */
  private async ensureShard(shardDir: string): Promise<void> {
    if (this.ensuredShards.has(shardDir)) return;
    await mkdir(shardDir, { recursive: true });
    this.ensuredShards.add(shardDir);
  }

  private blobExists(digest: string): Promise<boolean> {
    return this.pathExists(this.pathFor(digest));
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await stat(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * Removes tmp files left by publishers that died before their commit (e.g.
   * kill -9). Live publishers only touch entries they created moments ago, so
   * the grace period keeps them safe; anything older cannot belong to a live
   * publication any more.
   */
  async sweepTmpOrphans(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.tmpDir);
    } catch {
      return; // An unreadable tmp dir is not a store-level failure.
    }
    const now = Date.now();
    for (const entry of entries) {
      const tmpPath = path.join(this.tmpDir, entry);
      try {
        const info = await stat(tmpPath);
        if (!info.isFile() || now - info.mtimeMs < TMP_ORPHAN_MIN_AGE_MS) continue;
        await unlink(tmpPath).catch(() => {});
      } catch {
        // Vanished mid-sweep: nothing to do.
      }
    }
  }
}

/**
 * Opens (and creates, if needed) a content-addressed blob store rooted at
 * `rootDir` with the layout `<rootDir>/cas/<aa>/<62 hex>` and a `<rootDir>/tmp`
 * staging directory used for atomic publication. Orphaned tmp files from
 * crashed publishers are swept on open.
 */
export async function openCas(rootDir: string, options: OpenCasOptions = {}): Promise<CasStore> {
  const store = new FileCasStore(path.resolve(rootDir), options);
  // Create the layout eagerly so the first publication never races with
  // directory creation and tmp files always have a home.
  await store.ensureDirectories();
  await store.sweepTmpOrphans();
  return store;
}
