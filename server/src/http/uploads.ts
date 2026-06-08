import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  mkdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import type { BlobStore } from "../storage/blob-store.js";
import { validateVaultPath } from "../sync/path-policy.js";
import type { SyncRepository } from "../sync/repository.js";
import type { UploadChunkRecord, UploadSessionRecord } from "../sync/types.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "./json.js";

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_SIZE = 32 * 1024 * 1024;
const ACTIVE_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const FINALIZED_UPLOAD_TTL_MS = 60 * 60 * 1000;
const MARKDOWN_VERSION_MAX_BYTES = 1_000_000;
const FINALIZE_WAIT_ATTEMPTS = 20;
const FINALIZE_WAIT_DELAY_MS = 250;

const createUploadSchema = z.object({
  vaultId: z.string().min(1),
  deviceId: z.string().min(1),
  fileId: z.string().min(1),
  path: z.string().min(1).transform((path) => (
    validateVaultPath(path, {
      allowObsidianConfig: true,
      allowObsidianPlugins: true,
    })
  )),
  kind: z.enum(["markdown", "blob"]),
  sizeBytes: z.number().int().nonnegative(),
  mtimeMs: z.number().int().nonnegative().optional(),
  contentType: z.string().min(1).optional(),
  expectedHash: z.string().min(1).optional(),
  expectedCurrentHash: z.string().min(1).optional(),
  expectedCurrentSeq: z.number().int().nonnegative().optional(),
  chunkSize: z.number().int().positive().max(MAX_CHUNK_SIZE).optional(),
});

const finalizeUploadSchema = z.object({
  expectedHash: z.string().min(1).optional(),
});

interface UploadRouteDependencies {
  config: ServerConfig;
  repository: SyncRepository;
  blobStore: BlobStore;
}

export async function handleUploadRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: UploadRouteDependencies,
): Promise<boolean> {
  if (request.method === "POST" && url.pathname === "/api/v1/uploads") {
    const body = createUploadSchema.parse(
      await readJsonBody(request, deps.config.maxJsonBodyBytes),
    );
    const session = await createUploadSession(deps, body);
    sendJson(response, 200, await uploadSessionResponse(deps, session));
    return true;
  }

  const statusMatch = url.pathname.match(/^\/api\/v1\/uploads\/([^/]+)$/);
  if (request.method === "GET" && statusMatch) {
    const session = await loadUploadSession(deps.repository, statusMatch[1]);
    sendJson(response, 200, await uploadSessionResponse(deps, session));
    return true;
  }

  const chunkMatch = url.pathname.match(/^\/api\/v1\/uploads\/([^/]+)\/chunks\/(\d+)$/);
  if (request.method === "PUT" && chunkMatch) {
    const uploadId = chunkMatch[1];
    const chunkIndex = Number(chunkMatch[2]);
    const session = await loadUploadSession(deps.repository, uploadId);

    if (session.status !== "uploading") {
      sendJson(response, 409, { ok: false, error: `upload is ${session.status}` });
      return true;
    }

    const meta = await writeChunk(deps, session, chunkIndex, request);
    sendJson(response, 200, { ok: true, chunk: meta });
    return true;
  }

  const finalizeMatch = url.pathname.match(/^\/api\/v1\/uploads\/([^/]+)\/finalize$/);
  if (request.method === "POST" && finalizeMatch) {
    const session = await loadUploadSession(deps.repository, finalizeMatch[1]);

    if (session.status === "finalized") {
      sendJson(response, 200, { ok: true, ...session.finalized });
      return true;
    }
    if (session.status === "finalizing") {
      const finalized = await waitForFinalizedUpload(deps.repository, session.uploadId);
      sendJson(response, 200, { ok: true, ...finalized });
      return true;
    }

    const body = finalizeUploadSchema.parse(
      await readJsonBody(request, deps.config.maxJsonBodyBytes),
    );
    const result = await finalizeUpload(deps, session, body.expectedHash);
    sendJson(response, 200, { ok: true, ...result });
    return true;
  }

  if (request.method === "DELETE" && statusMatch) {
    const session = await loadUploadSession(deps.repository, statusMatch[1])
      .catch((error) => {
        if (isUploadHttpError(error) && error.statusCode === 404) return undefined;
        throw error;
      });
    await deps.repository.cancelQuotaReservation(session?.quotaReservationId);
    await rm(uploadSessionDir(deps.config.dataDir, statusMatch[1]), {
      force: true,
      recursive: true,
    });
    await deps.repository.deleteUploadSession(statusMatch[1]);
    applyCorsHeaders(response);
    response.writeHead(204);
    response.end();
    return true;
  }

  return false;
}

