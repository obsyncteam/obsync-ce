import type { Readable } from "node:stream";

export interface BlobWriteInput {
  key: string;
  body: Buffer;
  contentType?: string;
}

export interface BlobFileWriteInput {
  key: string;
  filePath: string;
  contentType?: string;
}

export interface BlobReadResult {
  body: Buffer;
  contentType?: string;
}

export interface BlobReadStreamResult {
  body: Readable;
  contentType?: string;
  contentLength?: number;
  totalSize?: number;
}

export interface BlobReadRange {
  start: number;
  end: number;
}

export interface BlobStore {
  readonly kind: "filesystem" | "s3";
  put(input: BlobWriteInput): Promise<void>;
  putFile(input: BlobFileWriteInput): Promise<void>;
  get(key: string): Promise<BlobReadResult | undefined>;
  getStream(key: string, range?: BlobReadRange): Promise<BlobReadStreamResult | undefined>;
  delete(key: string): Promise<void>;
}
