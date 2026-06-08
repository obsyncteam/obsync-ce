import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type {
  BlobFileWriteInput,
  BlobReadRange,
  BlobReadStreamResult,
  BlobStore,
} from "./blob-store.js";

export interface S3BlobStoreConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
}

export class S3BlobStore implements BlobStore {
  readonly kind = "s3" as const;
  private readonly client: S3Client;

  constructor(private readonly config: S3BlobStoreConfig) {
    const clientConfig: S3ClientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
    };

    if (config.accessKeyId && config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      };
    }

    this.client = new S3Client(clientConfig);
  }

  async putFile(input: BlobFileWriteInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        Body: createReadStream(input.filePath),
        ContentType: input.contentType,
      }),
    );
  }

  async getStream(
    key: string,
    range?: BlobReadRange,
  ): Promise<BlobReadStreamResult | undefined> {
    const result = await this.getObject(key, range);
    if (!result?.Body) return undefined;

    return {
      body: Readable.from(result.Body as AsyncIterable<Uint8Array>),
      contentType: result.ContentType,
      contentLength: result.ContentLength,
      totalSize: totalSizeFromContentRange(result.ContentRange) ?? result.ContentLength,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );
  }

  private async getObject(key: string, range?: BlobReadRange) {
    try {
      return await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }),
      );
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw error;
    }
  }
}

function totalSizeFromContentRange(contentRange?: string): number | undefined {
  if (!contentRange) return undefined;
  const match = contentRange.match(/\/(\d+)$/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const maybeError = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  return (
    maybeError.name === "NoSuchKey" ||
    maybeError.Code === "NoSuchKey" ||
    maybeError.$metadata?.httpStatusCode === 404
  );
}