export async function cleanupUploadSessions(
  dataDir: string,
  repository?: SyncRepository,
): Promise<{
  scanned: number;
  deleted: number;
}> {
  if (!repository) return { scanned: 0, deleted: 0 };

  let deleted = 0;
  const now = Date.now();
  const sessions = await repository.staleUploadSessions({
    activeBefore: new Date(now - ACTIVE_UPLOAD_TTL_MS),
    finalizedBefore: new Date(now - FINALIZED_UPLOAD_TTL_MS),
    limit: 500,
  });

  for (const session of sessions) {
    await repository.cancelQuotaReservation(session.quotaReservationId, "expired");
    await rm(uploadSessionDir(dataDir, session.uploadId), {
      force: true,
      recursive: true,
    });
    await repository.deleteUploadSession(session.uploadId);
    deleted += 1;
  }

  return { scanned: sessions.length, deleted };
}

async function createUploadSession(
  deps: UploadRouteDependencies,
  input: z.infer<typeof createUploadSchema>,
): Promise<UploadSessionRecord> {
  const uploadId = randomUUID();
  const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const expiresAt = new Date(Date.now() + ACTIVE_UPLOAD_TTL_MS);

  await deps.repository.ensureVault({ vaultId: input.vaultId });
  await deps.repository.upsertDevice({
    vaultId: input.vaultId,
    deviceId: input.deviceId,
  });

  const reservation = await deps.repository.reserveStorage({
    vaultId: input.vaultId,
    fileId: input.fileId,
    path: input.path,
    sizeBytes: input.sizeBytes,
    source: "sync",
    refId: uploadId,
    idempotencyKey: `upload:${uploadId}`,
    expiresAt,
    quotaBytes: deps.config.storageQuotaBytes,
  });

  try {
    await mkdir(chunksDir(deps.config.dataDir, uploadId), { recursive: true });
    return await deps.repository.createUploadSession({
      uploadId,
      vaultId: input.vaultId,
      deviceId: input.deviceId,
      fileId: input.fileId,
      path: input.path,
      kind: input.kind,
      sizeBytes: input.sizeBytes,
      mtimeMs: input.mtimeMs,
      contentType: input.contentType,
      expectedHash: input.expectedHash,
      expectedCurrentHash: input.expectedCurrentHash,
      expectedCurrentSeq: input.expectedCurrentSeq,
      chunkSize,
      quotaReservationId: reservation.id,
      expiresAt,
    });
  } catch (error) {
    await deps.repository.cancelQuotaReservation(reservation.id);
    await rm(uploadSessionDir(deps.config.dataDir, uploadId), {
      force: true,
      recursive: true,
    });
    throw error;
  }
}

async function uploadSessionResponse(
  deps: UploadRouteDependencies,
  session: UploadSessionRecord,
) {
  return {
    ok: true,
    uploadId: session.uploadId,
    vaultId: session.vaultId,
    path: session.path,
    status: session.status,
    chunkSize: session.chunkSize,
    sizeBytes: session.sizeBytes,
    uploadedChunks: (await deps.repository.uploadChunks(session.uploadId))
      .map((chunk) => chunk.index),
    finalized: session.finalized,
  };
}

