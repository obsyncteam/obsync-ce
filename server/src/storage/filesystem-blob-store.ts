import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type {
  BlobFileWriteInput,
  BlobReadRange,
  BlobReadStreamResult,
  BlobStore,
} from "./blob-store.js";

export class FilesystemBlobStore implements BlobStore {
  readonly kind = "filesystem" as const;

  constructor(private readonly rootDir: string) {}

  async putFile(input: BlobFileWriteInput): Promise<void> {
    const path = this.resolveKey(input.key);
    await mkdir(dirname(path), { recursive: true });

    try {
      await rename(input.filePath, path);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EXDEV") {
        throw error;
      }

      await copyFile(input.filePath, path);
      await unlink(input.filePath);
    }
  }

  async getStream(
    key: string,
    range?: BlobReadRange,
  ): Promise<BlobReadStreamResult | undefined> {
    const path = this.resolveKey(key);
    try {
      const info = await stat(path);
      const streamOptions = range
        ? { start: range.start, end: range.end }
        : undefined;
      return {
        body: createReadStream(path, streamOptions),
        contentLength: range ? range.end - range.start + 1 : info.size,
        totalSize: info.size,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }

  private resolveKey(key: string): string {
    const normalized = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
    return join(this.rootDir, normalized);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
