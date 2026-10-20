// Content-addressed blob store with atomic publication.
//
// Blobs live under `<root>/cas/<aa>/<remaining 62 hex digits>`, where `aa` is
// the first pair of the lowercase hex SHA-256 digest. Every publication goes
// through a temporary file in `<root>/tmp` that is fsynced and then renamed
// onto its final path, so a reader only ever observes fully written blobs: an
// interrupted write either never reaches the store or atomically replaces an
// identical blob. Content is deduplicated — if the digest already exists in
// the store, nothing is written.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COPY_CHUNK_SIZE = 1024 * 1024;

/** Result of publishing content into the store. */
export interface PutResult {
  /** Lowercase hex SHA-256 digest of the stored content. */
  sha256: string;
  /** Size of the stored content in bytes. */
  size: number;
}

/** Read/write view over a content-addressed blob store. */
export interface CasStore {
  /** Stores an in-memory buffer and returns its digest and size. */
  putBytes(data: Buffer): Promise<PutResult>;
  /** Stores a file's bytes verbatim and returns its digest and size. */
  putFile(sourcePath: string): Promise<PutResult>;
  /**
   * Stores an image file without decoding or re-encoding it: the original
   * bytes on disk are stored exactly as they are.
   */
  putImage(sourcePath: string): Promise<PutResult>;
  /** Absolute path of the blob for a (validated) digest. */
  pathFor(sha256: string): string;
  /** Whether the blob with this digest exists in the store. */
  has(sha256: string): boolean;
  /** Reads a stored blob; rejects if it does not exist. */
  get(sha256: string): Promise<Buffer>;
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
 * Fsyncs a directory so a just-renamed blob survives a crash. Opening
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

/** Streams a file through SHA-256 without storing anything. */
async function hashFile(filePath: string): Promise<PutResult> {
  const hash = createHash('sha256');
  let size = 0;
  const source = createReadStream(filePath, { highWaterMark: COPY_CHUNK_SIZE });
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    hash.update(bytes);
    size += bytes.length;
  }
  return { sha256: hash.digest('hex'), size };
}

class FileCasStore implements CasStore {
  private readonly casDir: string;
  private readonly tmpDir: string;

  constructor(rootDir: string) {
    this.casDir = path.join(rootDir, 'cas');
    this.tmpDir = path.join(rootDir, 'tmp');
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
    return existsSync(this.pathFor(sha256));
  }

  async get(sha256: string): Promise<Buffer> {
    const target = this.pathFor(sha256);
    try {
      return await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error(`blob not found in CAS: ${toDigest(sha256)}`, { cause: error });
      }
      throw error;
    }
  }

  async putBytes(data: Buffer): Promise<PutResult> {
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (!this.has(sha256)) {
      await this.publishViaTmp(sha256, async (tmpPath) => {
        const handle = await open(tmpPath, 'w');
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
      });
    }
    return { sha256, size: data.length };
  }

  async putFile(sourcePath: string): Promise<PutResult> {
    // Pass 1 hashes the source without writing anything, so a dedup hit costs
    // no publication at all.
    const hashed = await hashFile(sourcePath);
    if (!this.has(hashed.sha256)) {
      await this.publishViaTmp(hashed.sha256, async (tmpPath) => {
        // Pass 2 copies the source into the tmp file, re-hashing on the way
        // to detect a source that changed between the two passes.
        const hash = createHash('sha256');
        let size = 0;
        const handle = await open(tmpPath, 'w');
        try {
          const source = createReadStream(sourcePath, { highWaterMark: COPY_CHUNK_SIZE });
          for await (const chunk of source) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
            hash.update(bytes);
            size += bytes.length;
            await handle.write(bytes);
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (hash.digest('hex') !== hashed.sha256 || size !== hashed.size) {
          throw new Error(`source file changed while publishing: ${sourcePath}`);
        }
      });
    }
    return hashed;
  }

  putImage(sourcePath: string): Promise<PutResult> {
    // Images are ingested verbatim: no decoding or re-encoding happens, the
    // stored blob is byte-for-byte the file on disk.
    return this.putFile(sourcePath);
  }

  /**
   * Publishes a blob for `sha256` by letting `populate` fill a fresh tmp file
   * (which must fsync it), then renaming that file onto the final path. On
   * any failure the tmp file is removed and nothing is published.
   */
  private async publishViaTmp(
    sha256: string,
    populate: (tmpPath: string) => Promise<void>,
  ): Promise<void> {
    const target = this.pathFor(sha256);
    const tmpPath = path.join(this.tmpDir, `${sha256}-${randomUUID()}.tmp`);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await populate(tmpPath);
      await this.commit(tmpPath, target);
    } catch (error) {
      await discardTmp(tmpPath);
      throw error;
    }
  }

  /** Renames a fully written tmp file onto the final blob path. */
  private async commit(tmpPath: string, target: string): Promise<void> {
    try {
      await rename(tmpPath, target);
    } catch (error) {
      // rename() fails when the destination already exists on Windows. Blobs
      // are immutable and content-addressed, so an existing destination always
      // holds identical content; treat the lost race as a dedup hit.
      if (existsSync(target)) {
        return;
      }
      throw error;
    }
    await syncDirectory(path.dirname(target));
  }
}

/**
 * Opens (and creates, if needed) a content-addressed blob store rooted at
 * `rootDir` with the layout `<rootDir>/cas/<aa>/<62 hex>` and a `<rootDir>/tmp`
 * staging directory used for atomic publication.
 */
export async function openCas(rootDir: string): Promise<CasStore> {
  const store = new FileCasStore(path.resolve(rootDir));
  // Create the layout eagerly so the first publication never races with
  // directory creation and tmp files always have a home.
  await store.ensureDirectories();
  return store;
}