async function writeChunk(
  deps: UploadRouteDependencies,
  session: UploadSessionRecord,
  chunkIndex: number,
  request: IncomingMessage,
): Promise<UploadChunkRecord> {
  const expectedChunkCount = Math.ceil(session.sizeBytes / session.chunkSize);
  if (chunkIndex < 0 || chunkIndex >= expectedChunkCount) {
    throw new UploadHttpError(400, "chunk index out of range");
  }

  const expectedSize = expectedChunkSize(session, chunkIndex);
  const contentLength = request.headers["content-length"];
  if (contentLength && Number(contentLength) > expectedSize) {
    throw new UploadHttpError(413, "chunk body too large");
  }

  await mkdir(chunksDir(deps.config.dataDir, session.uploadId), { recursive: true });

  const tempPath = join(
    chunksDir(deps.config.dataDir, session.uploadId),
    `${chunkIndex}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const finalPath = chunkPath(deps.config.dataDir, session.uploadId, chunkIndex);
  const output = createWriteStream(tempPath, { flags: "wx" });
  const trackedError = trackWriteStreamError(output);
  const hash = createHash("sha256");
  let sizeBytes = 0;

  try {
    for await (const chunk of request) {
      throwTrackedStreamError(trackedError);
      const buffer = Buffer.from(chunk);
      sizeBytes += buffer.byteLength;
      if (sizeBytes > expectedSize) {
        throw new UploadHttpError(413, "chunk body too large");
      }
      hash.update(buffer);

      if (!output.write(buffer)) {
        await onceDrainOrError(output);
      }
    }

    throwTrackedStreamError(trackedError);
    await endStream(output);

    if (sizeBytes !== expectedSize) {
      throw new UploadHttpError(400, `invalid chunk size: expected ${expectedSize}`);
    }

    await rename(tempPath, finalPath);
    return await deps.repository.upsertUploadChunk({
      uploadId: session.uploadId,
      index: chunkIndex,
      sizeBytes,
      hash: `sha256:${hash.digest("hex")}`,
    });
  } catch (error) {
    output.destroy();
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function finalizeUpload(
  deps: UploadRouteDependencies,
  session: UploadSessionRecord,
  expectedHash?: string,
) {
  let operationCommitted = false;
  await deps.repository.markUploadSessionFinalizing(session.uploadId);

  try {
    let assembled: Awaited<ReturnType<typeof assembleUpload>>;
    try {
      assembled = await assembleUpload(deps, session);
    } catch (error) {
      if (isMissingTempUploadFileError(error)) {
        return await waitForFinalizedUpload(deps.repository, session.uploadId);
      }
      throw error;
    }
    const hash = assembled.hash;
    const requiredHash = expectedHash ?? session.expectedHash;

    if (requiredHash && requiredHash !== hash) {
      await assembled.cleanup();
      throw new UploadHttpError(409, "upload checksum mismatch");
    }

    const storageKey = blobStorageKey(session.vaultId, hash);
    const markdown = session.kind === "markdown" && session.sizeBytes <= MARKDOWN_VERSION_MAX_BYTES
      ? await readFile(assembled.filePath, "utf8")
      : undefined;
    try {
      await deps.blobStore.putFile({
        key: storageKey,
        filePath: assembled.filePath,
        contentType: session.contentType,
      });
    } finally {
      await assembled.cleanup();
    }

    await deps.repository.ensureVault({ vaultId: session.vaultId });
    await deps.repository.upsertDevice({
      vaultId: session.vaultId,
      deviceId: session.deviceId,
    });
    await deps.repository.upsertBlobRef({
      vaultId: session.vaultId,
      hash,
      sizeBytes: session.sizeBytes,
      storageKey,
      storageKind: deps.blobStore.kind,
      contentType: session.contentType,
    });

    const operation = await deps.repository.appendOperation({
      vaultId: session.vaultId,
      opId: `${session.deviceId}:chunk-upload:${session.uploadId}`,
      deviceId: session.deviceId,
      operationType: "file_upsert",
      fileId: session.fileId,
      path: session.path,
      payload: {
        kind: session.kind,
        hash,
        sizeBytes: session.sizeBytes,
        mtimeMs: session.mtimeMs,
        contentType: session.contentType,
        ...(markdown !== undefined ? { content: markdown } : {}),
        expectedHash: session.expectedCurrentHash,
        expectedSeq: session.expectedCurrentSeq,
      },
    });
    operationCommitted = true;

    await deps.repository.updateFileStorage({
      vaultId: session.vaultId,
      fileId: session.fileId,
      path: session.path,
      kind: session.kind,
      hash,
      sizeBytes: session.sizeBytes,
      mtimeMs: session.mtimeMs,
      storageKey,
      storageKind: deps.blobStore.kind,
      contentType: session.contentType,
      updatedSeq: operation.serverSeq,
    });
    await deps.repository.finalizeQuotaReservation(
      session.quotaReservationId,
      operation.opId,
    );

    const file = {
      vaultId: session.vaultId,
      fileId: session.fileId,
      path: session.path,
      kind: session.kind,
      hash,
      sizeBytes: session.sizeBytes,
      mtimeMs: session.mtimeMs,
    };
    const finalized = { file, operation };
    await deps.repository.finalizeUploadSession(session.uploadId, finalized);
    await rm(chunksDir(deps.config.dataDir, session.uploadId), {
      force: true,
      recursive: true,
    });

    return finalized;
  } catch (error) {
    if (!operationCommitted) {
      await deps.repository.markUploadSessionUploading(session.uploadId).catch((resetError) => {
        console.error("[obsync] failed to restore upload session state", resetError);
      });
    }
    throw error;
  }
}

async function assembleUpload(
  deps: UploadRouteDependencies,
  session: UploadSessionRecord,
) {
  const metas = await deps.repository.uploadChunks(session.uploadId);
  const expectedChunkCount = Math.ceil(session.sizeBytes / session.chunkSize);

  if (metas.length !== expectedChunkCount) {
    throw new UploadHttpError(409, "upload is missing chunks");
  }

  for (let index = 0; index < expectedChunkCount; index += 1) {
    const meta = metas.find((chunk) => chunk.index === index);
    if (!meta) throw new UploadHttpError(409, `missing chunk ${index}`);
    const expectedSize = expectedChunkSize(session, index);
    if (meta.sizeBytes !== expectedSize) {
      throw new UploadHttpError(409, `invalid stored chunk size ${index}`);
    }
  }

  const sessionDir = uploadSessionDir(deps.config.dataDir, session.uploadId);
  await mkdir(sessionDir, { recursive: true });
  const filePath = join(sessionDir, "assembled.tmp");
  const output = createWriteStream(filePath, { flags: "w" });
  const trackedError = trackWriteStreamError(output);
  const hash = createHash("sha256");
  let sizeBytes = 0;

  try {
    for (let index = 0; index < expectedChunkCount; index += 1) {
      const meta = metas[index];
      const chunkHash = createHash("sha256");
      let chunkSize = 0;

      for await (const chunk of createReadStream(chunkPath(deps.config.dataDir, session.uploadId, index))) {
        throwTrackedStreamError(trackedError);
        const buffer = Buffer.from(chunk);
        chunkSize += buffer.byteLength;
        sizeBytes += buffer.byteLength;
        chunkHash.update(buffer);
        hash.update(buffer);

        if (!output.write(buffer)) {
          await onceDrainOrError(output);
        }
      }

      throwTrackedStreamError(trackedError);
      if (chunkSize !== meta.sizeBytes) {
        throw new UploadHttpError(409, `chunk ${index} size mismatch`);
      }

      const actualChunkHash = `sha256:${chunkHash.digest("hex")}`;
      if (actualChunkHash !== meta.hash) {
        throw new UploadHttpError(409, `chunk ${index} checksum mismatch`);
      }
    }

    throwTrackedStreamError(trackedError);
    await endStream(output);
  } catch (error) {
    output.destroy();
    await rm(filePath, { force: true });
    throw error;
  }

  if (sizeBytes !== session.sizeBytes) {
    await rm(filePath, { force: true });
    throw new UploadHttpError(409, "assembled upload size mismatch");
  }

  return {
    filePath,
    hash: `sha256:${hash.digest("hex")}`,
    cleanup: () => rm(filePath, { force: true }),
  };
}

async function loadUploadSession(
  repository: SyncRepository,
  uploadId: string,
): Promise<UploadSessionRecord> {
  assertSafeUploadId(uploadId);
  const session = await repository.uploadSession(uploadId);
  if (!session) throw new UploadHttpError(404, "upload session not found");
  return session;
}

async function waitForFinalizedUpload(
  repository: SyncRepository,
  uploadId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < FINALIZE_WAIT_ATTEMPTS; attempt += 1) {
    const latest = await loadUploadSession(repository, uploadId);
    if (latest.status === "finalized" && latest.finalized) {
      return latest.finalized;
    }
    if (latest.status === "uploading") {
      throw new UploadHttpError(409, "upload temporary files are missing; restart upload");
    }
    if (latest.status !== "finalizing") {
      throw new UploadHttpError(409, `upload is ${latest.status}`);
    }
    await sleep(FINALIZE_WAIT_DELAY_MS);
  }
  throw new UploadHttpError(425, "upload is finalizing; retry");
}

function expectedChunkSize(session: UploadSessionRecord, chunkIndex: number): number {
  const start = chunkIndex * session.chunkSize;
  const remaining = session.sizeBytes - start;
  return Math.min(session.chunkSize, remaining);
}

function uploadSessionDir(dataDir: string, uploadId: string): string {
  assertSafeUploadId(uploadId);
  return join(dataDir, "uploads", uploadId);
}

function chunksDir(dataDir: string, uploadId: string): string {
  return join(uploadSessionDir(dataDir, uploadId), "chunks");
}

function chunkPath(dataDir: string, uploadId: string, chunkIndex: number): string {
  return join(chunksDir(dataDir, uploadId), `${chunkIndex}.part`);
}

function assertSafeUploadId(uploadId: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(uploadId)) {
    throw new UploadHttpError(400, "invalid upload id");
  }
}

function blobStorageKey(vaultId: string, hash: string): string {
  const safeVaultId = vaultId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const hashHex = hash.replace(/^sha256:/, "");
  return `vaults/${safeVaultId}/blobs/${hashHex.slice(0, 2)}/${hashHex}`;
}

function onceDrainOrError(output: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      output.removeListener("drain", onDrain);
      output.removeListener("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    output.once("drain", onDrain);
    output.once("error", onError);
  });
}

function endStream(output: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      output.removeListener("finish", onFinish);
      output.removeListener("error", onError);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    output.once("finish", onFinish);
    output.once("error", onError);
    output.end();
  });
}

function trackWriteStreamError(output: NodeJS.WritableStream): () => Error | undefined {
  let tracked: Error | undefined;
  output.on("error", (error) => {
    tracked = error instanceof Error ? error : new Error(String(error));
  });
  return () => tracked;
}

function throwTrackedStreamError(error: () => Error | undefined): void {
  const tracked = error();
  if (tracked) throw tracked;
}

function isMissingTempUploadFileError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class UploadHttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export function isUploadHttpError(error: unknown): error is UploadHttpError {
  return error instanceof UploadHttpError;
}
